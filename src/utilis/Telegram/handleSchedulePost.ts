 
import { AIanswer } from "../../AI.js";
import type {
  ScheduledTelegramInput,
  ScheduledTelegramOutput,
  TelegramPost,
} from "../../Data-Structure/types.js";
import { sendToTelegram } from "../../Platform-ReplyHandle/sendToTelegram.js";
import { getRecentTelegramPosts, savePublishedTelegramPost } from "../../SQL_DB/connectDB.js";

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

  const recentPosts = await getRecentTelegramPosts(topic);
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
  await sendToTelegram(telegramPost);

  try {
    await savePublishedTelegramPost(topic, generated.content);
  } catch (error) {
    console.error("Scheduled post sent, but history could not be saved:", error);
  }
}


export default handleSchedulePost;
