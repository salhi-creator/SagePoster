import type { PostForm } from "./Data-Structure/types.js";
import fs from "fs-extra";
import dotenv from "dotenv";
import {
  downloadTelegramFile,
  uploadBufferToCloudinary,
} from "./utilis/cloudinary.js";
import axios from "axios";
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
    console.log("JSON parse failed:", err);
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
    console.log("JSON parse failed:", err);
    console.log("Raw text:", text);

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
    timer?: NodeJS.Timeout;
    waiters: {
      resolve: (value: string) => void;
    }[];
  }
>();

export async function MediaCheck(update: any) {
  const message = update.message;

  if (!message) {
    return "";
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
    const buffer = await downloadTelegramFile(mediaFile.file_id);
    const url = await uploadBufferToCloudinary(
      buffer,
      mediaType === "image" ? "image" : "video",
    );

    let album = albumStore.get(groupId);

    if (!album) {
      album = {
        urls: [],
        caption: "",
        waiters: [],
      };

      albumStore.set(groupId, album);
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

    const result = await new Promise<string>((resolve) => {
      album!.waiters.push({ resolve });

      album!.timer = setTimeout(() => {
        const currentAlbum = albumStore.get(groupId);

        if (!currentAlbum) {
          resolve("");
          return;
        }

        /*
         * Restore Telegram's original album order.
         */
        currentAlbum.urls.sort((a, b) => a.messageId - b.messageId);

        console.log(
          `📸 TELEGRAM ALBUM COMPLETE: ${currentAlbum.urls.length} images`,
        );

        console.log(
          "📸 ALBUM URLS:",
          currentAlbum.urls.map((item) => item.url),
        );

        /*
         * Create media information ONLY from the URLs.
         * Caption is added separately below.
         */
        const mediaInfo = currentAlbum.urls
          .map(
            (item) => `
MEDIA INFO:

type: ${item.type}

url: ${item.url}
`,
          )
          .join("\n");

        const finalMessage = `
NOW USER SENT MEDIA

${mediaInfo}

USER TEXT CONTENT:
${currentAlbum.caption}
`;

        albumStore.delete(groupId);

        const waiters = currentAlbum.waiters;

        waiters.forEach((waiter, index) => {
          if (index === waiters.length - 1) {
            waiter.resolve(finalMessage);
          } else {
            // Only one webhook update should trigger AI generation for an album.
            waiter.resolve("");
          }
        });
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

    return `
NOW USER SENT MEDIA

MEDIA INFO:

type: image

url: ${url}

USER TEXT CONTENT:
${message.caption ?? ""}
`;
  }

  /*
   * =========================
   * VIDEO
   * =========================
   */

  if (video) {
    const buffer = await downloadTelegramFile(video.file_id);

    const url = await uploadBufferToCloudinary(buffer, "video");

    return `
NOW USER SENT MEDIA

MEDIA INFO:

type: video

url: ${url}

USER TEXT CONTENT:
${message.caption ?? ""}
`;
  }

  /*
   * =========================
   * TEXT ONLY
   * =========================
   */

  if (message.text) {
    return `
USER TEXT CONTENT:
${message.text}
`;
  }

  return "";
}

export async  function sendMessageBackToMe(chatId: string, report: string) {
  try {
    const call = await axios.post(urlSend, {
      chat_id: chatId,
      text: `${report}`,
    });

    return;
  } catch (err) {
    console.error("WEBHOOK ERROR | SEND MESSAGE BACK ERROR:", err);
    return;
  }
}
