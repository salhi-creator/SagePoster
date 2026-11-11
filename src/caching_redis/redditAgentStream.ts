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
