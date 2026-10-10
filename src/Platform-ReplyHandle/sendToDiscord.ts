import axios from "axios";
import DiscordData from "../utilis/Discord/DiscordData.js";
import { logError } from "../utilis/logError.js";

export async function sendToDiscord(content?: {
  enabled: boolean;
  content: string;
  media?: { type: "image" | "video" | null; url: string | null }[];
}) {
  if (!content || !content.enabled) return;

  if (!process.env.DISCORD_WEBHOOK_URL) {
    throw new Error("DISCORD_WEBHOOK_URL is missing");
  }

  console.info("[Discord] Preparing post", {
    mediaCount: content.media?.length ?? 0,
  });

  const payload = await DiscordData({
    message: content.content,
    media: content.media ?? [],
  });

  if (!payload) throw new Error("Discord formatter returned no payload");
  return sendDiscordPayload(payload);
}

export async function sendDiscordPayload(payload: Record<string, unknown>) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error("DISCORD_WEBHOOK_URL is missing");

  try {
    const response = await axios.post(webhook, payload);
    console.info("[Discord] Webhook accepted post", { status: response.status });
    return response.data;
  } catch (error) {
    logError("Discord webhook failed", error, {
      httpStatus: axios.isAxiosError(error) ? error.response?.status : undefined,
    });
    throw error;
  }
}
