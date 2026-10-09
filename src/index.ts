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



app.post("/webhook", async (req, res) => {
  console.log("📢 Channel:", req.body?.channel_post?.chat);
  // Telegram needs a quick response
  res.sendStatus(200);

  // You will handle the AI result here later

  console.log("🔥🔥🔥 WEBHOOK HIT");
  // console.log("req ", req);
  let chatId = req.body?.message?.chat?.id;
  console.log("MY ID", chatId);
  let result: PostForm;
  try {
    // this will handle any vedios or photos save them to cloudinary and return reusable url

    // this func checks any Images , Vedios been sent
    const urls_included = await MediaCheck(req.body);

    let message = req.body?.message?.text;
    // Ignore updates that don't contain a text message
    if (!message) {
      message = urls_included;
      if (message === undefined || message?.trim() === "") {
        return;
      }
    }

    console.log("Received message:", message);

    // Send the received message to your AI function
    result = await AIanswer(message);
    console.log("AI result ", result);

    if (!result) return res.status(500);
    if (result["current-state"] === "submit") {
      if (result.platforms.telegram?.enabled) {
        const resultPost = await prepareTelegramPost(result);
        const telegramPost = resultPost?.platforms.telegram;
        if (telegramPost) {
          await sendToTelegram(telegramPost);
          if (result.topic && telegramPost.content) {
            try {
              await savePublishedTelegramPost(result.topic, telegramPost.content);
            } catch (error) {
              console.error("Telegram post sent, but history could not be saved:", error);
            }
          }
        }
      }

      /*  if (result?.platforms.reddit.enabled) {
        await sendToReddit(result.platforms.reddit);
      }*/

      if (result.platforms.discord?.enabled) {
        console.log("🚨 CALLING DISCORD");
        await sendToDiscord(result.platforms?.discord);
        if (result.topic && result.platforms.discord.content) {
          try {
            await savePublishedDiscordPost(
              result.topic,
              result.platforms.discord.content,
            );
          } catch (error) {
            console.error("Discord post sent, but history could not be saved:", error);
          }
        }
      }
    } else if (result["current-state"] === "schedule-post") {
      await schedulePost(result);
    }

    await sendMessageBackToMe(chatId, result.report);
  } catch (error) {
    console.error("Webhook / AI error:", error);
  }
});

app.get("/redditCallback", async (req, res) => {
  console.log("🔥 REDDIT CALLBACK QUERY:");
  console.log(req.query);

  const { code, error } = req.query;

  console.log({
    hasCode: Boolean(code),
    state: req.query.state,
  });
  // ...
});
