import dotenv from "dotenv";
dotenv.config();

import { GoogleGenAI } from "@google/genai";

const API_KEY = process.env.GEMINI_API_KEY as string;

const ai = new GoogleGenAI({
  apiKey: API_KEY,
});


export async function gemini(message:string) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: message,
  });
  return response.text;
}
