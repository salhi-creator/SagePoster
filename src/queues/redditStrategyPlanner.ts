import { Job, Worker } from "bullmq";
import { AIanswer } from "../AI.js";
import { getRedditManagementMode, getRecentRedditStreamEvents } from "../caching_redis/redditAgentStream.js";
import { runRedditActionExecutorBatch } from "../agents/redditActionExecutor.js";
import { runRedditCrosspostHandlerBatch } from "../agents/crosspost-handler.js";
import { runRedditActivityAgentBatch } from "../agents/redditEngagementConsumer.js";
import { createPendingRedditContentDraft } from "../agents/redditContentCreator.js";
import { logError } from "../utilis/logError.js";
import { disableLegacyRedditCrosspostScanner } from "./redditCrosspostQueue.js";
import {
  REDDIT_AGENT_NAMES,
  redditAgentQueue,
  type RedditAgentJobData,
  type RedditAgentName,
} from "./redditAgentQueue.js";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};

const defaultIntervals: Record<RedditAgentName, number> = {
  content_creator: 12,
  community_analyzer: 1,
  engagement: 2,
  crosspost_handler: 24,
  action_executor: 1,
};

function configuredSubreddits(): string[] {
  return [...new Set(
    (process.env.REDDIT_OWNED_SUBREDDITS ?? "SageFrontier")
      .split(",")
      .map((subreddit) => subreddit.trim().replace(/^r\//i, ""))
      .filter(Boolean),
  )];
}

async function ownerManagedSubreddits(): Promise<string[]> {
  const names = configuredSubreddits();
  const modes = await Promise.all(names.map((name) => getRedditManagementMode(name)));
  return names.filter((_name, index) => modes[index] === "owner");
}

function parseIntervals(value: unknown): { intervals: Record<RedditAgentName, number>; reason: string } {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const input = root.intervals && typeof root.intervals === "object"
    ? root.intervals as Record<string, unknown>
    : {};
  const intervals = {} as Record<RedditAgentName, number>;
  for (const agent of REDDIT_AGENT_NAMES) {
    const interval = input[agent];
    intervals[agent] = typeof interval === "number" && Number.isInteger(interval) && interval >= 1 && interval <= 24
      ? interval
      : defaultIntervals[agent];
  }
  return {
    intervals,
    reason: typeof root.reason === "string" ? root.reason.trim() : "No planner reason returned",
  };
}

async function scheduleAgentsFromStream(): Promise<void> {
  const activeSubreddits = await ownerManagedSubreddits();
  if (!activeSubreddits.length) {
    console.info("[Reddit strategy planner] No owner-managed subreddits; agent schedules left unchanged");
    return;
  }

  const recentEvents = await getRecentRedditStreamEvents(50);
  const result = await AIanswer(
    JSON.stringify({
      managedSubreddits: activeSubreddits,
      recentEvents,
      intervalConstraintsHours: { min: 1, max: 24 },
    }),
    "reddit-strategy-planner",
  );
  const plan = parseIntervals(result);

  for (const agent of REDDIT_AGENT_NAMES) {
    const intervalHours = plan.intervals[agent];
    await redditAgentQueue.upsertJobScheduler(
      `reddit-agent-${agent}`,
      { every: intervalHours * 60 * 60 * 1000 },
      {
        name: "run-reddit-agent",
        data: { kind: "agent-run", agent },
      },
    );
  }
  console.info("[Reddit strategy planner] Agent schedules updated", {
    intervalsHours: plan.intervals,
    managedSubreddits: activeSubreddits,
    streamEventsRead: recentEvents.length,
    reason: plan.reason,
  });
}

async function runAgent(agent: RedditAgentName): Promise<void> {
  const subreddits = await ownerManagedSubreddits();
  if (!subreddits.length) {
    console.info("[Reddit agent job] Skipped without an owner-managed subreddit", { agent });
    return;
  }

  switch (agent) {
    case "content_creator":
      for (const subreddit of subreddits) {
        try {
          const draft = await createPendingRedditContentDraft(subreddit);
          console.info("[Reddit content creator] Scheduled draft created", {
            draftId: draft.draftId,
            subreddit,
          });
        } catch (error) {
          logError("Scheduled Reddit content creation failed", error, { subreddit });
        }
      }
      return;
    case "community_analyzer":
      await runRedditActivityAgentBatch("community_analyzer", 20);
      return;
    case "engagement":
      await runRedditActivityAgentBatch("engagement", 20);
      return;
    case "crosspost_handler":
      await runRedditCrosspostHandlerBatch(20);
      return;
    case "action_executor":
      await runRedditActionExecutorBatch(20);
      return;
  }
}

async function processJob(job: Job<RedditAgentJobData>): Promise<void> {
  if (job.data.kind === "strategy-plan") {
    await scheduleAgentsFromStream();
  } else {
    await runAgent(job.data.agent);
  }
}

const worker = new Worker<RedditAgentJobData>(
  "reddit-agent-jobs",
  processJob,
  { connection, concurrency: 1, lockDuration: 15 * 60 * 1000 },
);

worker.on("completed", (job) => {
  console.info("[Reddit agent queue] Job completed", { jobId: job.id, data: job.data });
});
worker.on("failed", (job, error) => {
  logError("Reddit agent queue job failed", error, { jobId: job?.id, data: job?.data });
});
worker.on("error", (error) => {
  logError("Reddit agent queue worker error", error, {
    host: connection.host,
    port: connection.port,
  });
});

const configuredPlannerInterval = Number(process.env.REDDIT_STRATEGY_PLANNER_INTERVAL_MINUTES ?? 60);
const plannerIntervalMinutes = Number.isFinite(configuredPlannerInterval)
  ? Math.max(60, Math.min(24 * 60, Math.floor(configuredPlannerInterval)))
  : 60;

export async function ensureRedditStrategyPlanner(): Promise<void> {
  await disableLegacyRedditCrosspostScanner();
  await redditAgentQueue.upsertJobScheduler(
    "reddit-strategy-planner",
    { every: plannerIntervalMinutes * 60 * 1000 },
    { name: "plan-reddit-agent-schedules", data: { kind: "strategy-plan" } },
  );
  await redditAgentQueue.add(
    "plan-reddit-agent-schedules-now",
    { kind: "strategy-plan" },
    {
      jobId: `reddit-strategy-plan-now-${Math.floor(Date.now() / 60_000)}`,
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  console.info("[Reddit strategy planner] Scheduled", { intervalMinutes: plannerIntervalMinutes });
}
