import { Queue } from "bullmq";

export const REDDIT_AGENT_NAMES = [
  "content_creator",
  "community_analyzer",
  "engagement",
  "crosspost_handler",
  "action_executor",
] as const;

export type RedditAgentName = (typeof REDDIT_AGENT_NAMES)[number];
export type RedditAgentJobData =
  | { kind: "strategy-plan" }
  | { kind: "agent-run"; agent: RedditAgentName };

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};

export const redditAgentQueue = new Queue<RedditAgentJobData>("reddit-agent-jobs", {
  connection,
});

redditAgentQueue.on("error", (error) => {
  console.error("[Reddit agent queue] Redis error", error);
});
