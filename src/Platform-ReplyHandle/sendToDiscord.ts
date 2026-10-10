import axios from "axios";
import DiscordData from "../utilis/Discord/DiscordData.js";
import { logError } from "../utilis/logError.js";
import type { PostStyle } from "../Data-Structure/types.js";

const DEFAULT_POLL_DURATION_HOURS = 24;
const MAX_POLL_DURATION_HOURS = 720;

function normalizeDiscordPoll(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const poll = value as Record<string, unknown>;
  const question = poll.question as { text?: unknown } | undefined;
  const answers = poll.answers;
  if (
    typeof question?.text !== "string" ||
    !question.text.trim() ||
    question.text.length > 300 ||
    !Array.isArray(answers) ||
    answers.length < 2 ||
    answers.length > 10 ||
    answers.some((answer) => {
      if (!answer || typeof answer !== "object") return true;
      const media = (answer as { poll_media?: { text?: unknown } }).poll_media;
      return (
        typeof media?.text !== "string" ||
        !media.text.trim() ||
        media.text.length > 55
      );
    })
  ) {
    throw new Error("Cannot send Discord poll: expected a question and 2–10 answers (max 55 characters each)");
  }

  const requestedDuration = poll.duration;
  const duration =
    typeof requestedDuration === "number" && Number.isFinite(requestedDuration)
      ? Math.min(MAX_POLL_DURATION_HOURS, Math.max(1, Math.round(requestedDuration)))
      : DEFAULT_POLL_DURATION_HOURS;

  return { ...poll, duration };
}

export async function sendToDiscord(
  content?: {
    enabled: boolean;
    content: string;
    media?: { type: "image" | "video" | null; url: string | null }[];
  },
  postStyle: PostStyle | null = null,
) {
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
    postStyle,
  });

  if (!payload) throw new Error("Discord formatter returned no payload");
  return sendDiscordPayload(payload, content.media ?? []);
}

export async function sendDiscordPayload(
  payload: Record<string, unknown>,
  media: { type: "image" | "video" | null; url: string | null }[] = [],
) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error("DISCORD_WEBHOOK_URL is missing");

  const imageUrls = media
    .filter((item) => item.type === "image" && item.url)
    .map((item) => item.url as string);
  const videoUrls = media
    .filter((item) => item.type === "video" && item.url)
    .map((item) => item.url as string);
  const embeds = Array.isArray(payload.embeds)
    ? payload.embeds.filter(
        (embed): embed is Record<string, unknown> =>
          Boolean(embed) && typeof embed === "object" && !Array.isArray(embed),
      )
    : [];
  const files: { filename: string; blob: Blob }[] = [];

  // Discord renders multiple webhook file attachments together in one
  // message. Separate image embeds look like separate cards, so use files.
  for (const [index, url] of imageUrls.entries()) {
    try {
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: 60_000,
        maxContentLength: 25 * 1024 * 1024,
      });
      const contentType = String(response.headers["content-type"] ?? "image/jpeg")
        .split(";")[0]
        ?.trim() ?? "image/jpeg";
      const extByType: Record<string, string> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
      };
      const ext = extByType[contentType] ?? "jpg";
      const filename = `image-${index + 1}.${ext}`;
      files.push({
        filename,
        blob: new Blob([new Uint8Array(response.data)], { type: contentType }),
      });
    } catch (error) {
      logError("Discord image download failed", error, { imageIndex: index + 1 });
      throw new Error(`Could not download Discord image ${index + 1}`, { cause: error });
    }
  }

  if (files.length > 0) {
    // Uploaded files replace any AI-generated image URLs to avoid duplicates.
    for (const embed of embeds) {
      delete embed.image;
      delete embed.thumbnail;
    }
  }

  const mediaLinks = videoUrls;
  const existingContent = typeof payload.content === "string" ? payload.content : "";
  const additionalLinks = mediaLinks.filter((url) => !existingContent.includes(url));
  const normalizedPoll = normalizeDiscordPoll(payload.poll);
  const finalizedPayload: Record<string, unknown> = {
    ...payload,
    ...(normalizedPoll ? { poll: normalizedPoll } : {}),
    ...(embeds.length > 0 ? { embeds } : {}),
    ...(files.length > 0
      ? { attachments: files.map((file, id) => ({ id, filename: file.filename })) }
      : {}),
    ...(additionalLinks.length > 0
      ? { content: [existingContent, ...additionalLinks].filter(Boolean).join("\n") }
      : {}),
  };

  try {
    let requestBody: Record<string, unknown> | FormData = finalizedPayload;
    if (files.length > 0) {
      const formData = new FormData();
      formData.append("payload_json", JSON.stringify(finalizedPayload));
      files.forEach((file, index) => {
        formData.append(`files[${index}]`, file.blob, file.filename);
      });
      requestBody = formData;
    }

    const response = await axios.post(webhook, requestBody, {
      timeout: 120_000,
    });
    console.info("[Discord] Webhook accepted post", {
      status: response.status,
      attachedImageCount: files.length,
      videoLinkCount: videoUrls.length,
    });
    return response.data;
  } catch (error) {
    logError("Discord webhook failed", error, {
      httpStatus: axios.isAxiosError(error) ? error.response?.status : undefined,
    });
    throw error;
  }
}
