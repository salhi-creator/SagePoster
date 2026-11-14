import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  enqueueRedditActivityEvent,
  type RedditActivityType,
} from "../caching_redis/redditAgentStream.js";
import { logError } from "./logError.js";

type RedditEventRequest = {
  type: RedditActivityType;
  createdAt: string;
  ids: string[];
  status: "pending";
  postId?: string;
  details: Record<string, unknown>;
};

function parseRedditEvent(body: unknown): RedditEventRequest | null {
  if (!body || typeof body !== "object") return null;
  const event = body as Record<string, unknown>;
  if (event.type !== "post" && event.type !== "comment") return null;
  if (event.status !== undefined && event.status !== "pending") return null;

  let createdAt: Date;
  if (typeof event.createdAt === "string") {
    createdAt = new Date(event.createdAt);
  } else if (typeof event.createdAt === "number" && Number.isFinite(event.createdAt)) {
    const timestamp = event.createdAt < 1_000_000_000_000
      ? event.createdAt * 1_000
      : event.createdAt;
    createdAt = new Date(timestamp);
  } else {
    return null;
  }
  if (!Number.isFinite(createdAt.getTime())) return null;

  const ids = typeof event.ids === "string" ? [event.ids] : event.ids;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== "string" || id.trim().length === 0)
  ) {
    return null;
  }
  if (
    event.details !== undefined &&
    (!event.details || typeof event.details !== "object" || Array.isArray(event.details))
  ) {
    return null;
  }

  const details = (event.details as Record<string, unknown> | undefined) ?? {};
  const nestedPost = details.post && typeof details.post === "object" && !Array.isArray(details.post)
    ? details.post as Record<string, unknown>
    : {};
  const requestedPostId = typeof event.postId === "string"
    ? event.postId.trim()
    : typeof details.postId === "string"
      ? details.postId.trim()
      : "";
  const postId = event.type === "comment"
    ? requestedPostId
    : requestedPostId || (ids.length === 1 ? (ids[0] as string).trim() : "");
  if (event.type === "comment" && !postId) return null;
  if (event.type === "comment" &&
      typeof details.subreddit !== "string" && typeof nestedPost.subreddit !== "string") {
    return null;
  }

  return {
    type: event.type,
    status: "pending",
    createdAt: createdAt.toISOString(),
    ids: ids.map((id) => id.trim()),
    ...(postId ? { postId } : {}),
    details: {
      ...details,
      ...(postId ? { postId } : {}),
      ...(typeof details.subreddit === "string" || typeof nestedPost.subreddit !== "string"
        ? {}
        : { subreddit: nestedPost.subreddit }),
    },
  };
}

export async function receiveRedditEvents(
  req: Request,
  res: Response,
): Promise<void> {
const expectedToken = process.env.REDDIT_SERVICE_TOKEN?.trim();
  const authorization = req.header("authorization") ?? "";
  const suppliedToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!expectedToken) {
    res.status(503).json({ ok: false, error: "Reddit event authentication is not configured." });
    return;
  }
  const expectedBuffer = Buffer.from(expectedToken);
  const suppliedBuffer = Buffer.from(suppliedToken);
  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    res.status(401).json({ ok: false, error: "Unauthorized." });
    return;
  }

  const event = parseRedditEvent(req.body);
  if (!event) {
    res.status(400).json({
      ok: false,
      error: "Expected type 'post' or 'comment', status 'pending' if supplied, a valid createdAt, 1 to 100 IDs, and object details. Comment events must include postId and subreddit (or details.post.subreddit).",
    });
    return;
  }

  try {
    const streamId = await enqueueRedditActivityEvent(event);
    console.info("[Reddit events] Added activity to Redis Stream", {
      event: `events-${event.type}`,
      idCount: event.ids.length,
      streamId,
    });
    res.status(202).json({ ok: true, streamId });
  } catch (error) {
    logError("Reddit event enqueue failed", error, {
      type: event.type,
      idCount: event.ids.length,
    });
    res.status(503).json({ ok: false, error: "Redis could not accept the event." });
  }
}
