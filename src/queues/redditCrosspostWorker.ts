import { Job, Worker } from "bullmq";
import {
  getScheduledRedditCrosspostCandidates,
  hasRedditCrosspost,
} from "../SQL_DB/connectDB.js";
import { logError } from "../utilis/logError.js";
import { enqueueApprovedRedditCrosspost } from "../caching_redis/redditAgentStream.js";
import {
  getRedditCrosspostTargets,
  type RedditCrosspostJobData,
} from "./redditCrosspostQueue.js";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};

/** Periodic scanner: put eligible scheduled posts in the agent stream. */
async function scanScheduledRedditPosts(): Promise<void> {
  const targets = getRedditCrosspostTargets();
  if (!targets.length) {
    console.warn("[Reddit crosspost scan] Skipped: REDDIT_CROSSPOST_TARGETS is empty");
    return;
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
}

const worker = new Worker<RedditCrosspostJobData>(
  "reddit-crosspost",
  async (job: Job<RedditCrosspostJobData>) => {
    if (job.data.kind === "scan") await scanScheduledRedditPosts();
  },
  { connection, concurrency: 1, lockDuration: 120_000 },
);

worker.on("completed", (job) => {
  console.info("[Reddit crosspost scan] Scan job completed", { jobId: job.id });
});
worker.on("failed", (job, error) => {
  logError("Reddit crosspost scan job failed", error, { jobId: job?.id });
});
worker.on("error", (error) => {
  logError("Reddit crosspost scan worker Redis error", error, {
    host: connection.host,
    port: connection.port,
  });
});
worker.on("ready", () => {
  console.info("[Reddit crosspost scan] Worker connected and ready");
});
