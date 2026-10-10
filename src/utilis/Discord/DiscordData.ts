import { AIanswer } from "../../AI.js";
import { logError } from "../logError.js";
import type { PostStyle } from "../../Data-Structure/types.js";

 async function DiscordData({
  message,
  media,
  postStyle,
}: {
  message: string;
  postStyle: PostStyle | null;
  media: {
    type: "image" | "video" | null;
    url: string | null;
  }[];
}) {
  try {
    const input = `
USER MESSAGE:
${message}

POST STYLE:
${postStyle ?? "infer from the message"}

MEDIA:
${JSON.stringify(media, null, 2)}
`;

    const res = await AIanswer(input, "discord");

    if (!res) {
      throw new Error("No data from AI");
    }

    console.info("[Discord] AI formatting completed");

    return res;
  } catch (err) {
    logError("Discord AI formatting failed", err);
    return null;
  }
}

export default DiscordData;
