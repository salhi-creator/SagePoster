import { FileReader, safeExtractJSON } from "./utilis.js";
import { groq } from "./AIModels/Groq.js";
import { gemini } from "./AIModels/Gemini.js";
// import { mistral } from "./AIModels/mistral.js";

import { __dirname } from "./index.js";
import path from "path";

import type { AIOption as TelegramOptions, PostForm } from "./Data-Structure/types.js";
import { telegramBackMessages } from "./utilis/Telegram/telegramBackMessages.js";
import  discordBackMessages  from "./utilis/Discord/discordBackMessages.js";
import { logError } from "./utilis/logError.js";

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
  } else if (option && option.startsWith("discord")) {
    console.log("discord reqesut AI")
    msg = await discordBackMessages(message);

  } else {
    /*
     * NORMAL POST PLANNER
     */
    const instructionPath = path.join(__dirname, "Prompts", "instruction.txt");

    const instruction = await FileReader(instructionPath);

    msg = `
      SYSTEM INSTRUCTIONS:

      ${instruction}

      USER SAYS:
      ${message}
      `;
  }

  const providerKeys = getProviderKeys(option, message);
  const route = providerKeys.platform ?? "shared planner keys";
  console.info("[AI] Request started", { option: option ?? "planner", route });

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
    if (parsed) {
      console.info("[AI] Gemini request succeeded", { route });
      return parsed;
    }
    console.warn("[AI] Gemini returned unparseable output", { route });
  } catch (err) {
    logError("Gemini request failed", err, { route });
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
    if (parsed) {
      console.info("[AI] Groq request succeeded", { route });
      return parsed;
    }
    console.warn("[AI] Groq returned unparseable output", { route });
  } catch (err) {
    logError("Groq request failed", err, { route });
  }

  console.error("[AI] All configured providers failed", { route, option });
  return null;
}
