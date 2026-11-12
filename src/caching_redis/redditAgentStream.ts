import { Redis } from "ioredis";
import dotenv from "dotenv";
import type { PendingRedditDraftInput } from "../SQL_DB/connectDB.js";

dotenv.config();

const redis = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
});

const streamName =
  process.env.REDDIT_AGENT_STREAM || "sageposter:reddit:agent-events";

export type RedditActivityType = "post" | "comment";

export type ApprovedRedditCrosspostInput = {
  sourcePostId: string;
  sourceSubreddit: string;
  targetSubreddit: string;
  title: string;
  content: string;
  url: string;
  topic: string;
};

function managementModeKey(subreddit: string): string {
  const name = subreddit.trim().replace(/^r\//i, "").toLowerCase();
  return `sageposter:reddit:management-mode:${name}`;
}

export async function setRedditManagementMode(
  subreddit: string,
  mode: "shadow" | "assistant" | "owner",
): Promise<void> {
  if (!subreddit.trim()) throw new Error("Subreddit is required to set Reddit management mode");
  await redis.set(managementModeKey(subreddit), mode);
}

export async function getRedditManagementMode(
  subreddit: string,
): Promise<"shadow" | "assistant" | "owner" | null> {
  if (!subreddit.trim()) return null;
  const mode = await redis.get(managementModeKey(subreddit));
  return mode === "shadow" || mode === "assistant" || mode === "owner" ? mode : null;
}

redis.on("error", (error) => {
  console.error("[Reddit agent stream] Redis error", {
    name: error.name,
    message: error.message,
    code: (error as NodeJS.ErrnoException).code,
  });
});

export async function enqueuePendingRedditDraft(
  draft: PendingRedditDraftInput,
  createdAt: string,
): Promise<string> {
  const streamId = await redis.xadd(
    streamName,
    "*",
    "event",
    "reddit_content_draft",
    "draftId",
    draft.draftId,
    "status",
    "pending",
    "subreddit",
    draft.subreddit,
    "topic",
    draft.topic,
    "title",
    draft.title,
    "content",
    draft.content,
    "createdAt",
    createdAt,
  );
  if (!streamId) {
    throw new Error("Redis did not return an ID for the pending Reddit draft");
  }
  return streamId;
}

export async function enqueueRedditActivityEvent(input: {
  type: RedditActivityType;
  status: "pending";
  createdAt: string;
  ids: string[];
  details: Record<string, unknown>;
}): Promise<string> {
  const streamId = await redis.xadd(
    streamName,
    "*",
    "event",
    `events-${input.type}`,
    "status",
    input.status,
    "type",
    input.type,
    "createdAt",
    input.createdAt,
    "ids",
    JSON.stringify(input.ids),
    "details",
    JSON.stringify(input.details),
  );
  if (!streamId) {
    throw new Error("Redis did not return an ID for the Reddit activity event");
  }
  return streamId;
}

/** Add one approved, already-published Reddit post/target pair for crossposting. */
export async function enqueueApprovedRedditCrosspost(
  input: ApprovedRedditCrosspostInput,
): Promise<string> {
  const streamId = await redis.xadd(
    streamName,
    "*",
    "event",
    "reddit_crosspost_candidate",
    "status",
    "approved",
    "type",
    "post",
    "createdAt",
    new Date().toISOString(),
    "ids",
    JSON.stringify([input.sourcePostId]),
    "details",
    JSON.stringify({
      sourcePostId: input.sourcePostId,
      sourceSubreddit: input.sourceSubreddit,
      targetSubreddit: input.targetSubreddit,
      title: input.title,
      content: input.content,
      url: input.url,
      topic: input.topic,
    }),
  );
  if (!streamId) throw new Error("Redis did not return an ID for the approved crosspost candidate");
  return streamId;
}

export async function replacePendingRedditActivityWithClassifiedComments(input: {
  originalStreamId: string;
  createdAt: string;
  subreddit: string;
  postId: string;
  approvedIds: string[];
  rejectedIds: string[];
  reasons: Record<string, string>;
}): Promise<{ approvedStreamId?: string; rejectedStreamId?: string }> {
  if (!input.approvedIds.length && !input.rejectedIds.length) {
    throw new Error("Classification must contain approved or rejected comment IDs");
  }

  const transaction = redis.multi();
  if (input.approvedIds.length) {
    transaction.xadd(
      streamName,
      "*",
      "event",
      "events-comment",
      "status",
      "approved",
      "type",
      "comment",
      "createdAt",
      input.createdAt,
      "ids",
      JSON.stringify(input.approvedIds),
      "details",
      JSON.stringify({ subreddit: input.subreddit, postId: input.postId }),
    );
  }
  if (input.rejectedIds.length) {
    transaction.xadd(
      streamName,
      "*",
      "event",
      "events-comment",
      "status",
      "rejected",
      "type",
      "comment",
      "createdAt",
      input.createdAt,
      "ids",
      JSON.stringify(input.rejectedIds),
      "details",
      JSON.stringify({
        subreddit: input.subreddit,
        postId: input.postId,
        reasons: input.reasons,
      }),
    );
  }
  transaction.xdel(streamName, input.originalStreamId);
  const results = await transaction.exec();
  if (!results) throw new Error("Redis did not execute the event replacement transaction");

  let index = 0;
  const approvedResult = input.approvedIds.length ? results[index++] : undefined;
  const rejectedResult = input.rejectedIds.length ? results[index++] : undefined;
  const deleteResult = results[index];
  for (const [error] of [approvedResult, rejectedResult, deleteResult].filter(
    (result): result is NonNullable<typeof result> => result !== undefined,
  )) {
    if (error) throw error;
  }
  const approvedStreamId = approvedResult?.[1];
  const rejectedStreamId = rejectedResult?.[1];
  if (input.approvedIds.length && typeof approvedStreamId !== "string") {
    throw new Error("Redis failed to append approved comments");
  }
  if (input.rejectedIds.length && typeof rejectedStreamId !== "string") {
    throw new Error("Redis failed to append rejected comments");
  }
  return {
    ...(typeof approvedStreamId === "string" ? { approvedStreamId } : {}),
    ...(typeof rejectedStreamId === "string" ? { rejectedStreamId } : {}),
  };
}
