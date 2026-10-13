import type { Request, Response } from "express";
import {
  saveTelegramPicturesToCloudinary,
  TelegramPictureRequestError,
} from "./cloudinary.js";
import { logError } from "./logError.js";
import { sendMessageBackToMe } from "../utilis.js";

export async function setPictureToCloudinary(
  req: Request,
  res: Response,
): Promise<void> {
  let payload: any = req.body;
  const queryMessage = req.query.message;
    const chatId =
    req.body?.message?.chat?.id ?? req.body?.channel_post?.chat?.id;
  if (
    (!payload || Object.keys(payload).length === 0) &&
    typeof queryMessage === "string"
  ) {
    try {
      payload = JSON.parse(queryMessage);
    } catch {
      res.status(400).json({
        ok: false,
        error: "Query parameter 'message' must contain valid JSON",
      });
      return;
    }
  }
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      res.status(400).json({
        ok: false,
        error: "Request body must contain a Telegram message or update",
      });
      return;
    }
  }

  try {
    const uploaded = await saveTelegramPicturesToCloudinary(
      payload,
      undefined,
      process.env.PICTURE_UPLOAD_TELEGRAM_BOT_TOKEN,
    );
    console.info("[Cloudinary] Telegram post images saved", {
      count: uploaded.length,
    });
    res.status(200).json({ ok: true, uploaded });
    await sendMessageBackToMe(chatId,"the picture(s) successfully uploaded to Cloudinary ",false)
  } catch (error) {
    if (error instanceof TelegramPictureRequestError) {
      res.status(400).json({ ok: false, error: error.message });
          await sendMessageBackToMe(chatId,"something gone wrong , check the logs ",false)

      return;
    }
    logError("Telegram image save to Cloudinary failed", error);
    res.status(502).json({
      ok: false,
      error: "Could not save the Telegram image(s) to Cloudinary",
    });
  }
}
