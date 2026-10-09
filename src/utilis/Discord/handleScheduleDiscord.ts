import { AIanswer } from "../../AI.js";
import type {
  DiscordPost,
  ScheduledDiscordInput,
  ScheduledDiscordOutput,
} from "../../Data-Structure/types.js";
import { sendDiscordPayload } from "../../Platform-ReplyHandle/sendToDiscord.js";
import {
  getRecentDiscordPosts,
  savePublishedDiscordPost,
} from "../../SQL_DB/connectDB.js";

async function handleScheduleDiscord(
  discord: DiscordPost,
  topic: string | null,
): Promise<void> {
  const instruction = discord.content.trim();
  if (!instruction) {
    throw new Error("Scheduled Discord post content is empty");
  }
  if (!topic?.trim()) {
    throw new Error("Scheduled Discord post topic is required");
  }

  const input: ScheduledDiscordInput = {
    topic,
    instruction,
    media: discord.media ?? [],
    recentPosts: await getRecentDiscordPosts(topic),
  };
  const generated = (await AIanswer(
    JSON.stringify(input),
    "scheduled-discord",
  )) as ScheduledDiscordOutput | null;

  if (
    !generated ||
    typeof generated.historyText !== "string" ||
    !generated.historyText.trim() ||
    !generated.payload ||
    typeof generated.payload !== "object" ||
    (!generated.payload.content &&
      !(Array.isArray(generated.payload.embeds) && generated.payload.embeds.length))
  ) {
    throw new Error("AI could not generate a valid scheduled Discord post");
  }

  await sendDiscordPayload(generated.payload);

  try {
    await savePublishedDiscordPost(topic, generated.historyText);
  } catch (error) {
    console.error("Scheduled Discord post sent, but history could not be saved:", error);
  }
}

export default handleScheduleDiscord;
