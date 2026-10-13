import { v2 as cloudinary } from "cloudinary";
import axios from "axios";
import dotenv from "dotenv";
import streamifier from "streamifier";
import { logError } from "./logError.js";

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME as string,
  api_key: (process.env.CLOUDINARY_API_KEY ?? process.env.CLUDINARY_API_KEY) as string,
  api_secret: process.env.CLOUDINARY_API_SECRET as string,
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export type CloudinaryPostImage = { url: string; description: string };
type PictureUploadItem = { fileId: string; description: string };
type UploadedPicture = { url: string; description: string };

export class TelegramPictureRequestError extends Error {}

function getTelegramPictureItems(
  payload: any,
  descriptionOverride?: string,
): PictureUploadItem[] {
  const cleanDescription = (value: string) =>
    value
      .replace(/^\/(?:setpicture|set-picture-to-cloudinary)(?:@\w+)?\s*/i, "")
      .trim();
  const sharedDescription =
    (descriptionOverride ? cleanDescription(descriptionOverride) : "") ||
    (typeof payload?.description === "string"
      ? cleanDescription(payload.description)
      : "");
  const messageData = payload?.message ?? payload?.channel_post ?? payload;
  const messages: any[] = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(messageData)
      ? messageData
      : [messageData];

  if (!messages.length || messages.length > 10) {
    throw new TelegramPictureRequestError("Provide 1 to 10 Telegram image messages");
  }

  const albumDescription =
    sharedDescription ||
    (messages
      .map((item) => item?.message ?? item)
      .map((message) => message?.caption ?? message?.text)
      .map((value) =>
        typeof value === "string" ? cleanDescription(value) : value,
      )
      .find(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim()),
      )
      ?.trim() ??
      "");
  const uploadItems: PictureUploadItem[] = [];

  for (const item of messages) {
    const message = item?.message ?? item;
    const photo = Array.isArray(message?.photo)
      ? message.photo.at(-1)
      : undefined;
    const document = message?.document;
    const fileId =
      typeof photo?.file_id === "string"
        ? photo.file_id
        : typeof document?.file_id === "string" &&
            typeof document?.mime_type === "string" &&
            document.mime_type.startsWith("image/")
          ? document.file_id
          : undefined;
    if (!fileId) continue;

    const description =
      typeof message?.caption === "string" && cleanDescription(message.caption)
        ? cleanDescription(message.caption)
        : typeof message?.text === "string" && cleanDescription(message.text)
          ? cleanDescription(message.text)
          : albumDescription;
    if (!description) {
      throw new TelegramPictureRequestError(
        "Each image needs a Telegram caption/text or a shared description",
      );
    }
    if (description.length > 1024) {
      throw new TelegramPictureRequestError(
        "Image descriptions must be 1024 characters or fewer",
      );
    }
    uploadItems.push({ fileId, description });
  }

  if (!uploadItems.length) {
    throw new TelegramPictureRequestError(
      "No Telegram photo or image document was found",
    );
  }
  return uploadItems;
}

/** Downloads Telegram photos and saves them to Cloudinary with descriptions. */
export async function saveTelegramPicturesToCloudinary(
  payload: unknown,
  descriptionOverride?: string,
  botToken = BOT_TOKEN,
): Promise<UploadedPicture[]> {
  const uploadItems = getTelegramPictureItems(payload, descriptionOverride);
  const folder = process.env.CLOUDINARY_POST_IMAGE_FOLDER || "sageposter";
  if (!botToken) {
    throw new Error(
      "PICTURE_UPLOAD_TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN must be configured",
    );
  }

  return Promise.all(
    uploadItems.map(async ({ fileId, description }) => {
      const buffer = await downloadTelegramFile(fileId, botToken);
      const url = await uploadBufferToCloudinary(buffer, "image", {
        description,
        folder,
      });
      return { url, description };
    }),
  );
}

function randomImageCount(): number {
  const value = Math.random();
  if (value < 0.8) return 1;
  if (value < 0.9) return 2;
  return 3;
}

/** Randomly decides whether to offer described Cloudinary images to the planner. */
export async function getRandomCloudinaryPostImages(): Promise<{
  desiredCount: number;
  candidates: CloudinaryPostImage[];
} | null> {
  if (Math.random() >= 0.2) return null;

  const desiredCount = randomImageCount();
  try {
    const folder = process.env.CLOUDINARY_POST_IMAGE_FOLDER || "sageposter";
    const response = await cloudinary.api.resources({
      type: "upload",
      resource_type: "image",
      prefix: `${folder.replace(/\/$/, "")}/`,
      max_results: 50,
      context: true,
      metadata: true,
    });
    const resources = Array.isArray(response.resources) ? response.resources : [];
    const candidates: CloudinaryPostImage[] = resources.flatMap((resource: any) => {
      const custom = resource.context?.custom ?? resource.context ?? {};
      const metadata = resource.metadata ?? {};
      const description =
        custom.description ?? custom.desc ?? custom.caption ?? metadata.description;
      if (typeof resource.secure_url !== "string" || typeof description !== "string" || !description.trim()) {
        return [];
      }
      return [{ url: resource.secure_url, description: description.trim() }];
    });

    // Shuffle so the same first assets are not always considered.
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [candidates[index], candidates[swapIndex]] = [candidates[swapIndex]!, candidates[index]!];
    }

    const selected = candidates.slice(0, desiredCount);
    console.info("[Media] Optional Cloudinary images prepared", {
      selectedCount: selected.length,
      desiredCount,
    });
    return { desiredCount, candidates: selected };
  } catch (error) {
    logError("Could not read optional Cloudinary images", error);
    return { desiredCount, candidates: [] };
  }
}


// get the sent photo and save it url
export async function downloadTelegramFile(
  fileId: string,
  botToken = BOT_TOKEN,
): Promise<Buffer> {
  const url = await getTelegramFileUrl(fileId, botToken);

  const response = await axios.get(url, {
    responseType: "arraybuffer",
  });

  return Buffer.from(response.data);
}




export async function getTelegramFileUrl(
  fileId: string,
  botToken = BOT_TOKEN,
) {
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }
  const response = await axios.get(
    `https://api.telegram.org/bot${botToken}/getFile`,
    {
      params: {
        file_id: fileId,
      },
    },
  );

  const filePath = response.data.result.file_path;

  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}




export async function uploadBufferToCloudinary(
  buffer: Buffer,
  resourceType: "image" | "video" | "auto" = "auto",
  options: { description?: string; folder?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder ?? "sageposter",
        resource_type: resourceType,
        ...(options.description
          ? { context: { description: options.description } }
          : {}),
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        if (!result?.secure_url) {
          reject(new Error("Cloudinary did not return a URL"));
          return;
        }

        resolve(result.secure_url);
      },
    );

    streamifier.createReadStream(buffer).pipe(stream);
  });
}


export default cloudinary;
