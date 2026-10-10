import type { PostForm } from "./Data-Structure/types.js";
import fs from "fs-extra";
import dotenv from "dotenv";
import {
  downloadTelegramFile,
  uploadBufferToCloudinary,
} from "./utilis/cloudinary.js";
import axios from "axios";
import { logError } from "./utilis/logError.js";
dotenv.config();


let urlSend = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

/*export function safeExtractJSON(text:string,type:"object"|"array") : PostForm | null {
  try {
    // remove markdown
    text = text.replace(/```json|```/g, "").trim();

    let start = text.indexOf("{");
    let end = text.lastIndexOf("}");

    if(type === "array"){
       start = text.indexOf("[");
       end = text.lastIndexOf("]");
    }

    if (start === -1 || end === -1) return null;

    const jsonStr = text.slice(start, end + 1);

    let data = JSON.parse(jsonStr);
    return data || "something went wrong";
  } catch (err) {
    logError("AI JSON parsing failed", err, { expected: type });
    return null;
  }
}*/

export function safeExtractJSON(
  text: string,
  type: "object" | "array",
): PostForm | null {
  try {
    text = text.replace(/```json|```/g, "").trim();

    let start = text.indexOf("{");
    let end = text.lastIndexOf("}");

    if (type === "array") {
      start = text.indexOf("[");
      end = text.lastIndexOf("]");
    }

    if (start === -1 || end === -1) {
      return null;
    }

    const jsonStr = text.slice(start, end + 1);

    // First: try real JSON
    try {
      return JSON.parse(jsonStr);
    } catch {
      // AI sometimes returns JavaScript object syntax
      // instead of strict JSON.
    }

    // Convert simple JS object syntax to JSON.
    const fixed = jsonStr
      .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"');

    return JSON.parse(fixed);
  } catch (err) {
    logError("AI JSON parsing failed", err, { expected: type });

    return null;
  }
}

export async function FileReader(file: string) {
  const Insturactions = await fs.readFile(file, "utf8");

  return Insturactions;
}

const albumStore = new Map<
  string,
  {
    urls: {
      messageId: number;
      url: string;
      type: "image" | "video";
    }[];
    caption: string;
    pendingUploads: number;
    timer?: NodeJS.Timeout;
    waiters: {
      resolve: (value: MediaCheckResult) => void;
    }[];
  }
>();

type ProcessedMedia = { type: "image" | "video"; url: string };
type MediaCheckResult = { prompt: string; media: ProcessedMedia[] };

function completeAlbum(groupId: string): void {
  const album = albumStore.get(groupId);
  if (!album) return;

  if (album.pendingUploads > 0) {
    album.timer = setTimeout(() => completeAlbum(groupId), 250);
    return;
  }

  album.urls.sort((a, b) => a.messageId - b.messageId);
  const media: ProcessedMedia[] = album.urls.map(({ type, url }) => ({ type, url }));
  const mediaInfo = media
    .map((item) => `MEDIA INFO:\n\ntype: ${item.type}\n\nurl: ${item.url}`)
    .join("\n\n");
  const prompt = `NOW USER SENT MEDIA\n\n${mediaInfo}\n\nUSER TEXT CONTENT:\n${album.caption}`;

  console.info("[Media] Telegram album collected", { mediaCount: media.length });
  albumStore.delete(groupId);

  album.waiters.forEach((waiter, index) => {
    waiter.resolve(
      index === album.waiters.length - 1
        ? { prompt, media }
        : { prompt: "", media: [] },
    );
  });
}

export async function MediaCheck(update: any): Promise<MediaCheckResult> {
  const message = update.message;

  if (!message) {
    return { prompt: "", media: [] };
  }

  /*
   * =========================
   * TELEGRAM ALBUM
   * =========================
   */

  const photo = message.photo?.length
    ? message.photo[message.photo.length - 1]
    : undefined;
  const video = message.video;
  const mediaFile = photo ?? video;
  const mediaType: "image" | "video" = photo ? "image" : "video";

  if (message.media_group_id && mediaFile) {
    const groupId = message.media_group_id;
    let album = albumStore.get(groupId);

    if (!album) {
      album = {
        urls: [],
        caption: "",
        pendingUploads: 0,
        waiters: [],
      };

      albumStore.set(groupId, album);
    }

    album.pendingUploads += 1;
    let url: string;
    try {
      const buffer = await downloadTelegramFile(mediaFile.file_id);
      url = await uploadBufferToCloudinary(
        buffer,
        mediaType === "image" ? "image" : "video",
      );
    } finally {
      album.pendingUploads -= 1;
    }

    /*
     * Store the photo together with Telegram's message_id.
     * This prevents async Cloudinary uploads from changing
     * the original album order.
     */
    album.urls.push({
      messageId: message.message_id,
      url,
      type: mediaType,
    });

    /*
     * Caption is independent from the photos.
     * It is only the user's text, never part of the media data.
     */
    if (message.caption) {
      album.caption = message.caption;
    }

    /*
     * Reset the album completion timer whenever another
     * photo from the same media group arrives.
     */
    if (album.timer) {
      clearTimeout(album.timer);
    }

    const result = await new Promise<MediaCheckResult>((resolve) => {
      album!.waiters.push({ resolve });

      album!.timer = setTimeout(() => {
        completeAlbum(groupId);
      }, 1000);
    });

    return result;
  }

  /*
   * =========================
   * SINGLE PHOTO
   * =========================
   */

  if (photo) {
    const buffer = await downloadTelegramFile(photo.file_id);

    const url = await uploadBufferToCloudinary(buffer, "image");

    return {
      prompt: `NOW USER SENT MEDIA\n\nMEDIA INFO:\n\ntype: image\n\nurl: ${url}\n\nUSER TEXT CONTENT:\n${message.caption ?? ""}`,
      media: [{ type: "image", url }],
    };
  }

  /*
   * =========================
   * VIDEO
   * =========================
   */

  if (video) {
    const buffer = await downloadTelegramFile(video.file_id);

    const url = await uploadBufferToCloudinary(buffer, "video");

    return {
      prompt: `NOW USER SENT MEDIA\n\nMEDIA INFO:\n\ntype: video\n\nurl: ${url}\n\nUSER TEXT CONTENT:\n${message.caption ?? ""}`,
      media: [{ type: "video", url }],
    };
  }

  /*
   * =========================
   * TEXT ONLY
   * =========================
   */

  if (message.text) {
    return { prompt: `USER TEXT CONTENT:\n${message.text}`, media: [] };
  }

  return { prompt: "", media: [] };
}

export async  function sendMessageBackToMe(chatId: string, report: string) {
  try {
    const call = await axios.post(urlSend, {
      chat_id: chatId,
      text: `${report}`,
    });

    return;
  } catch (err) {
    logError("Telegram status reply failed", err);
    return;
  }
}
