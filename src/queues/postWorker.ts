import { Worker, Job } from "bullmq";
import { postQueue } from "./postQueue.js";

import { sendToTelegram } from "../Platform-ReplyHandle/sendToTelegram.js";
import { sendToReddit } from "../Platform-ReplyHandle/sendToReddit.js";
// import { sendToLinkedIn } from "../Platform-ReplyHandle/sendToLinkedIn.js";
import handleSchedulePost from "../utilis/Telegram/handleSchedulePost.js";
import handleScheduleDiscord from "../utilis/Discord/handleScheduleDiscord.js";
import { logError } from "../utilis/logError.js";
import { savePublishedRedditPost } from "../SQL_DB/connectDB.js";
import type {
  Deadline,
  Platform,
  PostForm,
  PostJobData,
} from "../Data-Structure/types.js";
import { randomUUID } from "node:crypto";
const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
};

const jobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: false,
};

const SCHEDULE_TIME_ZONE = "America/New_York";
const DAILY_START_MINUTE = 9 * 60;
const DAILY_END_MINUTE = 21 * 60;

export async function schedulePost(form: PostForm) {
  const postId = randomUUID();
  const platforms = (Object.keys(form.platforms) as Platform[]).filter(
    (platform) => form.platforms[platform]?.enabled,
  );
  const repeat = form["dead-line"]["repeat"];
  const endTime = form["dead-line"]["end-time"];
  const startTime = form["dead-line"]["start-time"];

  const isRecurring =
    repeat === "every-hour" ||
    repeat === "every-day" ||
    repeat === "every-week";

  const now = Date.now();
  const runAt = startTime === -1 ? now : Math.max(startTime, now);
  if (endTime !== -1 && runAt > endTime) {
    console.warn("[BullMQ] Schedule end time has already passed", { postId });
    return;
  }
  const postData: PostJobData = {
    postId,
    platforms,
    form,
    scheduledRunAt: runAt,
    ...(isRecurring ? { nextRunAt: getNextRunAt(repeat, runAt) } : {}),
  };

  // ─────────────────────────────────────────────
  // 1. IMMEDIATE
  // ─────────────────────────────────────────────

  if (startTime === -1) {
    // Always execute the first post immediately.
    const job = await postQueue.add("post", postData, jobOptions);

    console.log(`[BullMQ] Post ${postData.postId} queued immediately`);

    // If there is no repeat, we're done.
    if (!isRecurring) {
      return job;
    }

    // Otherwise, continue and create the recurring scheduler.
  }

  // ─────────────────────────────────────────────
  // 2. FUTURE + ONE-TIME
  // ─────────────────────────────────────────────

  if (startTime !== -1 && !isRecurring) {
    const delay = startTime - Date.now();

    if (delay <= 0) {
      const job = await postQueue.add("post", postData, jobOptions);

      console.log(
        `[BullMQ] Post ${postData.postId} start time already reached`,
      );

      return job;
    }

    const job = await postQueue.add("post", postData, {
      ...jobOptions,
      delay,
    });

    console.log(`[BullMQ] Post ${postData.postId} scheduled in ${delay}ms`);

    return job;
  }

  // ─────────────────────────────────────────────
  // 3. RECURRING
  // ─────────────────────────────────────────────

  if (isRecurring) {
    if (startTime === -1) return;

    const delay = Math.max(0, runAt - now);
    const job = await postQueue.add("post", postData, {
      ...jobOptions,
      jobId: `post-${postId}-${runAt}`,
      ...(delay > 0 ? { delay } : {}),
    });
    console.info("[BullMQ] Recurring post queued", {
      postId,
      repeat,
      firstRunAt: new Date(runAt).toISOString(),
      delayMs: delay,
    });
    return job;
  }
}

/* Compute the next randomized occurrence for a repeating post. */

function getNextRunAt(repeat: Deadline["repeat"], after: number): number {
  if (repeat === "every-hour") {
    const nextHour = (Math.floor(after / 3_600_000) + 1) * 3_600_000;
    return nextHour + randomInteger(0, 3_599) * 1_000;
  }

  const local = getLocalDateParts(after);
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  let daysAhead: number;

  if (repeat === "every-day") {
    daysAhead = 1;
  } else if (repeat === "every-week") {
    const dayOfWeek = localDate.getUTCDay();
    daysAhead = (7 - dayOfWeek) % 7 || 7;
  } else {
    throw new Error(`Unsupported recurring value: ${repeat}`);
  }

  localDate.setUTCDate(localDate.getUTCDate() + daysAhead);
  const minuteOfDay = randomInteger(DAILY_START_MINUTE, DAILY_END_MINUTE - 1);
  return localTimeToTimestamp(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth() + 1,
    localDate.getUTCDate(),
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
    randomInteger(0, 59),
  );
}

function randomInteger(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getLocalDateParts(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function localTimeToTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = desiredUtc;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = getLocalDateParts(timestamp);
    const representedUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    timestamp += desiredUtc - representedUtc;
  }

  return timestamp;
}

/*
|--------------------------------------------------------------------------
| Worker
|--------------------------------------------------------------------------
|
| The worker does NOT decide when the post runs.
|
| BullMQ already handles the deadline.
|
| The worker only executes the post when BullMQ gives
| it a job.
|
*/

async function handlePostJob(job: Job<PostJobData>) {
  const { postId, platforms, form } = job.data;

  console.log(`[BullMQ] Processing post ${postId} -> ${platforms.join(",")}`);

  const results: Record<string, unknown> = {};

  /*
   * TELEGRAM
   */

  if (platforms.includes("telegram")) {
    if (!form.platforms.telegram) {
      throw new Error(
        `Post ${postId}: Telegram is enabled but no Telegram data was provided`,
      );
    }

    console.log(`[BullMQ] Posting ${postId} to Telegram...`);

    try {
      // scheduled Post
      if (!form.platforms.telegram.content) {
        throw new Error(`Post ${postId}: Telegram content is empty`);
      }
      await handleSchedulePost(
        form.platforms.telegram,
        form.topic,
        form["post-style"],
        postId,
      );

      console.log(`[BullMQ] Post ${postId} successfully sent to Telegram`);
    } catch (error) {
      logError("BullMQ Telegram delivery failed", error, { postId });

      throw error;
    }
  }

  /*
   * DISCORD
   */

  if (platforms.includes("discord")) {
    if (!form.platforms.discord) {
      throw new Error(
        `Post ${postId}: Discord is enabled but no Discord data was provided`,
      );
    }

    console.log(`[BullMQ] Posting ${postId} to Discord...`);

    try {
      await handleScheduleDiscord(
        form.platforms.discord,
        form.topic,
        form["post-style"],
        postId,
      );

      console.log(`[BullMQ] Post ${postId} successfully sent to Discord`);
    } catch (error) {
      logError("BullMQ Discord delivery failed", error, { postId });

      throw error;
    }
  }

  if (platforms.includes("reddit")) {
    const redditPost = form.platforms.reddit;
    if (!redditPost?.enabled) {
      throw new Error(
        `Post ${postId}: Reddit is enabled but no Reddit data was provided`,
      );
    }
    if (!form.topic?.trim()) {
      throw new Error(`Post ${postId}: a topic is required to track Reddit publishing`);
    }
    console.log(`[BullMQ] Posting ${postId} to Reddit...`);
    try {
      const published = await sendToReddit(redditPost);
      results.reddit = published;
      console.log(`[BullMQ] Post ${postId} successfully sent to Reddit`, {
        redditPostId: published.postId,
        url: published.url,
      });
      if (form.topic) {
        try {
          await savePublishedRedditPost(
            form.topic,
            { ...redditPost, redditPostId: published.postId, url: published.url },
            { deliveryType: "scheduled", postId },
          );
        } catch (error) {
          logError("Reddit history save failed", error, { postId });
        }
      }
    } catch (error) {
      logError("BullMQ Reddit delivery failed", error, { postId });
      throw error;
    }
  }

  /*
   * LINKEDIN
   *
   * Enable when LinkedIn integration is ready.
   */

  /*
  if (platforms.includes("linkedin")) {
    if (!data.linkedin) {
      throw new Error(
        `Post ${postId}: LinkedIn is enabled but no LinkedIn data was provided`
      );
    }

    console.log(
      `[BullMQ] Posting ${postId} to LinkedIn...`
    );

    try {
      results.linkedin =
        await sendToLinkedIn(data.linkedin);

      console.log(
        `[BullMQ] Post ${postId} successfully sent to LinkedIn`
      );
    } catch (error) {
      console.error(
        `[BullMQ] LinkedIn failed for post ${postId}:`,
        error
      );

      throw error;
    }
  }
  */

  const repeat = form["dead-line"].repeat;
  const endTime = form["dead-line"]["end-time"];
  const isRecurring =
    repeat === "every-hour" ||
    repeat === "every-day" ||
    repeat === "every-week";
  let nextRunAt = job.data.nextRunAt;

  // Convert recurring schedulers created by the previous cron-based version.
  if (isRecurring && nextRunAt === undefined) {
    await postQueue.removeJobScheduler(`recurring-${postId}`);
    nextRunAt = getNextRunAt(repeat, job.data.scheduledRunAt ?? Date.now());
    console.info("[BullMQ] Migrated legacy recurring schedule", {
      postId,
      repeat,
    });
  }

  if (isRecurring && nextRunAt !== undefined && nextRunAt <= Date.now()) {
    nextRunAt = getNextRunAt(repeat, Date.now());
  }

  if (
    isRecurring &&
    nextRunAt !== undefined &&
    (endTime === -1 || nextRunAt <= endTime)
  ) {
    const nextData: PostJobData = {
      ...job.data,
      scheduledRunAt: nextRunAt,
      nextRunAt: getNextRunAt(repeat, nextRunAt),
    };
    const delay = Math.max(0, nextRunAt - Date.now());
    await postQueue.add("post", nextData, {
      ...jobOptions,
      jobId: `post-${postId}-${nextRunAt}`,
      delay,
    });
    console.info("[BullMQ] Next recurring post queued", {
      postId,
      repeat,
      runAt: new Date(nextRunAt).toISOString(),
      delayMs: delay,
    });
  }

  return {
    postId,
    platforms,
    results,
  };
}

/*
|--------------------------------------------------------------------------
| BullMQ Worker
|--------------------------------------------------------------------------
*/

export const postWorker = new Worker<PostJobData>("post", handlePostJob, {
  connection,

  /*
   * Process up to 5 posts at the same time.
   */
  concurrency: 5,

  /*
   * Give API requests enough time to finish.
   */
  lockDuration: 60_000,
});

/*
|--------------------------------------------------------------------------
| Worker Events
|--------------------------------------------------------------------------
*/

postWorker.on("completed", (job, result) => {
  console.info("[BullMQ] Job completed", {
    jobId: job.id,
    postId: job.data.postId,
    platforms: job.data.platforms,
  });
});

postWorker.on("failed", (job, error) => {
  logError("BullMQ job failed", error, {
    jobId: job?.id,
    postId: job?.data.postId,
    attemptsMade: job?.attemptsMade,
    platforms: job?.data.platforms.join(","),
  });
});

postWorker.on("error", (error) => {
  logError("BullMQ worker Redis/processing error", error, {
    host: connection.host,
    port: connection.port,
  });
});

postWorker.on("ready", () => {
  console.info("[BullMQ] Worker connected to Redis and ready");
});

postWorker.on("stalled", (jobId) => {
  console.error("[BullMQ] Job stalled", { jobId });
});

console.log("[BullMQ] Post worker started");
