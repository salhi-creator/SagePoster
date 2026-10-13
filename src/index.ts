import express from "express";
import http from "http";
import dotenv from "dotenv";
import { sendToTelegram } from "./Platform-ReplyHandle/sendToTelegram.js";
import { sendToDiscord } from "./Platform-ReplyHandle/sendToDiscord.js";
import { sendToReddit } from "./Platform-ReplyHandle/sendToReddit.js";
import { AIanswer } from "./AI.js";
import prepareTelegramPost from "./utilis/Telegram/prepareTelegramPost.js";
import { fileURLToPath } from "url";
import { MediaCheck, sendMessageBackToMe } from "./utilis.js";
import {
  getRandomCloudinaryPostImages,
  saveTelegramPicturesToCloudinary,
} from "./utilis/cloudinary.js";
import { setPictureToCloudinary } from "./utilis/setPictureToCloudinary.js";
import { schedulePost } from "./queues/postWorker.js";
import { randomUUID } from "node:crypto";
import { logError } from "./utilis/logError.js";
import { managePosts } from "./utilis/managePosts.js";
import {
  savePublishedDiscordPost,
  savePublishedRedditPost,
  savePublishedTelegramPost,
} from "./SQL_DB/connectDB.js";
import type { PostForm } from "./Data-Structure/types.js";

import path from "path";

const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const port = process.env.PORT || 3500;

app.use(express.json());

const server = http.createServer(app);

server.listen(port, () => {
  console.log(`Bot server is working on port ${port}`);
});

app.get("/SagePosterhealth", (_req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.post("/set-picture-to-cloudinary", setPictureToCloudinary);

app.post("/webhook", async (req, res) => {
  const requestId = randomUUID();
  const update = req.body?.message ?? req.body?.channel_post;
  const updateType = update?.photo?.length
    ? "photo"
    : update?.video
      ? "video"
      : update?.text || update?.caption
        ? "text"
        : "other";
  console.info("[Webhook] Received update", { requestId, updateType });
  // Telegram needs a quick response
  res.sendStatus(200);

  // You will handle the AI result here later
  // console.log("req ", req);
  const chatId =
    req.body?.message?.chat?.id ?? req.body?.channel_post?.chat?.id;
  const uploadCommand =
    typeof update?.caption === "string"
      ? update.caption.match(
          /^\/(?:setpicture|set-picture-to-cloudinary)(?:@\w+)?(?:\s+([\s\S]*))?$/i,
        )
      : typeof update?.text === "string"
        ? update.text.match(
            /^\/(?:setpicture|set-picture-to-cloudinary)(?:@\w+)?(?:\s+([\s\S]*))?$/i,
          )
        : null;
  if (uploadCommand) {
    try {
      const uploaded = await saveTelegramPicturesToCloudinary(
        { message: update },
        uploadCommand[1]?.trim(),
      );
      console.info("[Cloudinary] Telegram command saved images", {
        requestId,
        count: uploaded.length,
      });
      if (chatId !== undefined) {
        await sendMessageBackToMe(
          String(chatId),
          `Saved ${uploaded.length} image(s) to Cloudinary:\n${uploaded.map((item) => item.url).join("\n")}`,
        );
      }
    } catch (error) {
      logError("Telegram Cloudinary image command failed", error, {
        requestId,
      });
      if (chatId !== undefined) {
        await sendMessageBackToMe(
          String(chatId),
          error instanceof Error
            ? error.message
            : "Could not save the image to Cloudinary.",
        );
      }
    }
    return;
  }

  let result: PostForm;
  try {
    // this will handle any vedios or photos save them to cloudinary and return reusable url

    // this func checks any Images , Vedios been sent
    const processedMedia = await MediaCheck(req.body);
    console.info("[Webhook] Media processing complete", {
      requestId,
      mediaCount: processedMedia.media.length,
    });

    let message = req.body?.message?.text;
    // Ignore updates that don't contain a text message
    if (!message) {
      message = processedMedia.prompt;
      if (message === undefined || message?.trim() === "") {
        return;
      }
    }

    console.info("[Webhook] Sending input to planner", { requestId });

    // User-provided media takes precedence; only query optional image assets
    // when the incoming post did not already include media.
    const plannerImageContext = processedMedia.media.length
      ? null
      : await getRandomCloudinaryPostImages();

    // Send the received message to your AI function
    result = await AIanswer(
      message,
      undefined,
      plannerImageContext ?? undefined,
    );
    if (!result) {
      console.error("[Webhook] Planner returned no result", { requestId });
      if (chatId !== undefined) {
        await sendMessageBackToMe(
          chatId,
          "I could not process that request. Please try again.",
        );
      }
      return;
    }
    console.info("[AI] Received Data", result);

    // Keep uploaded media authoritative; the planner should not drop album items.
    if (processedMedia.media.length > 0) {
      if (result.platforms.telegram) {
        result.platforms.telegram.media = processedMedia.media;
      }
      if (result.platforms.discord) {
        result.platforms.discord.media = processedMedia.media;
      }
    }

    const allowedImageUrls = new Set(
      plannerImageContext?.candidates.map((candidate) => candidate.url) ?? [],
    );
    const selectedImageUrls = processedMedia.media.length
      ? []
      : [
          ...new Set(
            (Array.isArray(result.metadata?.images)
              ? result.metadata.images
              : []
            ).filter(
              (url): url is string =>
                typeof url === "string" && allowedImageUrls.has(url),
            ),
          ),
        ].slice(0, plannerImageContext?.desiredCount ?? 0);
    result.metadata.images = selectedImageUrls;
    const optionalImages = selectedImageUrls.map((url) => ({
      type: "image" as const,
      url,
    }));
    if (optionalImages.length) {
      for (const platform of Object.values(result.platforms)) {
        if (!platform?.enabled) continue;
        platform.media = [...(platform.media ?? []), ...optionalImages];
      }
    }
    console.info("[Webhook] Planner completed", {
      requestId,
      state: result["current-state"],
      telegramEnabled: result.platforms.telegram?.enabled ?? false,
      discordEnabled: result.platforms.discord?.enabled ?? false,
    });

    if (result["current-state"] === "managing") {
      if (chatId === undefined) {
        throw new Error("Cannot manage posts without a Telegram chat ID");
      }
      await managePosts(message, String(chatId));
      return;
    }

    if (result["current-state"] === "submit") {
      if (result.platforms.telegram?.enabled) {
        const resultPost = await prepareTelegramPost(result);
        const telegramPost = resultPost?.platforms.telegram;
        if (telegramPost) {
          await sendToTelegram(telegramPost);
          console.info("[Webhook] Telegram publish succeeded", { requestId });
          if (result.topic && telegramPost.content) {
            try {
              await savePublishedTelegramPost(
                result.topic,
                telegramPost.content,
              );
            } catch (error) {
              logError("Telegram history save failed", error, { requestId });
            }
          }
        }
      }

      const redditPost = result.platforms.reddit;
      if (redditPost?.enabled) {
        if (!result.topic?.trim()) {
          throw new Error("A topic is required to save and manage Reddit posts");
        }
        const published = await sendToReddit(redditPost);
        console.info("[Webhook] Reddit publish succeeded", {
          requestId,
          redditPostId: published.postId,
          url: published.url,
        });
        if (result.topic) {
          try {
            await savePublishedRedditPost(
              result.topic,
              { ...redditPost, redditPostId: published.postId, url: published.url },
              { deliveryType: "one-time" },
            );
          } catch (error) {
            logError("Reddit history save failed", error, { requestId });
          }
        }
      }

      if (result.platforms.discord?.enabled) {
        await sendToDiscord(result.platforms?.discord, result["post-style"]);
        console.info("[Webhook] Discord publish succeeded", { requestId });
        if (result.topic && result.platforms.discord.content) {
          try {
            await savePublishedDiscordPost(
              result.topic,
              result.platforms.discord.content,
            );
          } catch (error) {
            logError("Discord history save failed", error, { requestId });
          }
        }
      }
    } else if (result["current-state"] === "schedule-post") {
      console.info("[Webhook] Queueing scheduled post", { requestId });
      await schedulePost(result);
      console.info("[Webhook] Scheduled post queued", { requestId });
    }

    await sendMessageBackToMe(chatId, result.report);
  } catch (error) {
    logError("Webhook processing failed", error, { requestId, updateType });
    if (chatId !== undefined) {
      await sendMessageBackToMe(
        chatId,
        "The request failed while processing. Please check the server logs or try again.",
      );
    }
  }
});

app.get("/redditCallback", async (req, res) => {
  const { code, error } = req.query;

  console.log({
    hasCode: Boolean(code),
    hasState: Boolean(req.query.state),
  });
  // ...
});
