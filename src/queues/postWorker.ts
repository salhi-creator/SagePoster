import { Worker, Job } from "bullmq";
import { postQueue } from "./postQueue.js";

import { sendToTelegram } from "../Platform-ReplyHandle/sendToTelegram.js";
// import { sendToReddit } from "../Platform-ReplyHandle/sendToReddit.js";
// import { sendToLinkedIn } from "../Platform-ReplyHandle/sendToLinkedIn.js";
import handleSchedulePost from "../utilis/Telegram/handleSchedulePost.js";
import handleScheduleDiscord from "../utilis/Discord/handleScheduleDiscord.js";
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

export async function schedulePost(form: PostForm) {
  const postId = randomUUID();
  const platforms = (Object.keys(form.platforms) as Platform[]).filter(
    (platform) => form.platforms[platform]?.enabled,
  );
  const postData: PostJobData = { postId, platforms, form };
  const repeat = form["dead-line"]["repeat"];
  const endTime = form["dead-line"]["end-time"];
  const startTime = form["dead-line"]["start-time"];

  const isRecurring =
    repeat === "every-hour" ||
    repeat === "every-day" ||
    repeat === "every-week";

  const hasEndTime = endTime !== -1;

  const jobOptions = {
    attempts: 3,

    backoff: {
      type: "exponential" as const,
      delay: 5000,
    },

    removeOnComplete: true,
    removeOnFail: false,
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
    const schedulerId = `recurring-${postData.postId}`;

    const schedulerOptions = {
      pattern: getCronPattern(repeat),

      ...(startTime !== -1 && {
        startDate: new Date(startTime),
      }),

      ...(hasEndTime && {
        endDate: new Date(endTime),
      }),
    };

    await postQueue.upsertJobScheduler(schedulerId, schedulerOptions, {
      name: "post",
      data: postData,
      opts: jobOptions,
    });

    console.log(`[BullMQ] Post ${postData.postId} scheduled as ${repeat}`);

    return;
  }
}

/*
|--------------------------------------------------------------------------
| Convert repeat type to cron
|--------------------------------------------------------------------------
|
| All times are UTC.
|
*/

function getCronPattern(repeat: Deadline["repeat"]): string {
  switch (repeat) {
    case "every-hour":
      return "0 * * * *";

    case "every-day":
      return "0 0 * * *";

    case "every-week":
      return "0 0 * * 0";

    default:
      throw new Error(`Unsupported repeat value: ${repeat}`);
  }
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
      await handleSchedulePost(form.platforms.telegram, form.topic);

      console.log(`[BullMQ] Post ${postId} successfully sent to Telegram`);
    } catch (error) {
      console.error(`[BullMQ] Telegram failed for post ${postId}:`, error);

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
      await handleScheduleDiscord(form.platforms.discord, form.topic);

      console.log(`[BullMQ] Post ${postId} successfully sent to Discord`);
    } catch (error) {
      console.error(`[BullMQ] Discord failed for post ${postId}:`, error);

      throw error;
    }
  }

  /*
   * REDDIT
   *
   * Enable when Reddit integration is ready.
   */

  /*
  if (platforms.includes("reddit")) {
    if (!data.reddit) {
      throw new Error(
        `Post ${postId}: Reddit is enabled but no Reddit data was provided`
      );
    }

    console.log(
      `[BullMQ] Posting ${postId} to Reddit...`
    );

    try {
      results.reddit =
        await sendToReddit(data.reddit);

      console.log(
        `[BullMQ] Post ${postId} successfully sent to Reddit`
      );
    } catch (error) {
      console.error(
        `[BullMQ] Reddit failed for post ${postId}:`,
        error
      );

      throw error;
    }
  }
  */

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
  console.log(`[BullMQ] Job ${job.id} completed`, result);
});

postWorker.on("failed", (job, error) => {
  console.error(`[BullMQ] Job ${job?.id} failed:`, error);
});

postWorker.on("error", (error) => {
  console.error(`[BullMQ] Worker error:`, error);
});

console.log("[BullMQ] Post worker started");
