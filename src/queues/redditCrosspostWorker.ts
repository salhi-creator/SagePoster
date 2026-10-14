import { Job, Worker } from "bullmq";
import { AIanswer } from "../AI.js";
import {
  checkRedditCrosspost,
  publishRedditCrosspost,
} from "../Platform-ReplyHandle/sendToReddit.js";
import {
  completeRedditCrosspost,
  getScheduledRedditCrosspostCandidates,
  hasRedditCrosspost,
  reserveRedditCrosspost,
  savePublishedRedditPost,
} from "../SQL_DB/connectDB.js";
import { logError } from "../utilis/logError.js";
import {
  enqueueRedditCrosspost,
  getRedditCrosspostTargets,
  type RedditCrosspostJobData,
} from "./redditCrosspostQueue.js";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};

async function scanScheduledRedditPosts(): Promise<void> {
  const targets = getRedditCrosspostTargets();
  if (!targets.length) {
    console.warn("[Reddit crosspost] Scan skipped: REDDIT_CROSSPOST_TARGETS is empty");
    return;
  }

  const candidates = await getScheduledRedditCrosspostCandidates(targets);
  let enqueued = 0;
  for (const candidate of candidates) {
    for (const targetSubreddit of targets) {
      if (targetSubreddit.toLowerCase() === candidate.sourceSubreddit.toLowerCase()) {
        continue;
      }
      if (await hasRedditCrosspost(candidate.sourcePostId, targetSubreddit)) continue;
      await enqueueRedditCrosspost(candidate, targetSubreddit);
      enqueued += 1;
    }
  }
  console.info("[Reddit crosspost] Scan finished", {
    candidates: candidates.length,
    jobsEnqueued: enqueued,
    targets: targets.length,
  });
}

async function crosspostScheduledPost(
  candidate: Extract<RedditCrosspostJobData, { kind: "crosspost" }>["candidate"],
  targetSubreddit: string,
): Promise<void> {
  if (await hasRedditCrosspost(candidate.sourcePostId, targetSubreddit)) return;

  const request = {
    sourcePostId: candidate.sourcePostId,
    targetSubreddit,
    title: null,
  };
  const checked = await checkRedditCrosspost(request);
  if (!checked.canCrosspost) {
    console.info("[Reddit crosspost] Target currently disallows crossposting", {
      sourcePostId: candidate.sourcePostId,
      targetSubreddit: checked.targetSubreddit,
    });
    return;
  }

  const review = await AIanswer(
    JSON.stringify({
      sourcePost: checked.sourcePost,
      targetSubreddit: checked.targetSubreddit,
      rules: checked.rules,
    }),
    "reddit-crosspost-review",
  ) as { safeToCrosspost?: unknown; reason?: unknown } | null;
  if (review?.safeToCrosspost !== true) {
    console.info("[Reddit crosspost] AI rule check did not approve this post", {
      sourcePostId: candidate.sourcePostId,
      targetSubreddit: checked.targetSubreddit,
      reason: typeof review?.reason === "string" ? review.reason : "No review result",
    });
    return;
  }

  // Reserve before the external write so retries/scans cannot create duplicate
  // crossposts if Devvit accepts a request but its response is lost.
  const reserved = await reserveRedditCrosspost({
    sourcePostId: candidate.sourcePostId,
    targetSubreddit: checked.targetSubreddit,
  });
  if (!reserved) return;

  const published = await publishRedditCrosspost(request);
  await completeRedditCrosspost({
    sourcePostId: candidate.sourcePostId,
    targetSubreddit: published.targetSubreddit,
    crosspostId: published.crosspostId,
    url: published.url,
  });
  try {
    await savePublishedRedditPost(
      candidate.topic,
      {
        subreddit: published.targetSubreddit,
        title: request.title ?? checked.sourcePost.title,
        content: checked.sourcePost.body?.trim() || checked.sourcePost.title,
        redditPostId: published.crosspostId,
        url: published.url,
      },
      { deliveryType: "one-time" },
    );
  } catch (error) {
    logError("Crossposted Reddit history save failed", error, {
      sourcePostId: candidate.sourcePostId,
      crosspostId: published.crosspostId,
    });
  }
  console.info("[Reddit crosspost] Scheduled Reddit post crossposted", {
    sourcePostId: candidate.sourcePostId,
    crosspostId: published.crosspostId,
    targetSubreddit: published.targetSubreddit,
    url: published.url,
  });
}

const worker = new Worker<RedditCrosspostJobData>(
  "reddit-crosspost",
  async (job: Job<RedditCrosspostJobData>) => {
    if (job.data.kind === "scan") {
      await scanScheduledRedditPosts();
      return;
    }
    await crosspostScheduledPost(job.data.candidate, job.data.targetSubreddit);
  },
  { connection, concurrency: 2, lockDuration: 120_000 },
);

worker.on("completed", (job) => {
  console.info("[Reddit crosspost] Worker job completed", { jobId: job.id });
});
worker.on("failed", (job, error) => {
  logError("Reddit crosspost worker job failed", error, {
    jobId: job?.id,
    kind: job?.data.kind,
  });
});
worker.on("error", (error) => {
  logError("Reddit crosspost worker Redis error", error, {
    host: connection.host,
    port: connection.port,
  });
});

worker.on("ready", () => {
  console.info("[Reddit crosspost] Worker connected and ready");
});
