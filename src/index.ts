import express from "express";
import http from "http";
import dotenv from "dotenv";
import { sendToTelegram } from "./info/sendToTelegram.js";
import { sendToDiscord } from "./info/sendToDiscord.js";
import { AIanswer } from "./AI.js";
import { prepareTelegramPost } from "./utilis/telegramVariation.js";
import { fileURLToPath } from "url";
import { handleTelegramUpdate } from "./utilis.js";
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
  console.log("🔥🔥🔥 WEBHOOK HIT");
  // console.log("req ", req)

  try {
    // this will handle any vedios or photos save them to cloudinary and return reusable url
    const urls_included = await handleTelegramUpdate(req.body);

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
    const result = await AIanswer(message);
    console.log("AI result ", result);
    if (result?.["current-state"] === "submit") {
      if (result?.platforms.telegram.enabled) {
        const resultPost = await prepareTelegramPost(result);
        await sendToTelegram(resultPost.platforms.telegram);
      }

      /*  if (result?.platforms.reddit.enabled) {
        await sendToReddit(result.platforms.reddit);
      }*/

      if (result?.platforms.discord.enabled) {
        console.log("🚨 CALLING DISCORD");
        await sendToDiscord(result.platforms.discord);
      }
    }

    // You will handle the AI result here later
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
