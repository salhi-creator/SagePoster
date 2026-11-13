import {
  getScheduledRedditCrosspostCandidates,
  hasRedditCrosspost,
} from "../SQL_DB/connectDB.js";
import { enqueueApprovedRedditCrosspost } from "../caching_redis/redditAgentStream.js";
import { getRedditCrosspostTargets } from "./redditCrosspostQueue.js";

/** Called by the scheduled crosspost-handler BullMQ job. */
export async function scanScheduledRedditPosts(): Promise<number> {
  const targets = getRedditCrosspostTargets();
  if (!targets.length) {
    console.warn("[Reddit crosspost scan] Skipped: REDDIT_CROSSPOST_TARGETS is empty");
    return 0;
  }

  const candidates = await getScheduledRedditCrosspostCandidates(targets);
  let enqueued = 0;
  for (const candidate of candidates) {
    for (const targetSubreddit of targets) {
      if (targetSubreddit.toLowerCase() === candidate.sourceSubreddit.toLowerCase()) continue;
      if (await hasRedditCrosspost(candidate.sourcePostId, targetSubreddit)) continue;
      await enqueueApprovedRedditCrosspost({ ...candidate, targetSubreddit });
      enqueued += 1;
    }
  }
  console.info("[Reddit crosspost scan] Finished", {
    candidates: candidates.length,
    approvedStreamEvents: enqueued,
    targets: targets.length,
  });
  return enqueued;
}
