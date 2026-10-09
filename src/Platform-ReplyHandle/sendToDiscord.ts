import axios from "axios";
import  DiscordData  from "../utilis/Discord/DiscordData.js";

export async function sendToDiscord(content?: {
  enabled: boolean;
  content: string;
  media?: {
    type: "image" | "video" | null;
    url: string | null;
  }[];
}) {
  if ( !content || !content.enabled ) return;

  const webhook = process.env.DISCORD_WEBHOOK_URL;

  if (!webhook) {
    throw new Error("DISCORD_WEBHOOK_URL is missing");
  }

  console.log("🟡 DISCORD: starting formatter");
  console.log("discord params", content);

  const Data = await DiscordData({
    message: content.content,
    media: content.media ?? [],
  });

  console.log("discord Data", Data);

  return sendDiscordPayload(Data);
}

export async function sendDiscordPayload(payload: Record<string, unknown>) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    throw new Error("DISCORD_WEBHOOK_URL is missing");
  }

  try {
    const response = await axios.post(webhook, payload);

    console.log("✅ Discord post sent:", response.status);
    console.log("🟢 DISCORD: webhook finished", response.status);
    return response.data;

  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        "❌ Discord webhook error:",
        error.response?.status,
        error.response?.data,
      );
    }

    throw error;
  }
}
