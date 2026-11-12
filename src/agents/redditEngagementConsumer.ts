import os from "node:os";
import { Redis } from "ioredis";
import { AIanswer } from "../AI.js";
import {
  getRedditPostComments,
  getRedditSubredditPosts,
  replyToRedditComment,
  type RedditCommunityComment,
  type RedditCommunityPost,
} from "../Platform-ReplyHandle/sendToReddit.js";
import {
  claimRedditEngagementComment,
  finishRedditEngagementComment,
} from "../SQL_DB/connectDB.js";
import { logError } from "../utilis/logError.js";
import { getRedditManagementMode } from "../caching_redis/redditAgentStream.js";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};
const streamName = process.env.REDDIT_AGENT_STREAM || "sageposter:reddit:agent-events";
const groupName = process.env.REDDIT_ENGAGEMENT_STREAM_GROUP || "sageposter-reddit-engagement";
const consumerName = `${os.hostname()}-${process.pid}`;
const redis = new Redis(connection);

type StreamMessage = { id: string; fields: Record<string, string> };
type EngagementEvent = {
  type: "post" | "comment";
  createdAt: string;
  ids: string[];
  details: Record<string, unknown>;
};
type PostContext = {
  post: RedditCommunityPost | Record<string, unknown>;
  subreddit: string;
  comments: RedditCommunityComment[];
};

redis.on("error", (error) => {
  logError("Reddit engagement Redis error", error, { streamName, groupName });
});

function decodeMessages(result: unknown): StreamMessage[] {
  if (!Array.isArray(result)) return [];
  const messages: StreamMessage[] = [];
  for (const stream of result) {
    if (!Array.isArray(stream) || !Array.isArray(stream[1])) continue;
    for (const raw of stream[1]) {
      if (!Array.isArray(raw) || typeof raw[0] !== "string" || !Array.isArray(raw[1])) continue;
      const fields: Record<string, string> = {};
      for (let index = 0; index + 1 < raw[1].length; index += 2) {
        if (typeof raw[1][index] === "string" && typeof raw[1][index + 1] === "string") {
          fields[raw[1][index]] = raw[1][index + 1];
        }
      }
      messages.push({ id: raw[0], fields });
    }
  }
  return messages;
}

function parseEvent(fields: Record<string, string>): EngagementEvent | null {
  if (fields.status !== "pending" || (fields.type !== "post" && fields.type !== "comment")) return null;
  let ids: unknown;
  let details: unknown;
  try {
    ids = JSON.parse(fields.ids ?? "[]");
    details = JSON.parse(fields.details ?? "{}");
  } catch {
    return null;
  }
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => typeof id !== "string") ||
    !details || typeof details !== "object" || Array.isArray(details)
  ) return null;
  return {
    type: fields.type,
    createdAt: fields.createdAt ?? "",
    ids,
    details: details as Record<string, unknown>,
  };
}

function asFullname(value: string, kind: "post" | "comment"): string {
  const prefix = kind === "post" ? "t3_" : "t1_";
  return value.startsWith(prefix) ? value : `${prefix}${value.replace(/^t[13]_/, "")}`;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nested(details: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = details[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^u\//i, "").replace(/^@/, "").toLowerCase();
}

function isOwner(author: string | null | undefined, owner: string): boolean {
  return Boolean(author && normalizeUsername(author) === normalizeUsername(owner));
}

function randomSample<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return shuffled.slice(0, Math.min(items.length, 3 + Math.floor(Math.random() * 6)));
}

async function getPostContext(event: EngagementEvent, id: string): Promise<PostContext | null> {
  const details = event.details;
  const postDetails = nested(details, "post");
  const commentDetails = nested(details, "comment");
  const configuredSubreddit = (process.env.REDDIT_OWNED_SUBREDDITS ?? "SageFrontier")
    .split(",")[0]?.trim().replace(/^r\//i, "");
  const subreddit = text(details.subreddit) ?? text(postDetails.subreddit) ??
    (event.type === "post" ? configuredSubreddit : undefined);
  const rawPostId = event.type === "post"
    ? id
    : text(details.postId) ?? text(commentDetails.postId) ?? "";
  if (!rawPostId) return null;
  const postId = asFullname(rawPostId, "post");

  let post: RedditCommunityPost | Record<string, unknown> | undefined;
  if (event.type === "post") {
    if (!subreddit) return null;
    const posts = await getRedditSubredditPosts(subreddit, 30);
    post = posts.find((candidate) => asFullname(candidate.postId, "post") === postId);
    if (!post && (text(postDetails.title) || text(details.title))) {
      post = {
        postId,
        subreddit,
        title: text(postDetails.title) ?? text(details.title) ?? "",
        content: text(postDetails.body) ?? text(details.body) ?? "",
        author: text(postDetails.author) ?? text(details.author) ?? null,
      };
    }
  } else {
    post = {
      postId,
      subreddit: subreddit ?? "",
      title: text(postDetails.title) ?? text(details.title) ?? "",
      content: text(postDetails.body) ?? text(details.body) ?? "",
      author: text(postDetails.author) ?? null,
    };
  }
  if (!post) return null;

  const comments = await getRedditPostComments(postId, 100);
  const resolvedSubreddit = subreddit ?? ("subreddit" in post && typeof post.subreddit === "string" ? post.subreddit : "");
  return { post, subreddit: resolvedSubreddit, comments };
}

async function createReply(
  post: RedditCommunityPost | Record<string, unknown>,
  targetComment: RedditCommunityComment,
  nearbyComments: RedditCommunityComment[],
): Promise<{ shouldReply: boolean; body: string; reason: string }> {
  const result = await AIanswer(
    JSON.stringify({ post, targetComment, nearbyComments }),
    "reddit-engagement-reply",
  );
  if (!result || typeof result !== "object") throw new Error("Engagement AI returned no reply object");
  const response = result as Record<string, unknown>;
  if (typeof response.shouldReply !== "boolean" || typeof response.body !== "string") {
    throw new Error("Engagement AI returned an invalid reply object");
  }
  return {
    shouldReply: response.shouldReply,
    body: response.body.trim(),
    reason: typeof response.reason === "string" ? response.reason : "",
  };
}

async function processActivity(event: EngagementEvent, streamId: string): Promise<void> {
  const owner = process.env.REDDIT_OWNER_USERNAME?.trim();
  if (!owner) throw new Error("REDDIT_OWNER_USERNAME must be configured to exclude owner-authored activity");

  let repliesPublished = 0;
  for (const sourceId of event.ids) {
    const context = await getPostContext(event, sourceId);
    if (!context) {
      console.warn("[Reddit engagement] Event lacks required post/subreddit context", {
        type: event.type,
        streamId,
        sourceId,
      });
      continue;
    }
    if (await getRedditManagementMode(context.subreddit) !== "owner") {
      console.info("[Reddit engagement] Community is not in owner mode; event ignored", {
        streamId,
        subreddit: context.subreddit,
      });
      continue;
    }

    const eventDetails = nested(event.details, event.type);
    const author = text(eventDetails.author) ?? text(event.details.author);
    const postAuthor = "author" in context.post && typeof context.post.author === "string"
      ? context.post.author
      : author;
    if (event.type === "post" && isOwner(postAuthor, owner)) {
      console.info("[Reddit engagement] Ignoring owner-authored post", { sourceId });
      continue;
    }

    const candidates = context.comments.filter(
      (comment) => !comment.removed && comment.author && !isOwner(comment.author, owner),
    );
    const selected = randomSample(candidates);
    console.info("[Reddit engagement] Selected comment candidates", {
      streamId,
      subreddit: context.subreddit,
      candidates: candidates.length,
      selected: selected.length,
    });

    for (const comment of selected) {
      if (!(await claimRedditEngagementComment(comment.commentId, context.subreddit))) continue;
      try {
        const reply = await createReply(context.post, comment, context.comments.slice(-12));
        if (!reply.shouldReply || !reply.body) {
          await finishRedditEngagementComment({ commentId: comment.commentId, status: "skipped" });
          continue;
        }
        const published = await replyToRedditComment({ commentId: comment.commentId, body: reply.body });
        await finishRedditEngagementComment({
          commentId: comment.commentId,
          status: "replied",
          replyId: published.commentId,
          replyBody: published.body,
        });
        repliesPublished += 1;
        console.info("[Reddit engagement] Reply published", {
          commentId: comment.commentId,
          replyId: published.commentId,
          subreddit: context.subreddit,
        });
      } catch (error) {
        logError("Reddit engagement reply failed", error, { commentId: comment.commentId, streamId });
        throw error;
      }
    }
  }
  console.info("[Reddit engagement] Event processed", { streamId, repliesPublished });
}

async function ack(streamId: string): Promise<void> {
  await redis.xack(streamName, groupName, streamId);
}

async function handleMessage(message: StreamMessage): Promise<void> {
  const event = parseEvent(message.fields);
  if (!event) {
    console.warn("[Reddit engagement] Unsupported stream entry acknowledged", {
      streamId: message.id,
      event: message.fields.event,
    });
    await ack(message.id);
    return;
  }
  await processActivity(event, message.id);
  await ack(message.id);
}

async function consume(): Promise<void> {
  try {
    await redis.xgroup("CREATE", streamName, groupName, "0", "MKSTREAM");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) throw error;
  }
  console.info("[Reddit engagement] Stream consumer ready", { streamName, groupName, consumerName });

  while (true) {
    try {
      const claimed = await redis.call(
        "XAUTOCLAIM", streamName, groupName, consumerName, "60000", "0-0", "COUNT", "5",
      ) as unknown;
      const claimedMessages = Array.isArray(claimed)
        ? decodeMessages([[streamName, claimed[1]]])
        : [];
      const fresh = await redis.xreadgroup(
        "GROUP", groupName, consumerName, "COUNT", 5, "BLOCK", 5000,
        "STREAMS", streamName, ">",
      );
      for (const message of [...claimedMessages, ...decodeMessages(fresh)]) {
        try {
          await handleMessage(message);
        } catch (error) {
          logError("Reddit engagement event left pending for retry", error, {
            streamId: message.id,
            event: message.fields.event,
          });
        }
      }
    } catch (error) {
      logError("Reddit engagement stream read failed", error, { streamName, groupName });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

void consume().catch((error) => {
  logError("Reddit engagement consumer stopped", error, { streamName, groupName });
});
