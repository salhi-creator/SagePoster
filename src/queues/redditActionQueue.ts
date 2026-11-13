import { Queue } from "bullmq";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};

export const redditActionQueue = new Queue<{ streamId: string }>("reddit-action-executor", {
  connection,
});

export async function enqueueRedditActionExecution(streamId: string): Promise<void> {
  await redditActionQueue.add(
    "execute-approved-action",
    { streamId },
    {
      jobId: `reddit-action-${streamId.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
}

redditActionQueue.on("error", (error) => {
  console.error("[Reddit action queue] Redis error", error);
});
