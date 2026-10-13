import { Job, Queue } from "bullmq";
import { logError } from "../utilis/logError.js";
import type { ManagedPost, PostJobData } from "../Data-Structure/types.js";

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};

export const postQueue = new Queue("post", {
  connection,
});

const managementQueueStates = [
  "waiting",
  "delayed",
  "active",
  "prioritized",
  "waiting-children",
  "failed",
] as const;

export async function getManagedSchedules(limit = 300): Promise<ManagedPost[]> {
  const jobs = await postQueue.getJobs(
    [...managementQueueStates],
    0,
    Math.max(0, limit - 1),
    false,
  );
  const grouped = new Map<string, ManagedPost>();

  for (const job of jobs as Job<PostJobData>[]) {
    const { postId, platforms, form, scheduledRunAt } = job.data;
    if (!postId || !form?.topic || !Array.isArray(platforms)) continue;

    const state = await job.getState();
    const managedId = `schedule:${postId}`;
    const current = grouped.get(managedId);
    const status: ManagedPost["status"] =
      state === "active" ? "running" : state === "failed" ? "failed" : "scheduled";
    const date = scheduledRunAt ? new Date(scheduledRunAt).toISOString() : undefined;
    const contentPreview =
      form.platforms.telegram?.content ??
      form.platforms.discord?.content ??
      form.platforms.reddit?.content ??
      "";

    if (!current) {
      grouped.set(managedId, {
        postId: managedId,
        kind: "schedule",
        status,
        topic: form.topic,
        platforms,
        ...(date ? { scheduledAt: date } : {}),
        repeat: form["dead-line"].repeat,
        contentPreview: contentPreview.slice(0, 240),
        form,
      });
      continue;
    }

    if (
      status === "running" ||
      (status === "scheduled" && current.status !== "running") ||
      (status === "failed" && current.status === "failed")
    ) {
      current.status = status;
    }
    if (date && (!current.scheduledAt || Date.parse(date) < Date.parse(current.scheduledAt))) {
      current.scheduledAt = date;
    }
  }

  return [...grouped.values()].sort(
    (left, right) =>
      Date.parse(left.scheduledAt ?? "9999-12-31") -
      Date.parse(right.scheduledAt ?? "9999-12-31"),
  );
}

export async function removeManagedSchedule(postId: string): Promise<boolean> {
  const jobs = await postQueue.getJobs([...managementQueueStates], 0, -1, false);
  const matches = (jobs as Job<PostJobData>[]).filter(
    (job) => job.data.postId === postId,
  );
  if (matches.length === 0) return false;

  const states = await Promise.all(matches.map((job) => job.getState()));
  if (states.includes("active")) {
    throw new Error(`Schedule ${postId} is currently running and cannot be removed`);
  }

  await Promise.all(matches.map((job) => job.remove()));
  return true;
}

export async function removePlatformsFromManagedSchedule(
  postId: string,
  platformsToRemove: Platform[],
): Promise<boolean> {
  const jobs = await postQueue.getJobs([...managementQueueStates], 0, -1, false);
  const matches = (jobs as Job<PostJobData>[]).filter(
    (job) => job.data.postId === postId,
  );
  if (!matches.length) return false;

  const states = await Promise.all(matches.map((job) => job.getState()));
  if (states.includes("active")) {
    throw new Error(`Schedule ${postId} is currently running and cannot be changed`);
  }

  const removeSet = new Set(platformsToRemove);
  for (const job of matches) {
    const remaining = job.data.platforms.filter((platform) => !removeSet.has(platform));
    if (remaining.length === job.data.platforms.length) continue;
    if (!remaining.length) {
      await job.remove();
      continue;
    }

    const formPlatforms = Object.fromEntries(
      Object.entries(job.data.form.platforms).map(([name, current]) => [
        name,
        current && removeSet.has(name as Platform)
          ? { ...current, enabled: false }
          : current,
      ]),
    ) as PostJobData["form"]["platforms"];
    await job.updateData({
      ...job.data,
      platforms: remaining,
      form: { ...job.data.form, platforms: formPlatforms },
    });
  }
  return true;
}

console.info("[BullMQ] Connecting to Redis", {
  host: connection.host,
  port: connection.port,
  hasUsername: Boolean(connection.username),
  hasPassword: Boolean(connection.password),
});

postQueue.on("error", (error) => {
  logError("BullMQ queue Redis error", error, {
    host: connection.host,
    port: connection.port,
  });
});

void postQueue
  .waitUntilReady()
  .then(() => console.info("[BullMQ] Queue connected to Redis"))
  .catch((error) =>
    logError("BullMQ queue failed to connect to Redis", error, {
      host: connection.host,
      port: connection.port,
    }),
  );

