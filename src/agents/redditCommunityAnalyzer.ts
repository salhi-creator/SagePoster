import { AIanswer } from "../AI.js";
import { getLatestPublishedRedditPostId } from "../SQL_DB/connectDB.js";
import {
  checkRedditCrosspost,
  getRedditSubredditPosts,
  type RedditCommunityPost,
} from "../Platform-ReplyHandle/sendToReddit.js";

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
  const recentCommunityPosts = isOwnedCommunity
    ? await getRedditSubredditPosts(subreddit, 12)
    : [];

  // The Devvit rules check requires a real source post ID. Use a listed post
  // for an owned community, or one of our saved posts for an external target.
  const sourcePostId =
    recentCommunityPosts[0]?.postId ??
    (await getLatestPublishedRedditPostId()) ??
    (await getRedditSubredditPosts(subreddit, 1))[0]?.postId;
  if (!sourcePostId) {
    throw new Error(
      "Cannot fetch subreddit rules: Devvit requires a source Reddit post ID, but none is available",
    );
  }

  const checked = await checkRedditCrosspost({
    sourcePostId,
    targetSubreddit: subreddit,
    title: null,
  });
  return {
    subreddit: checked.targetSubreddit,
    rules: checked.rules,
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

/** Screen engagement candidates against the actual subreddit rules. */
export async function analyzeRedditCommentsAgainstRules(input: {
  subreddit: string;
  sourcePostId: string;
  post: { title: string; content: string };
  comments: { commentId: string; body: string; author: string | null }[];
}): Promise<RedditCommentRuleAnalysis> {
  if (!input.comments.length) return { approvedIds: [], rejectedIds: [], reasons: {} };

  const checked = await checkRedditCrosspost({
    sourcePostId: input.sourcePostId,
    targetSubreddit: input.subreddit,
    title: null,
  });
  const result = await AIanswer(
    JSON.stringify({
      subreddit: checked.targetSubreddit,
      rules: checked.rules,
      post: input.post,
      comments: input.comments,
    }),
    "reddit-comment-analyzer",
  );
  if (!result || typeof result !== "object") {
    throw new Error("Reddit comment analyzer returned no classification");
  }

  const output = result as Record<string, unknown>;
  const approvedIds = Array.isArray(output.approvedIds)
    ? output.approvedIds.filter((id): id is string => typeof id === "string")
    : [];
  const rejectedIds = Array.isArray(output.rejectedIds)
    ? output.rejectedIds.filter((id): id is string => typeof id === "string")
    : [];
  const suppliedIds = input.comments.map((comment) => comment.commentId);
  const classified = [...approvedIds, ...rejectedIds];
  if (
    approvedIds.length + rejectedIds.length !== suppliedIds.length ||
    new Set(classified).size !== classified.length ||
    suppliedIds.some((id) => !classified.includes(id)) ||
    classified.some((id) => !suppliedIds.includes(id))
  ) {
    throw new Error("Reddit comment analyzer did not return an exact, non-overlapping ID partition");
  }

  const rawReasons = output.reasons;
  const reasons: Record<string, string> = {};
  if (rawReasons && typeof rawReasons === "object" && !Array.isArray(rawReasons)) {
    for (const id of rejectedIds) {
      const reason = (rawReasons as Record<string, unknown>)[id];
      if (typeof reason === "string" && reason.trim()) reasons[id] = reason.trim();
    }
  }
  for (const id of rejectedIds) {
    reasons[id] ??= "Rejected by the subreddit rules screening.";
  }

  console.info("[Reddit community analyzer] Comment screening completed", {
    subreddit: checked.targetSubreddit,
    approvedCount: approvedIds.length,
    rejectedCount: rejectedIds.length,
    ruleCount: checked.rules.length,
  });
  return { approvedIds, rejectedIds, reasons };
}
