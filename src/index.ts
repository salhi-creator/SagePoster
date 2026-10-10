import express from "express";
import http from "http";
import dotenv from "dotenv";
import { sendToTelegram } from "./Platform-ReplyHandle/sendToTelegram.js";
import { sendToDiscord } from "./Platform-ReplyHandle/sendToDiscord.js";
import { AIanswer } from "./AI.js";
import prepareTelegramPost from "./utilis/Telegram/prepareTelegramPost.js";
import { fileURLToPath } from "url";
import { MediaCheck, sendMessageBackToMe } from "./utilis.js";
import { schedulePost } from "./queues/postWorker.js";
import { randomUUID } from "node:crypto";
import { logError } from "./utilis/logError.js";
import {
  savePublishedDiscordPost,
  savePublishedTelegramPost,
} from "./SQL_DB/connectDB.js";
import type {
  PostForm,
} from "./Data-Structure/types.js";

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
  let chatId = req.body?.message?.chat?.id;
  let result: PostForm;
  try {
    // this will handle any vedios or photos save them to cloudinary and return reusable url

    // this func checks any Images , Vedios been sent
    const urls_included = await MediaCheck(req.body);
    console.info("[Webhook] Media processing complete", { requestId });

    let message = req.body?.message?.text;
    // Ignore updates that don't contain a text message
    if (!message) {
      message = urls_included;
      if (message === undefined || message?.trim() === "") {
        return;
      }
    }

    console.info("[Webhook] Sending input to planner", { requestId });

    // Send the received message to your AI function
    result = await AIanswer(message);
    if (!result) {
      console.error("[Webhook] Planner returned no result", { requestId });
      if (chatId !== undefined) {
        await sendMessageBackToMe(chatId, "I could not process that request. Please try again.");
      }
      return;
    }
    console.info("[Webhook] Planner completed", {
      requestId,
      state: result["current-state"],
      telegramEnabled: result.platforms.telegram?.enabled ?? false,
      discordEnabled: result.platforms.discord?.enabled ?? false,
    });

    if (result["current-state"] === "submit") {
      if (result.platforms.telegram?.enabled) {
        const resultPost = await prepareTelegramPost(result);
        const telegramPost = resultPost?.platforms.telegram;
        if (telegramPost) {
          await sendToTelegram(telegramPost);
          console.info("[Webhook] Telegram publish succeeded", { requestId });
          if (result.topic && telegramPost.content) {
            try {
              await savePublishedTelegramPost(result.topic, telegramPost.content);
            } catch (error) {
              logError("Telegram history save failed", error, { requestId });
            }
          }
        }
      }

      /*  if (result?.platforms.reddit.enabled) {
        await sendToReddit(result.platforms.reddit);
      }*/

      if (result.platforms.discord?.enabled) {
        await sendToDiscord(result.platforms?.discord);
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
      await sendMessageBackToMe(chatId, "The request failed while processing. Please check the server logs or try again.");
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
