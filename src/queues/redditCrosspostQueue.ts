import { Queue } from "bullmq";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};

export type RedditCrosspostJobData = { kind: "scan" };

export const redditCrosspostQueue = new Queue<RedditCrosspostJobData>(
  "reddit-crosspost",
  { connection },
);

export function getRedditCrosspostTargets(): string[] {
  return [...new Set(
    (process.env.REDDIT_CROSSPOST_TARGETS ?? "")
      .split(",")
      .map((value) => value.trim().replace(/^r\//i, "").toLowerCase())
      .filter(Boolean),
  )];
}
// Schedule periodic scans to crosspost to eligible subreddits.
export async function ensureRedditCrosspostScanner(): Promise<void> {
  const configuredDays = Number(process.env.REDDIT_CROSSPOST_SCAN_DAYS ?? 3);
  const days = Number.isFinite(configuredDays)
    ? Math.max(2, Math.min(3, Math.floor(configuredDays)))
    : 3;
  await redditCrosspostQueue.upsertJobScheduler(
    "scheduled-reddit-crosspost-scan",
    { every: days * 24 * 60 * 60 * 1000 },
    { name: "scan-scheduled-reddit-posts", data: { kind: "scan" } },
  );
  console.info("[Reddit crosspost] Periodic scanner configured", { everyDays: days });
}

redditCrosspostQueue.on("error", (error) => {
  console.error("[Reddit crosspost] Queue error", error);
});
