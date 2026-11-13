import os from "node:os";
import { Redis } from "ioredis";
import { AIanswer } from "../AI.js";
import {
  checkRedditCrosspost,
} from "../Platform-ReplyHandle/sendToReddit.js";
import {
  hasRedditCrosspost,
  reserveRedditCrosspost,
} from "../SQL_DB/connectDB.js";
import { logError } from "../utilis/logError.js";
import { enqueueApprovedRedditAction } from "../caching_redis/redditAgentStream.js";
import { scanScheduledRedditPosts } from "../queues/redditCrosspostWorker.js";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};
const streamName = process.env.REDDIT_AGENT_STREAM || "sageposter:reddit:agent-events";
const groupName = process.env.REDDIT_CROSSPOST_HANDLER_GROUP || "sageposter-crosspost-handler";
const consumerName = `${os.hostname()}-${process.pid}`;
const redis = new Redis(connection);

type StreamMessage = { id: string; fields: Record<string, string> };
type Candidate = {
  sourcePostId: string;
  sourceSubreddit: string;
  targetSubreddit: string;
  title: string;
  content: string;
  url: string;
  topic: string;
};

redis.on("error", (error) => {
  logError("Crosspost handler Redis error", error, { streamName, groupName });
});

function decodeMessages(result: unknown): StreamMessage[] {
  if (!Array.isArray(result)) return [];
  const messages: StreamMessage[] = [];
  for (const stream of result) {
    if (!Array.isArray(stream) || !Array.isArray(stream[1])) continue;
    for (const raw of stream[1]) {
      if (!Array.isArray(raw) || typeof raw[0] !== "string" || !Array.isArray(raw[1])) continue;
      const fields: Record<string, string> = {};
      for (let i = 0; i + 1 < raw[1].length; i += 2) {
        if (typeof raw[1][i] === "string" && typeof raw[1][i + 1] === "string") {
          fields[raw[1][i]] = raw[1][i + 1];
        }
      }
      messages.push({ id: raw[0], fields });
    }
  }
  return messages;
}

function parseCandidate(fields: Record<string, string>): Candidate | null {
  if (
    fields.event !== "reddit_crosspost_candidate" ||
    fields.status !== "approved" ||
    fields.type !== "post"
  ) return null;
  try {
    const details: unknown = JSON.parse(fields.details ?? "{}");
    if (!details || typeof details !== "object" || Array.isArray(details)) return null;
    const value = details as Record<string, unknown>;
    const sourcePostId = typeof value.sourcePostId === "string" ? value.sourcePostId.trim() : "";
    const sourceSubreddit = typeof value.sourceSubreddit === "string" ? value.sourceSubreddit.trim() : "";
    const targetSubreddit = typeof value.targetSubreddit === "string" ? value.targetSubreddit.trim() : "";
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const content = typeof value.content === "string" ? value.content.trim() : "";
    const url = typeof value.url === "string" ? value.url.trim() : "";
    const topic = typeof value.topic === "string" ? value.topic.trim() : "";
    if (!sourcePostId || !sourceSubreddit || !targetSubreddit || !title || !topic) return null;
    return { sourcePostId, sourceSubreddit, targetSubreddit, title, content, url, topic };
  } catch {
    return null;
  }
}

async function crosspostApprovedPost(candidate: Candidate, streamId: string): Promise<void> {
  if (candidate.sourceSubreddit.toLowerCase() === candidate.targetSubreddit.toLowerCase()) {
    console.info("[Crosspost handler] Skipping same-subreddit target", { streamId });
    return;
  }
  if (await hasRedditCrosspost(candidate.sourcePostId, candidate.targetSubreddit)) return;

  const request = {
    sourcePostId: candidate.sourcePostId,
    targetSubreddit: candidate.targetSubreddit,
    title: null,
  };
  const checked = await checkRedditCrosspost(request);
  if (!checked.canCrosspost) {
    console.info("[Crosspost handler] Target does not allow crossposting", {
      streamId,
      sourcePostId: candidate.sourcePostId,
      targetSubreddit: checked.targetSubreddit,
    });
    return;
  }

  const review = await AIanswer(
    JSON.stringify({
      sourcePost: checked.sourcePost,
      targetSubreddit: checked.targetSubreddit,
      rules: checked.rules,
    }),
    "reddit-crosspost-review",
  ) as { safeToCrosspost?: unknown; reason?: unknown } | null;
  if (review?.safeToCrosspost !== true) {
    console.info("[Crosspost handler] Rule review rejected the candidate", {
      streamId,
      sourcePostId: candidate.sourcePostId,
      targetSubreddit: checked.targetSubreddit,
      reason: typeof review?.reason === "string" ? review.reason : "No review result",
    });
    return;
  }

  const reserved = await reserveRedditCrosspost({
    sourcePostId: candidate.sourcePostId,
    targetSubreddit: checked.targetSubreddit,
  });
  if (!reserved) return;
  const action = await enqueueApprovedRedditAction({
    action: "crosspost",
    details: {
      sourcePostId: candidate.sourcePostId,
      targetSubreddit: checked.targetSubreddit,
      title: request.title ?? checked.sourcePost.title,
      content: checked.sourcePost.body?.trim() || checked.sourcePost.title,
      topic: candidate.topic,
    },
  });
  console.info("[Crosspost handler] Approved crosspost action queued", {
    streamId,
    actionId: action.actionId,
    sourcePostId: candidate.sourcePostId,
    targetSubreddit: checked.targetSubreddit,
  });
}

async function acknowledge(streamId: string): Promise<void> {
  await redis.xack(streamName, groupName, streamId);
}

async function handleMessage(message: StreamMessage): Promise<void> {
  const candidate = parseCandidate(message.fields);
  if (!candidate) {
    // This stream is shared with other agents; acknowledge entries owned by them.
    if (message.fields.event !== "reddit_crosspost_candidate") {
      await acknowledge(message.id);
      return;
    }
    console.warn("[Crosspost handler] Invalid candidate acknowledged", { streamId: message.id });
    await acknowledge(message.id);
    return;
  }
  await crosspostApprovedPost(candidate, message.id);
  await acknowledge(message.id);
}

export async function runRedditCrosspostHandlerBatch(limit = 20): Promise<number> {
  await scanScheduledRedditPosts();
  try {
    await redis.xgroup("CREATE", streamName, groupName, "0", "MKSTREAM");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) throw error;
  }
  const count = Math.max(1, Math.min(20, Math.floor(limit)));
  let processed = 0;
  while (true) {
    const claimed = await redis.call(
      "XAUTOCLAIM", streamName, groupName, consumerName, "60000", "0-0", "COUNT", count,
    ) as unknown;
    const claimedMessages = Array.isArray(claimed)
      ? decodeMessages([[streamName, claimed[1]]])
      : [];
    const fresh = await redis.xreadgroup(
      "GROUP", groupName, consumerName, "COUNT", count,
      "STREAMS", streamName, ">",
    );
    const batch = [...claimedMessages, ...decodeMessages(fresh)];
    if (!batch.length) break;

    let batchProcessed = 0;
    for (const message of batch) {
      try {
        await handleMessage(message);
        processed += 1;
        batchProcessed += 1;
      } catch (error) {
        logError("Crosspost candidate left pending for retry", error, {
          streamId: message.id,
          event: message.fields.event,
        });
      }
    }
    // Failed entries stay pending; avoid reclaiming them repeatedly in this run.
    if (batchProcessed === 0) break;
  }
  console.info("[Crosspost handler] Batch completed", { groupName, processed });
  return processed;
}
