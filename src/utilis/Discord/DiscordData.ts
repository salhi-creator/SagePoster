import path from "path";
import { FileReader, safeExtractJSON } from "../../utilis.js";
import { AIanswer } from "../../AI.js";
import { __dirname } from "../../index.js";

 async function DiscordData({
  message,
  media,
}: {
  message: string;
  media: {
    type: "image" | "video" | null;
    url: string | null;
  }[];
}) {
  try {
    const input = `
USER MESSAGE:
${message}

MEDIA:
${JSON.stringify(media, null, 2)}
`;

    const res = await AIanswer(input, "discord");

    console.log("discord data ", res);

    if (!res) {
      throw new Error("No data from AI");
    }

    console.log("========== RAW AI RESPONSE ==========");
    console.log(res);
    console.log("=====================================");

    return res;
  } catch (err) {
    console.error("Discord AI error:", err);
    return null;
  }
}

export default DiscordData;
