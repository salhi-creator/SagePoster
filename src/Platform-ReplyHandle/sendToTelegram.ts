import axios from "axios";
import type { TelegramPost,PostJobData } from "../Data-Structure/types.js";
import { logError } from "../utilis/logError.js";
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

    body.question = post.experiment?.question;
    body.options = post.experiment?.options;

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

    body.reply_markup = {
      inline_keyboard: post.experiment?.buttons,
    };
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

  if (post.media?.length > 0) {
    const validMedia = post.media.filter(
      (item: any) => item?.url && item?.type,
    );

    // ----------------------------------------
    // MULTIPLE MEDIA → ALBUM
    // ----------------------------------------

    if (validMedia.length > 1) {
      console.info("[Telegram] Sending media group", { mediaCount: validMedia.length });


      const media = validMedia.map((item: any, index: number) => ({
        type: item.type === "video" ? "video" : "photo",
        media: item.url,
        ...(index === 0
          ? {
              caption: post.content,
            }
          : {}),
      }));



      try {
        const response = await axios.post(
          `${api}/sendMediaGroup`,
          {
            chat_id: chatId,
            media,
          },
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
      console.info("[Telegram] Sending single media", { type: media?.type });



      const mediaEndpoint = media?.type === "video" ? "sendVideo" : "sendPhoto";

      const mediaBody: Record<string, any> = {
        chat_id: chatId,

        ...(media?.type === "video"
          ? {
              video: media?.url,
              caption: post.content,
            }
          : {
              photo: media?.url,
              caption: post.content,
            }),
      };

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
