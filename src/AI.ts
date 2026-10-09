import { FileReader, safeExtractJSON } from "./utilis.js";
import { groq } from "./AIModels/Groq.js";
import { gemini } from "./AIModels/Gemini.js";
// import { mistral } from "./AIModels/mistral.js";

import { __dirname } from "./index.js";
import path from "path";

import type { AIOption as TelegramOptions, PostForm } from "./Data-Structure/types.js";
import { telegramBackMessages } from "./utilis/Telegram/telegramBackMessages.js";
import  discordBackMessages  from "./utilis/Discord/discordBackMessages.js";

type AIPlatform = "TELEGRAM" | "DISCORD" | "REDDIT" | "LINKEDIN";
const AI_PLATFORMS: AIPlatform[] = ["TELEGRAM", "DISCORD", "REDDIT", "LINKEDIN"];
let nextUnscopedPlatform = 0;

function platformForOption(option?: TelegramOptions): AIPlatform | undefined {
  if (option === "sheduled-telegram" || option?.startsWith("tele")) {
    return "TELEGRAM";
  }
  if (option === "scheduled-discord" || option === "discord") {
    return "DISCORD";
  }
  if (option === "reddit") return "REDDIT";
  if (option === "linkedin") return "LINKEDIN";
  return undefined;
}

function platformMentionedInMessage(message: string): AIPlatform | undefined {
  const mentions = [
    { platform: "TELEGRAM" as const, index: message.search(/\btelegram\b/i) },
    { platform: "DISCORD" as const, index: message.search(/\bdiscord\b/i) },
    { platform: "REDDIT" as const, index: message.search(/\breddit\b/i) },
    { platform: "LINKEDIN" as const, index: message.search(/\blinked\s?in\b/i) },
  ].filter((mention) => mention.index >= 0);

  mentions.sort((a, b) => a.index - b.index);
  return mentions[0]?.platform;
}

function platformForRequest(option: TelegramOptions | undefined, message: string) {
  const optionPlatform = platformForOption(option);
  if (optionPlatform) return optionPlatform;

  const mentionedPlatform = platformMentionedInMessage(message);
  if (mentionedPlatform) return mentionedPlatform;

  // The initial planner has no selected platform yet. Spread those requests
  // across configured platform keys until the AI determines the destinations.
  const configuredPlatforms = AI_PLATFORMS.filter(
    (platform) =>
      process.env[`GEMINI_${platform}_API_KEY`] ||
      process.env[`GROQ_${platform}_API_KEY`],
  );
  if (!configuredPlatforms.length) return undefined;

  const platform = configuredPlatforms[nextUnscopedPlatform % configuredPlatforms.length];
  nextUnscopedPlatform += 1;
  return platform;
}

function getProviderKeys(option: TelegramOptions | undefined, message: string) {
  const platform = platformForRequest(option, message);
  return {
    platform,
    gemini:
      (platform && process.env[`GEMINI_${platform}_API_KEY`]) ||
      process.env.GEMINI_API_KEY,
    groq:
      (platform && process.env[`GROQ_${platform}_API_KEY`]) ||
      process.env.GROQ_API_KEY,
  };
}

export async function AIanswer(
  message: string,
  option?: TelegramOptions,
): Promise<PostForm | any | object | null> {
  let msg = "";
  const returnDataType =
    option === "tele-button" || option === "tele-reaction" ? "array" : "object";

  if (option === "sheduled-telegram") {
    const promptPath = path.join(__dirname, "Prompts", "scheduledTelegram.txt");
    const instruction = await FileReader(promptPath);
    msg = `
SCHEDULED TELEGRAM PROMPT:
${instruction}

SCHEDULED TELEGRAM INPUT (JSON):
${message}
`;
  } else if (option === "scheduled-discord") {
    const promptPath = path.join(__dirname, "Prompts", "scheduledDiscord.txt");
    const instruction = await FileReader(promptPath);
    msg = `
SCHEDULED DISCORD PROMPT:
${instruction}

SCHEDULED DISCORD INPUT (JSON):
${message}
`;
  } else if (option && option.startsWith("tele")) {
    console.log("the option is ", option);
    msg = await telegramBackMessages(message, option);
    console.log("message is tele : ", msg);
  } else if (option && option.startsWith("discord")) {
    console.log("discord reqesut AI")
    msg = await discordBackMessages(message);
        console.log("discord msg",msg)

  } else {
    /*
     * NORMAL POST PLANNER
     */
    console.log("here the general : ", msg);
    const instructionPath = path.join(__dirname, "Prompts", "instruction.txt");

    const instruction = await FileReader(instructionPath);

    msg = `
      SYSTEM INSTRUCTIONS:

      ${instruction}

      USER SAYS:
      ${message}
      `;
  }

  console.log("🤖 AI OPTION:", option);
  console.log("📐 AI RETURN TYPE:", returnDataType);
  console.log("📝 AI PROMPT:", msg);

  const providerKeys = getProviderKeys(option, message);
  console.log("AI platform route:", providerKeys.platform ?? "shared planner keys");

  // Gemini
  try {
    const geminiKey = providerKeys.gemini;
    if (!geminiKey) {
      throw new Error("Gemini API key is not configured for this request");
    }
    const res = await gemini(msg, geminiKey);

    if (!res) {
      throw new Error("no data from AI");
    }

    const parsed = safeExtractJSON(res, returnDataType);
    console.log("WHAT HAVE YOU RETURNED ", parsed);

    if (parsed) {
      return parsed;
    }
  } catch (err) {
    console.log("Gemini failed:", err);
  }

  // Groq
  try {
    const groqKey = providerKeys.groq;
    if (!groqKey) {
      throw new Error("Groq API key is not configured for this request");
    }
    const res = await groq(msg, groqKey);

    if (!res) {
      throw new Error("no data from AI");
    }

    const parsed = safeExtractJSON(res, returnDataType);
    console.log("WHAT HAVE YOU RETURNED ", parsed);

    if (parsed) {
      return parsed;
    }
  } catch (err) {
    console.log("Groq failed:", err);
  }

  return null;
}
