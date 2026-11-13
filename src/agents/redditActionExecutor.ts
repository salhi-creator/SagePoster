import os from "node:os";
import { Job, Worker } from "bullmq";
import { Redis } from "ioredis";
import {
  createRedditComment,
  deleteRedditComment,
  deleteRedditPost,
  publishRedditCrosspost,
  replyToRedditComment,
  sendToReddit,
} from "../Platform-ReplyHandle/sendToReddit.js";
import {
  completeRedditPostPublication,
  completeRedditCrosspost,
  finishRedditEngagementComment,
  markRedditDraftCancelled,
  markRedditDraftPending,
  markRedditDraftPublished,
  releaseRedditCrosspostReservation,
  reserveRedditPostPublication,
  savePublishedRedditPost,
} from "../SQL_DB/connectDB.js";
import { logError } from "../utilis/logError.js";
import {
  replaceRedditActionWithResult,
  getRedditManagementMode,
  type RedditActionName,
} from "../caching_redis/redditAgentStream.js";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};
const streamName = process.env.REDDIT_AGENT_STREAM || "sageposter:reddit:agent-events";
const groupName = process.env.REDDIT_ACTION_EXECUTOR_GROUP || "sageposter-reddit-action-executor";
const consumerName = `${os.hostname()}-${process.pid}`;
const redis = new Redis(connection);

type StreamMessage = { id: string; fields: Record<string, string> };
type ApprovedAction = {
  actionId: string;
  action: RedditActionName;
  details: Record<string, unknown>;
};

redis.on("error", (error) => {
  logError("Reddit action executor Redis error", error, { streamName, groupName });
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(details: Record<string, unknown>, key: string): string {
  const value = details[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Reddit action is missing '${key}'`);
  }
  return value.trim();
}

function optionalText(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseAction(fields: Record<string, string>): ApprovedAction | null {
  // Older versions stored reviewed content drafts directly in the stream.
  // Keep those entries executable during rollout as well.
  if (fields.event === "reddit_content_draft" && fields.status === "pending") {
    const draftId = fields.draftId?.trim();
    const subreddit = fields.subreddit?.trim();
    const title = fields.title?.trim();
    const content = fields.content?.trim();
    if (!draftId || !subreddit || !title || !content) return null;
    return {
      actionId: `reddit-draft-${draftId}`,
      action: "publish_post",
      details: {
        draftId,
        requireOwnerMode: true,
        deliveryType: "scheduled",
        subreddit,
        topic: fields.topic ?? "",
        title,
        content,
      },
    };
  }
  if (fields.event !== "reddit_action" || fields.status !== "approved") return null;
  const actions: RedditActionName[] = [
    "publish_post",
    "create_comment",
    "reply_to_comment",
    "remove_post",
    "remove_comment",
    "crosspost",
  ];
  if (!actions.includes(fields.action as RedditActionName) || !fields.actionId) return null;
  try {
    const details = record(JSON.parse(fields.details ?? "{}"));
    if (!details) return null;
    return {
      actionId: fields.actionId,
      action: fields.action as RedditActionName,
      details,
    };
  } catch {
    return null;
  }
}

async function executeAction(action: ApprovedAction): Promise<{
  status: "published" | "removed" | "cancelled";
  result: Record<string, unknown>;
}> {
  const details = action.details;
  switch (action.action) {
    case "publish_post": {
      const draftId = optionalText(details, "draftId");
      const subreddit = requiredText(details, "subreddit");
      if (details.requireOwnerMode === true && await getRedditManagementMode(subreddit) !== "owner") {
        if (draftId) await markRedditDraftCancelled(draftId);
        return {
          status: "cancelled",
          result: { draftId, subreddit, reason: "Management mode is no longer owner" },
        };
      }
      const post = {
        subreddit,
        title: requiredText(details, "title"),
        content: requiredText(details, "content"),
        ...(Array.isArray(details.media) ? { media: details.media as { type: "image" | "video" | null; url: string | null }[] } : {}),
      };
      const reservationId = draftId ?? action.actionId;
      const slot = await reserveRedditPostPublication(reservationId, subreddit);
      if (slot.status === "daily_limit") {
        if (draftId) await markRedditDraftPending(draftId);
        return {
          status: "cancelled",
          result: { draftId, subreddit, reason: "Two Reddit posts have already been published or reserved in this subreddit in the last 24 hours" },
        };
      }
      const published = slot.status === "published"
        ? { postId: slot.postId, url: slot.url }
        : await sendToReddit({
            ...post,
            idempotencyKey: `sageposter-post-${reservationId}`,
          });
      if (slot.status === "reserved") {
        await completeRedditPostPublication({
          actionId: reservationId,
          subreddit,
          postId: published.postId,
          url: published.url,
        });
      }
      const topic = optionalText(details, "topic");
      if (topic) {
        try {
          await savePublishedRedditPost(topic, {
            ...post,
            redditPostId: published.postId,
            url: published.url,
          }, {
            deliveryType: details.deliveryType === "scheduled" ? "scheduled" : "one-time",
            ...(optionalText(details, "postId") ? { postId: optionalText(details, "postId") } : {}),
          });
        } catch (error) {
          logError("Reddit post published but history save failed", error, {
            actionId: action.actionId,
            postId: published.postId,
          });
        }
      }
      if (draftId) {
        try {
          await markRedditDraftPublished(draftId, published.postId);
        } catch (error) {
          logError("Reddit draft published but its database status update failed", error, {
            actionId: action.actionId,
            draftId,
            postId: published.postId,
          });
        }
      }
      return { status: "published", result: published };
    }
    case "create_comment": {
      const published = await createRedditComment({
        postId: requiredText(details, "postId"),
        body: requiredText(details, "body"),
      });
      return { status: "published", result: published };
    }
    case "reply_to_comment": {
      const commentId = requiredText(details, "commentId");
      const published = await replyToRedditComment({
        commentId,
        body: requiredText(details, "body"),
        idempotencyKey: `${action.actionId}:${commentId}`,
      });
      const sourceCommentId = optionalText(details, "sourceCommentId");
      if (sourceCommentId) {
        await finishRedditEngagementComment({
          commentId: sourceCommentId,
          status: "replied",
          replyId: published.commentId,
          replyBody: published.body,
        });
      }
      return { status: "published", result: published };
    }
    case "remove_post": {
      const postId = requiredText(details, "postId");
      const subreddit = requiredText(details, "subreddit");
      if (await getRedditManagementMode(subreddit) !== "owner") {
        return { status: "cancelled", result: { postId, reason: "Management mode is no longer owner" } };
      }
      await deleteRedditPost(postId);
      return { status: "removed", result: { postId } };
    }
    case "remove_comment": {
      const commentId = requiredText(details, "commentId");
      const subreddit = requiredText(details, "subreddit");
      if (await getRedditManagementMode(subreddit) !== "owner") {
        return { status: "cancelled", result: { commentId, reason: "Management mode is no longer owner" } };
      }
      await deleteRedditComment(commentId);
      return { status: "removed", result: { commentId } };
    }
    case "crosspost": {
      const sourcePostId = requiredText(details, "sourcePostId");
      const targetSubreddit = requiredText(details, "targetSubreddit");
      const slot = await reserveRedditPostPublication(action.actionId, targetSubreddit);
      if (slot.status === "daily_limit") {
        await releaseRedditCrosspostReservation({ sourcePostId, targetSubreddit });
        return {
          status: "cancelled",
          result: { sourcePostId, targetSubreddit, reason: "Two Reddit posts have already been published or reserved in this subreddit in the last 24 hours" },
        };
      }
      const published = slot.status === "published"
        ? {
            crosspostId: slot.postId,
            targetSubreddit,
            url: slot.url,
            permalink: slot.url,
          }
        : await publishRedditCrosspost({
            sourcePostId,
            targetSubreddit,
            title: optionalText(details, "title") ?? null,
            idempotencyKey: `sageposter-crosspost-${action.actionId}`,
          });
      if (slot.status === "reserved") {
        await completeRedditPostPublication({
          actionId: action.actionId,
          subreddit: published.targetSubreddit,
          postId: published.crosspostId,
          url: published.url,
        });
      }
      const completed = await completeRedditCrosspost({
        sourcePostId,
        targetSubreddit: published.targetSubreddit,
        crosspostId: published.crosspostId,
        url: published.url,
      });
      if (!completed) throw new Error("Crosspost succeeded but database history could not be completed");
      const topic = optionalText(details, "topic");
      const title = optionalText(details, "title");
      const content = optionalText(details, "content");
      if (topic && title && content) {
        try {
          await savePublishedRedditPost(topic, {
            subreddit: published.targetSubreddit,
            title,
            content,
            redditPostId: published.crosspostId,
            url: published.url,
          });
        } catch (error) {
          logError("Crosspost published but Reddit history save failed", error, {
            actionId: action.actionId,
            crosspostId: published.crosspostId,
          });
        }
      }
      return { status: "published", result: published };
    }
  }
  throw new Error(`Unsupported Reddit action: ${String(action.action)}`);
}

async function executeStreamMessage(message: StreamMessage, acknowledgeGroup?: string): Promise<void> {
  const action = parseAction(message.fields);
  if (!action) {
    if (acknowledgeGroup) await redis.xack(streamName, acknowledgeGroup, message.id);
    return;
  }
  const resultKey = `sageposter:reddit:action-result:${action.actionId}`;
  if (await redis.exists(resultKey)) {
    if (acknowledgeGroup) await redis.xack(streamName, acknowledgeGroup, message.id);
    return;
  }
  const executionKey = optionalText(action.details, "draftId") ?? action.actionId;
  const lockKey = `sageposter:reddit:action-lock:${executionKey}`;
  const locked = await redis.set(lockKey, consumerName, "NX", "EX", 1_800);
  if (locked !== "OK") throw new Error(`Reddit action ${action.actionId} is already being executed`);
  try {
    const outcome = await executeAction(action);
    const resultStreamId = await replaceRedditActionWithResult({
      originalStreamId: message.id,
      actionId: action.actionId,
      action: action.action,
      status: outcome.status,
      details: action.details,
      result: outcome.result,
    });
    if (acknowledgeGroup) await redis.xack(streamName, acknowledgeGroup, message.id);
    console.info("[Reddit action executor] Action completed", {
      actionId: action.actionId,
      action: action.action,
      status: outcome.status,
      streamId: resultStreamId,
    });
  } finally {
    await redis.del(lockKey);
  }
}

async function ensureActionGroup(): Promise<void> {
  try {
    await redis.xgroup("CREATE", streamName, groupName, "0", "MKSTREAM");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) throw error;
  }
}

export async function runRedditActionExecutorBatch(limit = 20): Promise<number> {
  await ensureActionGroup();
  const count = Math.max(1, Math.min(20, Math.floor(limit)));
  let processed = 0;
  while (true) {
    const claimed = await redis.call(
      "XAUTOCLAIM", streamName, groupName, consumerName, "120000", "0-0", "COUNT", count,
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
        await executeStreamMessage(message, groupName);
        processed += 1;
        batchProcessed += 1;
      } catch (error) {
        logError("Reddit action left pending for retry", error, {
          streamId: message.id,
          action: message.fields.action,
          actionId: message.fields.actionId,
        });
      }
    }
    // Failed actions remain pending for a later scheduled retry.
    if (batchProcessed === 0) break;
  }
  return processed;
}

const actionWorker = new Worker<{ streamId: string }>(
  "reddit-action-executor",
  async (job: Job<{ streamId: string }>) => {
    const rows = await redis.xrange(streamName, job.data.streamId, job.data.streamId);
    const messages = decodeMessages([[streamName, rows]]);
    if (!messages.length) return;
    await executeStreamMessage(messages[0]!);
  },
  { connection, concurrency: 1, lockDuration: 180_000 },
);

actionWorker.on("completed", (job) => {
  console.info("[Reddit action executor] BullMQ action job completed", { jobId: job.id });
});
actionWorker.on("failed", (job, error) => {
  logError("Reddit action BullMQ job failed", error, {
    jobId: job?.id,
    streamId: job?.data.streamId,
  });
});
actionWorker.on("error", (error) => {
  logError("Reddit action executor queue error", error, { streamName, groupName });
});
