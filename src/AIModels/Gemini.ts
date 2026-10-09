import dotenv from "dotenv";
dotenv.config();

import { GoogleGenAI } from "@google/genai";

export async function gemini(message: string, apiKey: string) {
  if (!apiKey) {
    throw new Error("A Gemini API key was not configured for this request");
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: message,
  });
  return response.text;
}
