import { FileReader, safeExtractJSON } from "../../utilis.js";


import {__dirname} from '../../index.js'
import path from "node:path";
import type { PostForm, AIOption as TelegramOptions  } from "../../Data-Structure/types.js";
import {  telegramReactions } from "../../Data-Structure/types.js";




export async function telegramBackMessages(message: string, option: TelegramOptions):Promise<string> {
  /*
   * TELEGRAM STRUCTURES
   */
  console.log("what type is this tele ",option)
  let msg = "";
  if (option) {
    const instructionPath = path.join(
      __dirname,
      "Prompts",
      "teleContent",
      "outputs.txt",
    );

    const instruction = await FileReader(instructionPath);

    let structureType = "";

    switch (option) {
      case "tele-button":
        structureType = "BUTTONS";
        break;

      case "tele-question":
        structureType = "QUESTION";
        break;

      case "tele-poll":
        structureType = "POLL";
        break;

      case "tele-reaction":
        structureType = "EMOJIS";
        break;
    }

    msg = `
SYSTEM INSTRUCTIONS:

${instruction}

NOW THE ACTUAL STRUCTURE TYPE IS:
${structureType}

${
  option === "tele-reaction"
    ? `AVAILABLE EMOJIS:
${telegramReactions}`
    : ""
}

USER CONTENT:
${message}
`;
  }
  return msg
}
