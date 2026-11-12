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
