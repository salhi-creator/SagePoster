import axios from "axios";
import type { TelegramPost,PostJobData } from "../Data-Structure/types.js";
export async function sendToTelegram(post: TelegramPost ): Promise<void> {
  console.log("telePost:", post);

 
 
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.SAGEHUB_CHAT_ID;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing");
  }

  if (!chatId) {
    throw new Error("TELEGRAM_CHANNEL_ID is missing");
  }

  console.log("🤖 Telegram token loaded:", `${token.slice(0, 8)}...`);

  console.log("📢 Telegram chat ID:", chatId);
  console.log("🧪 Experiment:", post.experiment);

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
      console.log("📸 Preparing media group:", validMedia);

      const media = validMedia.map((item: any, index: number) => ({
        type: item.type === "video" ? "video" : "photo",
        media: item.url,
        ...(index === 0
          ? {
              caption: post.content,
            }
          : {}),
      }));

      console.log("📦 Sending media group:", JSON.stringify(media, null, 2));

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

        console.log(
          "📨 Media group response:",
          JSON.stringify(response.data, null, 2),
        );

        if (!response.data.ok) {
          throw new Error(
            `Telegram media group error: ${response.data.description}`,
          );
        }

        mediaResults.push(...response.data.result);

        console.log("✅ Media group delivered");
      } catch (error: any) {
        console.error(
          "❌ sendMediaGroup FAILED:",
          error.response?.data ?? error.message,
        );

        throw error;
      }
    }

    // ----------------------------------------
    // ONE MEDIA
    // ----------------------------------------
    else if (validMedia.length === 1) {
      const media = validMedia[0];

      console.log("📸 Sending single media:", media);

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

      console.log("✅ Single media delivered");
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
    console.log("📤 Telegram main request:", JSON.stringify(body, null, 2));

    const response = await axios.post(`${api}/${endpoint}`, body);

    result = response.data;

    console.log("📨 Telegram main response:", JSON.stringify(result, null, 2));

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

  console.log("📤 Telegram main request:", JSON.stringify(body, null, 2));

  // const response = await axios.post(`${api}/${endpoint}`, body);

  // result = response.data;

  console.log("📨 Telegram main response:", JSON.stringify(result, null, 2));

  if (result && !result.ok) {
    throw new Error(
      `Telegram ${experimentType ?? "message"} error: ${result.description}`,
    );
  }

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

    console.log(
      "❤️ Reaction response:",
      JSON.stringify(reactionResult, null, 2),
    );

    if (!reactionResult.ok) {
      console.error("❌ Reaction failed:", reactionResult.description);
    }
  }

  // ==========================================
  // FINAL RESULT
  // ==========================================

}
