import { randomUUID } from "node:crypto";
import { AIanswer } from "../AI.js";
import {
  getLatestRedditContentHistory,
  savePendingRedditDraftIfUnique,
  setRedditDraftStreamId,
  type PendingRedditDraftInput,
} from "../SQL_DB/connectDB.js";
import { enqueuePendingRedditDraft } from "../caching_redis/redditAgentStream.js";
import { logError } from "../utilis/logError.js";
import {
  loadRedditCommunityContext,
  reviewRedditDraftAgainstCommunity,
} from "./redditCommunityAnalyzer.js";

type GeneratedRedditDraft = {
  topic: string;
  title: string;
  content: string;
};

export type PendingRedditDraftResult = {
  draftId: string;
  subreddit: string;
  topic: string;
  title: string;
  content: string;
  status: "pending";
  streamId: string | null;
};

export class RedditDraftStreamEnqueueError extends Error {
  constructor(
    readonly draftId: string,
    cause: unknown,
  ) {
    super("The Reddit draft was saved in the database, but Redis Stream enqueue failed", {
      cause,
    });
    this.name = "RedditDraftStreamEnqueueError";
  }
}

function validateGeneratedDraft(value: unknown): GeneratedRedditDraft {
  if (!value || typeof value !== "object") {
    throw new Error("Reddit content creator returned no draft object");
  }
  const draft = value as Record<string, unknown>;
  const topic = typeof draft.topic === "string" ? draft.topic.trim() : "";
  const title = typeof draft.title === "string" ? draft.title.trim() : "";
  const content = typeof draft.content === "string" ? draft.content.trim() : "";
  if (!topic || !title || !content) {
    throw new Error("Reddit content creator must return a topic, title, and content");
  }
  if (title.length > 300 || content.length > 40_000) {
    throw new Error("Reddit content creator exceeded Reddit's title or body limit");
  }
  return { topic, title, content };
}

/** Generate and persist a draft for review. This function never publishes. */
export async function createPendingRedditContentDraft(
  subredditInput: string,
): Promise<PendingRedditDraftResult> {
  const subreddit = subredditInput.trim().replace(/^r\//i, "");
  if (!subreddit) throw new Error("A subreddit is required to create a Reddit draft");

  const history = await getLatestRedditContentHistory(subreddit, 20);
  const community = await loadRedditCommunityContext(subreddit);
  let duplicateHint: { topic: string; title: string } | undefined;
  let ruleFeedback: string[] | undefined;

  // Regenerate at most twice if the analyzer rejects a draft or the DB finds
  // an exact duplicate. No rejected candidate is stored or published.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const aiResult = await AIanswer(
      JSON.stringify({
        subreddit,
        recentSavedRedditPosts: history,
        communityRules: community.rules,
        isOwnedCommunity: community.isOwnedCommunity,
        recentCommunityPosts: community.recentCommunityPosts,
        ...(duplicateHint ? { avoidThisDuplicate: duplicateHint } : {}),
        ...(ruleFeedback ? { reviseToAddressCommunityRules: ruleFeedback } : {}),
      }),
      "reddit-content-creator",
    );
    const generated = validateGeneratedDraft(aiResult);
    const review = await reviewRedditDraftAgainstCommunity(generated, community);
    if (!review.approved) {
      ruleFeedback = review.ruleFeedback;
      duplicateHint = undefined;
      if (attempt < 2) continue;
      throw new Error(
        `Community analyzer rejected three draft attempts: ${review.reason}`,
      );
    }

    const draft: PendingRedditDraftInput = {
      draftId: randomUUID(),
      subreddit,
      topic: generated.topic,
      title: generated.title,
      content: generated.content,
    };
    const saved = await savePendingRedditDraftIfUnique(draft);
    if (!saved.saved) {
      duplicateHint = saved.duplicate ?? {
        topic: generated.topic,
        title: generated.title,
      };
      ruleFeedback = undefined;
      if (attempt < 2) continue;
      throw new Error(
        `The database detected duplicate drafts on all attempts (latest: ${duplicateHint.title}).`,
      );
    }

    const createdAt = new Date().toISOString();
    let streamId: string;
    try {
      streamId = await enqueuePendingRedditDraft(draft, createdAt);
    } catch (error) {
      logError("Pending Reddit draft Redis Stream enqueue failed", error, {
        draftId: draft.draftId,
        subreddit,
      });
      throw new RedditDraftStreamEnqueueError(draft.draftId, error);
    }
    try {
      const linked = await setRedditDraftStreamId(draft.draftId, streamId);
      if (!linked) {
        throw new Error("Could not link the Redis Stream entry to its database draft");
      }
    } catch (error) {
      // Both pending records already exist; the draft ID remains in the stream
      // so a later consumer can still find its database row.
      logError("Could not save Reddit draft Redis Stream reference", error, {
        draftId: draft.draftId,
        streamId,
      });
    }

    return {
      draftId: draft.draftId,
      subreddit,
      topic: draft.topic,
      title: draft.title,
      content: draft.content,
      status: "pending",
      streamId,
    };
  }

  throw new Error(
    `A duplicate Reddit draft was detected twice. No pending draft was saved${duplicateHint ? ` (similar to: ${duplicateHint.title})` : ""}.`,
  );
}
