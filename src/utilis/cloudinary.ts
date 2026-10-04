import { v2 as cloudinary } from "cloudinary";
import axios from "axios";
import dotenv from "dotenv";
import streamifier from "streamifier";

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME as string,
  api_key: process.env.CLUDINARY_API_KEY as string,
  api_secret: process.env.CLOUDINARY_API_SECRET as string,
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;


// get the sent photo and save it url
export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const url = await getTelegramFileUrl(fileId);

  const response = await axios.get(url, {
    responseType: "arraybuffer",
  });

  return Buffer.from(response.data);
}




export async function getTelegramFileUrl(fileId: string) {
  const response = await axios.get(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile`,
    {
      params: {
        file_id: fileId,
      },
    },
  );

  const filePath = response.data.result.file_path;

  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
}




export async function uploadBufferToCloudinary(
  buffer: Buffer,
  resourceType: "image" | "video" | "auto" = "auto",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "sageposter",
        resource_type: resourceType,
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
