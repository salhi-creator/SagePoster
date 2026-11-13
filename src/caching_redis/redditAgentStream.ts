import { Redis } from "ioredis";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import type { PendingRedditDraftInput } from "../SQL_DB/connectDB.js";
import { enqueueRedditActionExecution } from "../queues/redditActionQueue.js";

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

export type RedditActionName =
  | "publish_post"
  | "create_comment"
  | "reply_to_comment"
  | "remove_post"
  | "remove_comment"
  | "crosspost";

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

/** Return the most recently appended stream records for the strategy planner. */
export async function getRecentRedditStreamEvents(limit = 50): Promise<{
  id: string;
  fields: Record<string, string>;
}[]> {
  const count = Math.max(1, Math.min(50, Math.floor(limit)));
  const rows = await redis.xrevrange(streamName, "+", "-", "COUNT", count) as unknown;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): { id: string; fields: Record<string, string> }[] => {
    if (!Array.isArray(row) || typeof row[0] !== "string" || !Array.isArray(row[1])) return [];
    const fields: Record<string, string> = {};
    for (let index = 0; index + 1 < row[1].length; index += 2) {
      if (typeof row[1][index] === "string" && typeof row[1][index + 1] === "string") {
        fields[row[1][index] as string] = row[1][index + 1] as string;
      }
    }
    return [{ id: row[0], fields }];
  }).reverse();
}

/** Queue an explicit approved action for the non-AI Reddit executor. */
export async function enqueueApprovedRedditAction(input: {
  action: RedditActionName;
  details: Record<string, unknown>;
  actionId?: string;
}): Promise<{ actionId: string; streamId: string }> {
  const actionId = input.actionId?.trim() || randomUUID();
  const streamId = await redis.xadd(
    streamName,
    "*",
    "event",
    "reddit_action",
    "status",
    "approved",
    "action",
    input.action,
    "actionId",
    actionId,
    "createdAt",
    new Date().toISOString(),
    "details",
    JSON.stringify(input.details),
  );
  if (!streamId) throw new Error("Redis did not return an ID for the approved Reddit action");
  try {
    await enqueueRedditActionExecution(streamId);
  } catch (error) {
    console.error("[Reddit agent stream] Action remains queued in the stream; immediate BullMQ enqueue failed", {
      streamId,
      actionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { actionId, streamId };
}

export async function enqueueAndWaitRedditAction(input: {
  action: RedditActionName;
  details: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{ status: "published" | "removed"; result: Record<string, unknown> }> {
  const { actionId } = await enqueueApprovedRedditAction(input);
  const resultKey = `sageposter:reddit:action-result:${actionId}`;
  const timeoutMs = Math.max(5_000, input.timeoutMs ?? 120_000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const raw = await redis.get(resultKey);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Reddit action ${actionId} returned an invalid result`);
      }
      const value = parsed as Record<string, unknown>;
      if (value.status === "cancelled") {
        throw new Error(`Reddit action ${actionId} was cancelled by management mode`);
      }
      if (value.status !== "published" && value.status !== "removed") {
        throw new Error(`Reddit action ${actionId} returned an unsupported status`);
      }
      const result = value.result;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error(`Reddit action ${actionId} returned no result data`);
      }
      return { status: value.status, result: result as Record<string, unknown> };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for Reddit action ${actionId}`);
}

/** Replace an executed action with its final stream status. */
export async function replaceRedditActionWithResult(input: {
  originalStreamId: string;
  actionId: string;
  action: RedditActionName;
  status: "published" | "removed" | "cancelled";
  details: Record<string, unknown>;
  result: Record<string, unknown>;
}): Promise<string> {
  const transaction = redis.multi();
  transaction.xadd(
    streamName,
    "*",
    "event",
    "reddit_action",
    "status",
    input.status,
    "action",
    input.action,
    "actionId",
    input.actionId,
    "createdAt",
    new Date().toISOString(),
    "details",
    JSON.stringify(input.details),
    "result",
    JSON.stringify(input.result),
  );
  transaction.xdel(streamName, input.originalStreamId);
  transaction.set(
    `sageposter:reddit:action-result:${input.actionId}`,
    JSON.stringify({ status: input.status, result: input.result }),
    "EX",
    86_400,
  );
  const rows = await transaction.exec();
  if (!rows) throw new Error("Redis did not finalize the Reddit action event");
  for (const [error] of rows) {
    if (error) throw error;
  }
  const resultStreamId = rows[0]?.[1];
  if (typeof resultStreamId !== "string") {
    throw new Error("Redis did not return the finalized Reddit action event ID");
  }
  return resultStreamId;
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

/** Replace a pending post event with the community analyzer's decision. */
export async function replacePendingRedditPostWithReview(input: {
  originalStreamId: string;
  createdAt: string;
  approvedIds: string[];
  rejectedIds: string[];
  subreddit: string;
  rejectionReasons: Record<string, string>;
  details: Record<string, unknown>;
}): Promise<{ approvedStreamIds: string[]; rejectedStreamIds: string[] }> {
  if (!input.approvedIds.length && !input.rejectedIds.length) {
    throw new Error("Post review must contain at least one approved or rejected ID");
  }
  const transaction = redis.multi();
  for (const [status, ids] of [
    ["approved", input.approvedIds],
    ["rejected", input.rejectedIds],
  ] as const) {
    for (const id of ids) {
      transaction.xadd(
        streamName,
        "*",
        "event",
        "events-post",
        "status",
        status,
        "type",
        "post",
        "createdAt",
        input.createdAt,
        "ids",
        JSON.stringify([id]),
        "details",
        JSON.stringify(input.details),
      );
    }
  }
  for (const postId of input.rejectedIds) {
    transaction.xadd(
      streamName,
      "*",
      "event",
      "reddit_action",
      "status",
      "approved",
      "action",
      "remove_post",
      "actionId",
      randomUUID(),
      "createdAt",
      input.createdAt,
      "details",
      JSON.stringify({
        postId,
        subreddit: input.subreddit,
        reason: input.rejectionReasons[postId] ?? "Rejected by subreddit community rules.",
      }),
    );
  }
  transaction.xdel(streamName, input.originalStreamId);
  const results = await transaction.exec();
  if (!results) throw new Error("Redis did not replace the pending Reddit post event");
  for (const [error] of results) {
    if (error) throw error;
  }
  const postEventCount = input.approvedIds.length + input.rejectedIds.length;
  const streamIds = results.slice(0, postEventCount).map((result) => result?.[1]);
  if (streamIds.some((streamId) => typeof streamId !== "string")) {
    throw new Error("Redis did not return all reviewed Reddit post event IDs");
  }
  const approvedCount = input.approvedIds.length;
  for (let index = 0; index < input.rejectedIds.length; index += 1) {
    const actionStreamId = results[postEventCount + index]?.[1];
    if (typeof actionStreamId !== "string") continue;
    try {
      await enqueueRedditActionExecution(actionStreamId);
    } catch (error) {
      console.error("[Reddit agent stream] Could not enqueue post removal job; action remains in stream", {
        actionStreamId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    approvedStreamIds: streamIds.slice(0, approvedCount) as string[],
    rejectedStreamIds: streamIds.slice(approvedCount) as string[],
  };
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
    if (process.env.REDDIT_COMMENT_DELETE_ENABLED === "true") {
      for (const commentId of input.rejectedIds) {
        transaction.xadd(
          streamName,
          "*",
          "event",
          "reddit_action",
          "status",
          "approved",
          "action",
          "remove_comment",
          "actionId",
          randomUUID(),
          "createdAt",
          input.createdAt,
          "details",
          JSON.stringify({
            commentId,
            subreddit: input.subreddit,
            postId: input.postId,
            reason: input.reasons[commentId] ?? "Rejected by subreddit community rules.",
          }),
        );
      }
    } else if (input.rejectedIds.length) {
      console.warn("[Reddit agent stream] Rejected comments were recorded; automatic removal is disabled because REDDIT_COMMENT_DELETE_ENABLED is not true", {
        rejectedCount: input.rejectedIds.length,
      });
    }
  }
  transaction.xdel(streamName, input.originalStreamId);
  const results = await transaction.exec();
  if (!results) throw new Error("Redis did not execute the event replacement transaction");

  let index = 0;
  const approvedResult = input.approvedIds.length ? results[index++] : undefined;
  const rejectedResult = input.rejectedIds.length ? results[index++] : undefined;
  for (const [error] of results) {
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
  if (input.rejectedIds.length && process.env.REDDIT_COMMENT_DELETE_ENABLED === "true") {
    const firstActionResultIndex = Number(Boolean(input.approvedIds.length)) + 1;
    for (let actionIndex = 0; actionIndex < input.rejectedIds.length; actionIndex += 1) {
      const actionStreamId = results[firstActionResultIndex + actionIndex]?.[1];
      if (typeof actionStreamId !== "string") continue;
      try {
        await enqueueRedditActionExecution(actionStreamId);
      } catch (error) {
        console.error("[Reddit agent stream] Could not enqueue comment removal job; action remains in stream", {
          actionStreamId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return {
    ...(typeof approvedStreamId === "string" ? { approvedStreamId } : {}),
    ...(typeof rejectedStreamId === "string" ? { rejectedStreamId } : {}),
  };
}
