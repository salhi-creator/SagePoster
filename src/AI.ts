import { FileReader, safeExtractJSON } from "./utilis.js";
import { groq } from "./AIModels/Groq.js";
import { gemini } from "./AIModels/Gemini.js";
// import { mistral } from "./AIModels/mistral.js";

import { __dirname } from "./index.js";
import path from "path";

import type { PostForm, AIOption as TelegramOptions } from "./Data-Structure/types.js";
import { telegramBackMessages } from "./utilis/Telegram/telegramBackMessages.js";
import  discordBackMessages  from "./utilis/Discord/discordBackMessages.js";
let msg = "";

export async function AIanswer(
  message: string,
  option?: TelegramOptions,
): Promise<PostForm | any | object | null> {
  const returnDataType =
    option === "tele-button" || option === "tele-reaction" ? "array" : "object";

  if (option && option.startsWith("tele")) {
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
    const instructionPath = path.join(__dirname, "info", "instruction.txt");

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

  // Gemini
  try {
    const res = await gemini(msg);

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
    const res = await groq(msg);

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
