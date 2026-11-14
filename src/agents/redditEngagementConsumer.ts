import os from "node:os";
import { Redis } from "ioredis";
import { AIanswer } from "../AI.js";
import {
  getRedditPostComments,
  getRedditPostById,
  type RedditCommunityComment,
  type RedditCommunityPost,
} from "../Platform-ReplyHandle/sendToReddit.js";
import {
  claimRedditEngagementComment,
  finishRedditEngagementComment,
  hasRedditEngagementComment,
  releaseRedditEngagementCommentClaim,
} from "../SQL_DB/connectDB.js";
import { logError } from "../utilis/logError.js";
import {
  getRedditManagementMode,
  enqueueRedditActivityEvent,
  enqueueApprovedRedditAction,
  replacePendingRedditPostWithReview,
  replacePendingRedditActivityWithClassifiedComments,
} from "../caching_redis/redditAgentStream.js";
import {
  analyzeRedditCommentsAgainstRules,
  reviewRedditPostEventAgainstCommunity,
} from "./redditCommunityAnalyzer.js";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};
const streamName = process.env.REDDIT_AGENT_STREAM || "sageposter:reddit:agent-events";
const engagementGroupName = process.env.REDDIT_ENGAGEMENT_STREAM_GROUP || "sageposter-reddit-engagement";
const communityAnalyzerGroupName =
  process.env.REDDIT_COMMUNITY_ANALYZER_STREAM_GROUP || "sageposter-reddit-community-analyzer";
const consumerName = `${os.hostname()}-${process.pid}`;
const redis = new Redis(connection);

type StreamMessage = { id: string; fields: Record<string, string> };
type EngagementEvent = {
  type: "post" | "comment";
  status: "pending" | "approved";
  createdAt: string;
  ids: string[];
  postId?: string;
  details: Record<string, unknown>;
};
type PostContext = {
  post: RedditCommunityPost | Record<string, unknown>;
  subreddit: string;
  comments: RedditCommunityComment[];
};

redis.on("error", (error) => {
  logError("Reddit engagement Redis error", error, {
    streamName,
    engagementGroupName,
    communityAnalyzerGroupName,
  });
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
  if (
    (fields.status !== "pending" && fields.status !== "approved") ||
    (fields.type !== "post" && fields.type !== "comment") ||
    fields.event !== `events-${fields.type}`
  ) return null;
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
    status: fields.status,
    createdAt: fields.createdAt ?? "",
    ids,
    ...(text(fields.postId) ?? text((details as Record<string, unknown>).postId)
      ? { postId: text(fields.postId) ?? text((details as Record<string, unknown>).postId) }
      : {}),
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
  return shuffled.slice(0, Math.min(items.length, 5 + Math.floor(Math.random() * 8)));
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
    : event.postId ?? text(details.postId) ?? text(commentDetails.postId) ?? "";
  if (!rawPostId) return null;
  const postId = asFullname(rawPostId, "post");
  if (!subreddit) throw new Error(`Reddit event is missing the subreddit for post ${postId}`);

  // Resolve the exact post by ID, then pair it with comments fetched for that
  // post. Do not guess context from a limited recent-post feed.
  const post = await getRedditPostById(postId, subreddit);
  const comments = await getRedditPostComments(postId, 100);
  return { post, subreddit: post.subreddit || subreddit, comments };
}

type GeneratedRedditReply = {
  commentId: string;
  shouldReply: boolean;
  body: string;
  reason: string;
};

async function createReplies(
  post: RedditCommunityPost | Record<string, unknown>,
  targetComments: RedditCommunityComment[],
  nearbyComments: RedditCommunityComment[],
): Promise<Map<string, GeneratedRedditReply>> {
  const result = await AIanswer(
    JSON.stringify({ parentPost: post, targetComments, nearbyComments }),
    "reddit-engagement-reply",
  );
  if (!result || typeof result !== "object") throw new Error("Engagement AI returned no reply batch");
  const response = result as Record<string, unknown>;
  if (!Array.isArray(response.replies)) {
    throw new Error("Engagement AI returned no replies array");
  }

  const targetIds = new Set(targetComments.map((comment) => comment.commentId));
  const replies = new Map<string, GeneratedRedditReply>();
  for (const value of response.replies) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Engagement AI returned a malformed reply item");
    }
    const item = value as Record<string, unknown>;
    const commentId = typeof item.commentId === "string" ? item.commentId.trim() : "";
    if (
      !targetIds.has(commentId) || replies.has(commentId) ||
      typeof item.shouldReply !== "boolean" || typeof item.body !== "string"
    ) {
      throw new Error("Engagement AI returned an invalid or duplicate comment reply");
    }
    replies.set(commentId, {
      commentId,
      shouldReply: item.shouldReply,
      body: item.body.trim(),
      reason: typeof item.reason === "string" ? item.reason : "",
    });
  }
  if (replies.size !== targetIds.size) {
    throw new Error("Engagement AI did not return a decision for every target comment");
  }
  return replies;
}

async function processActivity(
  event: EngagementEvent,
  streamId: string,
  stage: "community_analyzer" | "engagement",
): Promise<void> {
  const owner = process.env.REDDIT_OWNER_USERNAME?.trim();
  if (!owner) throw new Error("REDDIT_OWNER_USERNAME must be configured to exclude owner-authored activity");
  if (stage === "community_analyzer" && event.status !== "pending") return;
  if (stage === "engagement" && event.status !== "approved") return;

  // A comment event groups IDs from one parent post. Reuse one exact post and
  // comment lookup for all those comments instead of fetching it per comment.
  const contextCache = new Map<string, Promise<PostContext | null>>();
  const loadContext = (sourceId: string): Promise<PostContext | null> => {
    const parentId = event.type === "post"
      ? asFullname(sourceId, "post")
      : asFullname(event.postId ?? text(event.details.postId) ?? sourceId, "post");
    let context = contextCache.get(parentId);
    if (!context) {
      context = getPostContext(event, sourceId);
      contextCache.set(parentId, context);
    }
    return context;
  };

  // A pending post event must pass the post-level community analyzer before
  // the engagement stage is allowed to inspect its comments.
  if (event.type === "post" && event.status === "pending") {
    const approvedIds: string[] = [];
    const rejectedIds: string[] = [];
    const rejectionReasons: Record<string, string> = {};
    let resolvedSubreddit = "";
    for (const sourceId of event.ids) {
      const context = await loadContext(sourceId);
      if (!context) throw new Error(`Could not load post context for ${sourceId}`);
      resolvedSubreddit = context.subreddit;
      if (await getRedditManagementMode(context.subreddit) !== "owner") {
        console.info("[Reddit community analyzer] Post event ignored outside owner mode", {
          streamId,
          subreddit: context.subreddit,
          sourceId,
        });
        continue;
      }

      const postRecord = context.post as Record<string, unknown>;
      const postAuthor = text(postRecord.author) ??
        text(nested(event.details, "post").author) ?? text(event.details.author);
      if (isOwner(postAuthor ?? null, owner)) {
        console.info("[Reddit community analyzer] Skipping owner-authored post", { sourceId });
        continue;
      }

      const title = text(postRecord.title) ?? "";
      const content = text(postRecord.content) ?? text(postRecord.body) ?? "";
      const review = await reviewRedditPostEventAgainstCommunity({
        subreddit: context.subreddit,
        postId: sourceId,
        title,
        content,
      });
      if (review.approved) approvedIds.push(sourceId);
      else {
        rejectedIds.push(sourceId);
        rejectionReasons[sourceId] = review.reason;
      }
    }

    if (approvedIds.length || rejectedIds.length) {
      const replacements = await replacePendingRedditPostWithReview({
        originalStreamId: streamId,
        createdAt: new Date().toISOString(),
        approvedIds,
        rejectedIds,
        subreddit: resolvedSubreddit,
        rejectionReasons,
        details: event.details,
      });
      console.info("[Reddit community analyzer] Replaced pending post event with review results", {
        streamId,
        approvedCount: approvedIds.length,
        rejectedCount: rejectedIds.length,
        approvedStreamIds: replacements.approvedStreamIds,
      });
    } else {
      await redis.xdel(streamName, streamId);
    }
    return;
  }

  let repliesQueued = 0;
  for (const sourceId of event.ids) {
    const context = await loadContext(sourceId);
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

    const externalComments = context.comments.filter(
      (comment) => !comment.removed && comment.author && !isOwner(comment.author, owner),
    );
    const unseenComments = await Promise.all(
      externalComments.map(async (comment) =>
        (await hasRedditEngagementComment(comment.commentId)) ? null : comment,
      ),
    );
    const candidates = unseenComments.filter(
      (comment): comment is RedditCommunityComment => comment !== null,
    );
    const eventIds = new Set(event.ids.map((id) => asFullname(id, "comment")));
    const selected = event.type === "comment" && event.status === "approved"
      ? candidates.filter((comment) => eventIds.has(asFullname(comment.commentId, "comment")))
      : randomSample(candidates);
    console.info("[Reddit engagement] Selected comment candidates", {
      streamId,
      subreddit: context.subreddit,
      candidates: candidates.length,
      selected: selected.length,
    });

    const postRecord = context.post as Record<string, unknown>;
    const sourcePostId = text(postRecord.postId) ?? text(postRecord.id) ??
      (event.type === "post" ? sourceId : text(event.details.postId) ?? "");
    if (!sourcePostId) throw new Error("Event context is missing the source post ID for rule screening");

    if (stage === "engagement" && event.type === "post" && event.status === "approved") {
      if (selected.length) {
        await enqueueRedditActivityEvent({
          type: "comment",
          status: "pending",
          createdAt: new Date().toISOString(),
          ids: selected.map((comment) => comment.commentId),
          postId: sourcePostId,
          details: { subreddit: context.subreddit, postId: sourcePostId },
        });
      }
      await redis.xdel(streamName, streamId);
      continue;
    }

    const needsCommentScreening = stage === "community_analyzer" && event.status === "pending";
    if (!selected.length) {
      if (needsCommentScreening) await redis.xdel(streamName, streamId);
      continue;
    }

    const approvedComments = selected;
    if (needsCommentScreening) {
      const screening = await analyzeRedditCommentsAgainstRules({
        subreddit: context.subreddit,
        sourcePostId,
        post: {
          title: text(postRecord.title) ?? "",
          content: text(postRecord.content) ?? text(postRecord.body) ?? "",
        },
        comments: selected.map(({ commentId, body, author }) => ({ commentId, body, author })),
      });
      await replacePendingRedditActivityWithClassifiedComments({
        originalStreamId: streamId,
        createdAt: new Date().toISOString(),
        subreddit: context.subreddit,
        postId: sourcePostId,
        approvedIds: screening.approvedIds,
        rejectedIds: screening.rejectedIds,
        reasons: screening.reasons,
      });
      for (const commentId of screening.rejectedIds) {
        if (await claimRedditEngagementComment(commentId, context.subreddit)) {
          await finishRedditEngagementComment({
            commentId,
            status: "rejected",
            reason: screening.reasons[commentId],
          });
        }
      }
      console.info("[Reddit engagement] Replaced pending event with classification events", {
        streamId,
        approvedCount: screening.approvedIds.length,
        rejectedCount: screening.rejectedIds.length,
      });
      return;
    }

    console.info("[Reddit engagement] Processing rule-approved comments", {
      approvedCount: approvedComments.length,
      subreddit: context.subreddit,
    });

    const claimedComments: RedditCommunityComment[] = [];
    for (const comment of approvedComments) {
      if (await claimRedditEngagementComment(comment.commentId, context.subreddit)) {
        claimedComments.push(comment);
      }
    }
    if (!claimedComments.length) continue;

    let repliesByComment: Map<string, GeneratedRedditReply>;
    const targetCommentIds = new Set(claimedComments.map((comment) => comment.commentId));
    try {
      repliesByComment = await createReplies(
        context.post,
        claimedComments,
        context.comments.filter((comment) => !targetCommentIds.has(comment.commentId)).slice(-12),
      );
    } catch (error) {
      await Promise.all(claimedComments.map(async (comment) => {
        await releaseRedditEngagementCommentClaim(comment.commentId).catch((releaseError) => {
          logError("Could not release Reddit engagement claim after batch AI failure", releaseError, {
            commentId: comment.commentId,
          });
        });
      }));
      logError("Reddit engagement reply batch failed", error, { streamId, subreddit: context.subreddit });
      throw error;
    }

    for (let index = 0; index < claimedComments.length; index += 1) {
      const comment = claimedComments[index]!;
      const reply = repliesByComment.get(comment.commentId)!;
      try {
        if (!reply.shouldReply || !reply.body) {
          await finishRedditEngagementComment({
            commentId: comment.commentId,
            status: "skipped",
            reason: reply.reason,
          });
          continue;
        }
        const queued = await enqueueApprovedRedditAction({
          action: "reply_to_comment",
          details: {
            commentId: comment.commentId,
            sourceCommentId: comment.commentId,
            body: reply.body,
            subreddit: context.subreddit,
            sourcePostId,
          },
        });
        repliesQueued += 1;
        console.info("[Reddit engagement] Approved reply queued for executor", {
          commentId: comment.commentId,
          actionId: queued.actionId,
          subreddit: context.subreddit,
        });
      } catch (error) {
        await Promise.all(claimedComments.slice(index).map(async (pendingComment) => {
          await releaseRedditEngagementCommentClaim(pendingComment.commentId).catch((releaseError) => {
            logError("Could not release Reddit engagement claim after reply enqueue failure", releaseError, {
              commentId: pendingComment.commentId,
            });
          });
        }));
        logError("Reddit engagement reply failed", error, { commentId: comment.commentId, streamId });
        throw error;
      }
    }
    if (event.type === "comment" && event.status === "approved") {
      await redis.xdel(streamName, streamId);
    }
  }
  console.info("[Reddit engagement] Event processed", { streamId, repliesQueued });
}

async function ensureConsumerGroup(groupName: string): Promise<void> {
  try {
    await redis.xgroup("CREATE", streamName, groupName, "0", "MKSTREAM");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) throw error;
  }
}

async function handleMessage(
  message: StreamMessage,
  stage: "community_analyzer" | "engagement",
  groupName: string,
): Promise<void> {
  const event = parseEvent(message.fields);
  const expectedStatus = stage === "community_analyzer" ? "pending" : "approved";
  if (!event || event.status !== expectedStatus) {
    await redis.xack(streamName, groupName, message.id);
    if (!event) console.info("[Reddit agent] Unrelated stream entry acknowledged", {
      streamId: message.id,
      event: message.fields.event,
    });
    return;
  }
  await processActivity(event, message.id, stage);
  await redis.xack(streamName, groupName, message.id);
}

export async function runRedditActivityAgentBatch(
  stage: "community_analyzer" | "engagement",
  limit = 20,
): Promise<number> {
  const groupName = stage === "community_analyzer"
    ? communityAnalyzerGroupName
    : engagementGroupName;
  await ensureConsumerGroup(groupName);
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
        await handleMessage(message, stage, groupName);
        processed += 1;
        batchProcessed += 1;
      } catch (error) {
        logError("Reddit activity event left pending for retry", error, {
          streamId: message.id,
          event: message.fields.event,
          stage,
        });
      }
    }
    // Entries that failed remain pending; don't spin on them in this run.
    if (batchProcessed === 0) break;
  }
  console.info("[Reddit agent] Batch completed", { stage, groupName, processed });
  return processed;
}
