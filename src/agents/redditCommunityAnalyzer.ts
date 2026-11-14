import { AIanswer } from "../AI.js";
import {
  getRedditAgentContext,
  type RedditCommunityPost,
} from "../Platform-ReplyHandle/sendToReddit.js";
import { chunkRedditComments } from "./redditAiLimits.js";

export type RedditCommunityContext = {
  subreddit: string;
  rules: { name: string; description: string; appliesTo: string }[];
  recentCommunityPosts: RedditCommunityPost[];
  isOwnedCommunity: boolean;
};

export type RedditDraftReview = {
  approved: boolean;
  reason: string;
  ruleFeedback: string[];
};

export type RedditCommentRuleAnalysis = {
  approvedIds: string[];
  rejectedIds: string[];
  reasons: Record<string, string>;
};

function normalizeSubreddit(value: string): string {
  return value.trim().replace(/^r\//i, "").toLowerCase();
}

export function isOwnedRedditCommunity(subreddit: string): boolean {
  const configured = (process.env.REDDIT_OWNED_SUBREDDITS ?? "SageFrontier")
    .split(",")
    .map(normalizeSubreddit)
    .filter(Boolean);
  return configured.includes(normalizeSubreddit(subreddit));
}

/** Load authoritative subreddit rules and owner-only recent post context. */
export async function loadRedditCommunityContext(
  subredditInput: string,
): Promise<RedditCommunityContext> {
  const subreddit = subredditInput.trim().replace(/^r\//i, "");
  if (!subreddit) throw new Error("A subreddit is required for community analysis");

  const isOwnedCommunity = isOwnedRedditCommunity(subreddit);
  const context = await getRedditAgentContext({
    subreddit,
    include: { rules: true, recentPostsLimit: isOwnedCommunity ? 12 : 0 },
  });
  if (!Array.isArray(context.rules)) throw new Error("Reddit service omitted requested subreddit rules");
  const recentCommunityPosts = context.posts ?? [];
  return {
    subreddit: context.subreddit,
    rules: context.rules,
    recentCommunityPosts,
    isOwnedCommunity,
  };
}

function parseDraftReview(value: unknown): RedditDraftReview {
  if (!value || typeof value !== "object") {
    throw new Error("Reddit community analyzer returned no review object");
  }
  const review = value as Record<string, unknown>;
  if (typeof review.approved !== "boolean" || typeof review.reason !== "string") {
    throw new Error("Reddit community analyzer returned an invalid review");
  }
  const ruleFeedback = Array.isArray(review.ruleFeedback)
    ? review.ruleFeedback.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : [];
  if (!review.approved && ruleFeedback.length === 0) {
    ruleFeedback.push(review.reason.trim() || "Revise the draft to comply with the supplied subreddit rules.");
  }
  return {
    approved: review.approved,
    reason: review.reason.trim(),
    ruleFeedback,
  };
}

export async function reviewRedditDraftAgainstCommunity(
  draft: { topic: string; title: string; content: string },
  context: RedditCommunityContext,
): Promise<RedditDraftReview> {
  const result = await AIanswer(
    JSON.stringify({
      subreddit: context.subreddit,
      rules: context.rules,
      isOwnedCommunity: context.isOwnedCommunity,
      recentCommunityPosts: context.recentCommunityPosts,
      candidateDraft: draft,
    }),
    "reddit-community-analyzer",
  );
  const review = parseDraftReview(result);
  console.info("[Reddit community analyzer] Draft review completed", {
    subreddit: context.subreddit,
    approved: review.approved,
    reason: review.reason,
    ruleCount: context.rules.length,
    recentCommunityPostCount: context.recentCommunityPosts.length,
  });
  return review;
}

/** Review a post received from the Reddit events stream against its subreddit rules. */
export async function reviewRedditPostEventAgainstCommunity(input: {
  subreddit: string;
  postId: string;
  title: string;
  content: string;
}): Promise<RedditDraftReview> {
  const subreddit = input.subreddit.trim().replace(/^r\//i, "");
  if (!subreddit || !input.postId.trim() || !input.title.trim()) {
    throw new Error("A subreddit, Reddit post ID, and post title are required for post analysis");
  }

  const isOwnedCommunity = isOwnedRedditCommunity(subreddit);
  const context = await getRedditAgentContext({
    subreddit,
    postId: input.postId,
    include: { rules: true, recentPostsLimit: isOwnedCommunity ? 12 : 0 },
  });
  if (!Array.isArray(context.rules)) throw new Error("Reddit service omitted requested subreddit rules");
  const recentCommunityPosts = context.posts ?? [];
  const normalizedPostId = input.postId.replace(/^t3_/i, "");
  const comparisonPosts = recentCommunityPosts.filter(
    (post) => post.postId.replace(/^t3_/i, "") !== normalizedPostId,
  );
  const result = await AIanswer(
    JSON.stringify({
      subreddit: context.subreddit,
      rules: context.rules,
      isOwnedCommunity,
      recentCommunityPosts: comparisonPosts,
      candidatePost: {
        postId: input.postId,
        title: input.title.trim(),
        content: input.content.trim(),
      },
    }),
    "reddit-community-analyzer",
  );
  const review = parseDraftReview(result);
  console.info("[Reddit community analyzer] Stream post review completed", {
    subreddit: context.subreddit,
    postId: input.postId,
    approved: review.approved,
    reason: review.reason,
    ruleCount: context.rules.length,
    recentCommunityPostCount: comparisonPosts.length,
  });
  return review;
}

/** Screen engagement candidates against the actual subreddit rules. */
export async function analyzeRedditCommentsAgainstRules(input: {
  subreddit: string;
  sourcePostId: string;
  post: { title: string; content: string };
  comments: { commentId: string; body: string; author: string | null }[];
}): Promise<RedditCommentRuleAnalysis> {
  if (!input.comments.length) return { approvedIds: [], rejectedIds: [], reasons: {} };

  const context = await getRedditAgentContext({
    subreddit: input.subreddit,
    postId: input.sourcePostId,
    include: { rules: true },
  });
  if (!Array.isArray(context.rules)) throw new Error("Reddit service omitted requested subreddit rules");
  const baseContext = {
    subreddit: context.subreddit,
    rules: context.rules,
    post: input.post,
  };
  const approvedIds: string[] = [];
  const rejectedIds: string[] = [];
  const reasons: Record<string, string> = {};

  for (const comments of chunkRedditComments(input.comments, baseContext)) {
    const result = await AIanswer(
      JSON.stringify({ ...baseContext, comments }),
      "reddit-comment-analyzer",
    );
    if (!result || typeof result !== "object") {
      throw new Error("Reddit comment analyzer returned no classification");
    }

    const output = result as Record<string, unknown>;
    const batchApproved = Array.isArray(output.approvedIds)
      ? output.approvedIds.filter((id): id is string => typeof id === "string")
      : [];
    const batchRejected = Array.isArray(output.rejectedIds)
      ? output.rejectedIds.filter((id): id is string => typeof id === "string")
      : [];
    const suppliedIds = comments.map((comment) => comment.commentId);
    const classified = [...batchApproved, ...batchRejected];
    if (
      batchApproved.length + batchRejected.length !== suppliedIds.length ||
      new Set(classified).size !== classified.length ||
      suppliedIds.some((id) => !classified.includes(id)) ||
      classified.some((id) => !suppliedIds.includes(id))
    ) {
      throw new Error("Reddit comment analyzer did not return an exact, non-overlapping ID partition");
    }

    approvedIds.push(...batchApproved);
    rejectedIds.push(...batchRejected);
    const rawReasons = output.reasons;
    if (rawReasons && typeof rawReasons === "object" && !Array.isArray(rawReasons)) {
      for (const id of batchRejected) {
        const reason = (rawReasons as Record<string, unknown>)[id];
        if (typeof reason === "string" && reason.trim()) reasons[id] = reason.trim();
      }
    }
    for (const id of batchRejected) {
      reasons[id] ??= "Rejected by the subreddit rules screening.";
    }
  }

  console.info("[Reddit community analyzer] Comment screening completed", {
    subreddit: context.subreddit,
    approvedCount: approvedIds.length,
    rejectedCount: rejectedIds.length,
    ruleCount: context.rules.length,
  });
  return { approvedIds, rejectedIds, reasons };
}
