import type { PostForm, RedditManagementMode } from "../Data-Structure/types.js";
import { sendMessageBackToMe } from "../utilis.js";
import {
  createPendingRedditContentDraft,
  RedditDraftStreamEnqueueError,
} from "../agents/redditContentCreator.js";
import { logError } from "./logError.js";
import { setRedditManagementMode } from "../caching_redis/redditAgentStream.js";

const REDDIT_MANAGEMENT_MODES: RedditManagementMode[] = [
  "shadow",
  "assistant",
  "owner",
];

function isRedditManagementMode(value: unknown): value is RedditManagementMode {
  return (
    typeof value === "string" &&
    REDDIT_MANAGEMENT_MODES.includes(value as RedditManagementMode)
  );
}

/** Handles only the new Reddit community-management intent signal. */
export async function handleRedditManagementIntent(
  form: PostForm,
  chatId: string | undefined,
): Promise<boolean> {
  const reddit = form.platforms.reddit;
  if (reddit?.manage !== true) return false;

  if (chatId === undefined) {
    throw new Error("Reddit management requests require a Telegram chat ID");
  }

  const requestedMode: unknown = reddit["manage-mode"];
  const mode =
    requestedMode === null || requestedMode === undefined
      ? "owner"
      : isRedditManagementMode(requestedMode)
        ? requestedMode
        : null;
  const message = mode
    ? `Reddit community management request recognized in ${mode} mode. Management actions are not active yet.`
    : "I couldn't identify a valid Reddit management mode. Please ask for shadow (analysis only), assistant (approval required), or owner (full control).";

  if (mode) await setRedditManagementMode(reddit.subreddit, mode);

  if (mode === "owner") {
    try {
      const draft = await createPendingRedditContentDraft(reddit.subreddit);
      const preview = draft.content.slice(0, 2_500);
      const truncated = draft.content.length > preview.length ? "\n…(preview shortened)" : "";
      await sendMessageBackToMe(
        String(chatId),
        `Reddit content draft created with pending status. It has not been published.\nDraft ID: ${draft.draftId}\nSubreddit: r/${draft.subreddit}\nTopic: ${draft.topic}\n\n${draft.title}\n\n${preview}${truncated}`,
      );
      return true;
    } catch (error) {
      if (error instanceof RedditDraftStreamEnqueueError) {
        await sendMessageBackToMe(
          String(chatId),
          `Draft ${error.draftId} was saved as pending in the database, but could not be added to the Redis Stream. It has not been published. Check the Redis connection before retrying.`,
        );
        return true;
      }
      logError("Reddit content creator agent failed", error, {
        subreddit: reddit.subreddit,
      });
      await sendMessageBackToMe(
        String(chatId),
        "The Reddit content creator could not create a pending draft. No post was published; check the server logs.",
      );
      return true;
    }
  }

  await sendMessageBackToMe(String(chatId), message);
  return true;
}
