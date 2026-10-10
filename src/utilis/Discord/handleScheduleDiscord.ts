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
import { logError } from "../logError.js";
import type { PostStyle } from "../../Data-Structure/types.js";

async function handleScheduleDiscord(
  discord: DiscordPost,
  topic: string | null,
  postStyle: PostStyle | null,
): Promise<void> {
  const instruction = discord.content.trim();
  if (!instruction) {
    throw new Error("Scheduled Discord post content is empty");
  }
  if (!topic?.trim()) {
    throw new Error("Scheduled Discord post topic is required");
  }

  console.info("[Schedule:Discord] Loading recent posts", { topic });
  const recentPosts = await getRecentDiscordPosts(topic);
  console.info("[Schedule:Discord] Recent posts loaded", { count: recentPosts.length });
  const input: ScheduledDiscordInput = {
    topic,
    instruction,
    postStyle,
    media: discord.media ?? [],
    recentPosts,
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
  console.info("[Schedule:Discord] Post delivered");

  try {
    await savePublishedDiscordPost(topic, generated.historyText);
  } catch (error) {
    logError("Scheduled Discord post sent but history save failed", error, { topic });
  }
}

export default handleScheduleDiscord;
