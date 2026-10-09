import { FileReader } from "../../utilis.js";
import path from "path";
import { __dirname } from "../../index.js";

let msg = "";

 async function discordBackMessages(message: string): Promise<string> {
  /*
   * TELEGRAM STRUCTURES
   */
  const instructionPath = path.join(
    __dirname,
    "Prompts",
    "discordContent",
    "outputs.txt",
  );

  const instruction = await FileReader(instructionPath);

  msg = `
            SYSTEM INSTRUCTIONS:

            ${instruction}

            NOW USER SAYS:

            ${message}
            `;

  return msg;
}


export default discordBackMessages
