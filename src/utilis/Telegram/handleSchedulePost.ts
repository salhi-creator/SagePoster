 
import { AIanswer } from "../../AI.js";
import type {
  ScheduledTelegramInput,
  ScheduledTelegramOutput,
  TelegramPost,
} from "../../Data-Structure/types.js";
import { sendToTelegram } from "../../Platform-ReplyHandle/sendToTelegram.js";
import { getRecentTelegramPosts, savePublishedTelegramPost } from "../../SQL_DB/connectDB.js";
import { logError } from "../logError.js";

async function handleSchedulePost(
  telegram: TelegramPost,
  topic: string | null,
): Promise<void> {
  const prompt = telegram.content?.trim();
  if (!prompt) {
    throw new Error("Scheduled Telegram post content is empty");
  }
  if (!topic?.trim()) {
    throw new Error("Scheduled Telegram post topic is required");
  }

  console.info("[Schedule:Telegram] Loading recent posts", { topic });
  const recentPosts = await getRecentTelegramPosts(topic);
  console.info("[Schedule:Telegram] Recent posts loaded", { count: recentPosts.length });
  const input: ScheduledTelegramInput = {
    topic,
    instruction: prompt,
    media: telegram.media ?? [],
    recentPosts,
  };

  const generated = (await AIanswer(
    JSON.stringify(input),
    "sheduled-telegram",
  )) as ScheduledTelegramOutput | null;
  if (
    !generated ||
    typeof generated.content !== "string" ||
    !generated.content.trim() ||
    !generated.experiment?.type
  ) {
    throw new Error("AI could not generate the scheduled Telegram post");
  }

  const telegramPost: TelegramPost = {
    enabled: true,
    content: generated.content,
    media: telegram.media ?? [],
    experiment: generated.experiment,
  };
  console.info("[Schedule:Telegram] AI generated post", {
    mediaCount: telegramPost.media?.length ?? 0,
    experimentType: telegramPost.experiment?.type,
  });
  await sendToTelegram(telegramPost);

  try {
    await savePublishedTelegramPost(topic, generated.content);
  } catch (error) {
    logError("Scheduled Telegram post sent but history save failed", error, { topic });
  }
}


export default handleSchedulePost;
