import axios from "axios";
import type { TelegramPost } from "../Data-Structure/types.js";
import { logError } from "../utilis/logError.js";

const imageExtensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

async function downloadMediaFile(url: string, index: number) {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 60_000,
      maxContentLength: 50 * 1024 * 1024,
    });
    const contentType = String(response.headers["content-type"] ?? "application/octet-stream")
      .split(";")[0]
      ?.trim() ?? "application/octet-stream";
    const ext = imageExtensions[contentType] ?? (contentType === "video/mp4" ? "mp4" : "bin");

    return {
      filename: `media-${index + 1}.${ext}`,
      blob: new Blob([new Uint8Array(response.data)], { type: contentType }),
    };
  } catch (error) {
    logError("Telegram media download failed", error, { mediaIndex: index + 1 });
    throw error;
  }
}

export async function sendToTelegram(post: TelegramPost ): Promise<void> {




  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.SAGEHUB_CHAT_ID;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing");
  }

  if (!chatId) {
    throw new Error("TELEGRAM_CHANNEL_ID is missing");
  }






  const api = `https://api.telegram.org/bot${token}`;

  // ==========================================
  // GLOBAL REQUEST VARIABLES
  // ==========================================

  let endpoint = "sendMessage";

  const body: Record<string, any> = {
    chat_id: chatId,
  };

  let result: any;

  const experimentType = post.experiment?.type;
  console.info("[Telegram] Delivery started", {
    experimentType: experimentType ?? "none",
    mediaCount: post.media?.length ?? 0,
  });

  // ==========================================
  // PREPARE BODY DEPENDING ON EXPERIMENT
  // ==========================================

  // ------------------------------------------
  // POLL
  // ------------------------------------------

  if (experimentType === "poll") {
    endpoint = "sendPoll";

    if (
      post.experiment?.type !== "poll" ||
      typeof post.experiment.question !== "string" ||
      !post.experiment.question.trim() ||
      post.experiment.question.length > 300 ||
      !Array.isArray(post.experiment.options) ||
      post.experiment.options.length < 2 ||
      post.experiment.options.length > 12 ||
      post.experiment.options.some(
        (option) =>
          typeof option !== "string" || !option.trim() || option.length > 100,
      )
    ) {
      throw new Error("Cannot send Telegram poll: question and 2–12 non-empty options are required");
    }

    body.question = post.experiment?.question;
    body.options = post.experiment?.options;
    const requestedHours =
      post.experiment?.type === "poll" ? post.experiment.durationHours : undefined;
    const durationHours = Number.isFinite(requestedHours)
      ? Math.min(720, Math.max(1, Math.round(requestedHours as number)))
      : 24;
    body.open_period = durationHours * 60 * 60;
    body.is_anonymous = post.experiment?.is_anonymous ?? true;
  }

  // ------------------------------------------
  // QUESTION
  // ------------------------------------------
  else if (experimentType === "question") {
    endpoint = "sendMessage";

    body.text = post.experiment?.question;
  }

  // ------------------------------------------
  // BUTTONS
  // ------------------------------------------
  else if (experimentType === "buttons") {
    endpoint = "sendMessage";

    body.text = post.content;
    const buttons =
      post.experiment?.type === "buttons" ? post.experiment.buttons : [];
    const inlineKeyboard = Array.from(
      { length: Math.ceil(buttons.length / 2) },
      (_, row) => buttons.slice(row * 2, row * 2 + 2),
    );

    if (inlineKeyboard.length > 0) {
      body.reply_markup = { inline_keyboard: inlineKeyboard };
    } else {
      console.warn("[Telegram] No buttons returned; sending post without keyboard");
    }
  }

  // ------------------------------------------
  // REACTION
  // ------------------------------------------
  else if (experimentType === "reaction") {
    /*
     * Reaction itself is sent later because Telegram
     * needs a message_id first.
     *
     * So we first prepare a normal message.
     */

    endpoint = "sendMessage";

    body.text = post.content;
  }

  // ------------------------------------------
  // NORMAL MESSAGE
  // ------------------------------------------
  else {
    endpoint = "sendMessage";

    body.text = post.content;
  }

  // ==========================================
  // SEND MEDIA
  // ==========================================

  // ==========================================
  // SEND MEDIA
  // ==========================================

  const mediaResults: any[] = [];
  const specialMessage = ["poll", "question", "buttons", "reaction"].includes(
    experimentType ?? "",
  );
  // Buttons and reactions send the post text as a separate Telegram message,
  // so don't repeat the same text as the media caption.
  const textSentSeparately = ["buttons", "reaction"].includes(experimentType ?? "");
  // Telegram rejects captions longer than 1,024 characters. Send long text as
  // a normal message after the media instead of losing the entire album.
  const mediaCaption =
    post.content && post.content.length <= 1024 && !textSentSeparately
      ? post.content
      : undefined;

  if (post.media?.length > 0) {
    const validMedia = post.media.filter(
      (item): item is { type: "image" | "video"; url: string } =>
        Boolean(item?.url && (item.type === "image" || item.type === "video")),
    );

    // ----------------------------------------
    // MULTIPLE MEDIA → ALBUM
    // ----------------------------------------

    if (validMedia.length > 1) {
      console.info("[Telegram] Sending media group", { mediaCount: validMedia.length });


      const mediaFiles = await Promise.all(
        validMedia.map((item: any, index: number) => downloadMediaFile(item.url, index)),
      );
      const media = validMedia.map((item: any, index: number) => ({
        type: item.type === "video" ? "video" : "photo",
        media: `attach://file${index}`,
        ...(index === 0 && mediaCaption ? { caption: mediaCaption } : {}),
      }));
      const formData = new FormData();
      formData.append("chat_id", String(chatId));
      formData.append("media", JSON.stringify(media));
      mediaFiles.forEach((file, index) => {
        formData.append(`file${index}`, file.blob, file.filename);
      });

      try {
        const response = await axios.post(
          `${api}/sendMediaGroup`,
          formData,
          {
            timeout: 500000,
          },
        );

        console.info("[Telegram] Media group accepted", {
          count: Array.isArray(response.data.result) ? response.data.result.length : 0,
        });

        if (!response.data.ok) {
          throw new Error(
            `Telegram media group error: ${response.data.description}`,
          );
        }

        mediaResults.push(...response.data.result);


      } catch (error: any) {
        logError("Telegram media group failed", error, {
          httpStatus: error.response?.status,
          mediaCount: media.length,
        });
        throw error;
      }
    }

    // ----------------------------------------
    // ONE MEDIA
    // ----------------------------------------
    else if (validMedia.length === 1) {
      const media = validMedia[0];
      if (!media) throw new Error("Telegram media item is missing");
      console.info("[Telegram] Sending single media", { type: media?.type });



      const mediaEndpoint = media?.type === "video" ? "sendVideo" : "sendPhoto";
      const mediaFile = await downloadMediaFile(media.url, 0);
      const mediaBody = new FormData();
      mediaBody.append("chat_id", String(chatId));
      mediaBody.append(
        mediaEndpoint === "sendVideo" ? "video" : "photo",
        mediaFile.blob,
        mediaFile.filename,
      );
      if (mediaCaption) mediaBody.append("caption", mediaCaption);

      const mediaResponse = await axios.post(
        `${api}/${mediaEndpoint}`,
        mediaBody,
      );

      const mediaResult = mediaResponse.data;

      if (!mediaResult.ok) {
        throw new Error(`Telegram media error: ${mediaResult.description}`);
      }

      mediaResults.push(mediaResult);


    }
  }

  // ==========================================
  // SEND MAIN BODY ONLY WHEN NEEDED
  // ==========================================

  const hasMedia = mediaResults.length > 0;

  const needsSeparateMessage =
    !hasMedia ||
    (Boolean(post.content) && !mediaCaption && !specialMessage) ||
    experimentType === "poll" ||
    experimentType === "question" ||
    experimentType === "buttons" ||
    experimentType === "reaction";

  if (needsSeparateMessage) {
    console.info("[Telegram] Sending main message", { experimentType: experimentType ?? "none" });


    const response = await axios.post(`${api}/${endpoint}`, body);

    result = response.data;



    if (!result.ok) {
      throw new Error(
        `Telegram ${experimentType ?? "message"} error: ${result.description}`,
      );
    }
  }

  // ==========================================
  // SEND MAIN BODY
  // ==========================================

  /*
   * The media loop is finished.
   *
   * Now send the experiment/message ONCE.
   */



  // const response = await axios.post(`${api}/${endpoint}`, body);

  // result = response.data;



  if (result && !result.ok) {
    throw new Error(
      `Telegram ${experimentType ?? "message"} error: ${result.description}`,
    );
  }

  console.info("[Telegram] Main post delivered", {
    messageId: result?.result?.message_id,
    mediaCount: mediaResults.length,
  });

  // ==========================================
  // REACTION
  // ==========================================

  if (experimentType === "reaction") {
    const messageId = result.result?.message_id;

    if (!messageId) {
      console.warn("⚠️ No message_id returned for reaction");


    }

    const reactionResponse = await axios.post(`${api}/setMessageReaction`, {
      chat_id: chatId,
      message_id: messageId,

      reaction: [
        {
          type: "emoji",
          emoji: post.experiment?.emoji?.[0],
        },
      ],
    });

    const reactionResult = reactionResponse.data;
    console.info("[Telegram] Reaction result", {
      messageId,
      ok: reactionResult.ok,
    });

    if (!reactionResult.ok) {
      console.error("❌ Reaction failed:", reactionResult.description);
    }
  }

  // ==========================================
  // FINAL RESULT
  // ==========================================

}
