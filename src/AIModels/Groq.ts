import dotenv from "dotenv";
dotenv.config();

import OpenAI from "openai";

export async function groq(message: string, apiKey: string) {
  if (!apiKey) {
    throw new Error("A Groq API key was not configured for this request");
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });
  const response = await client.responses.create({
    model: "openai/gpt-oss-20b",
    input: message,
  });

  console.log(response.output_text);

  return response.output_text;
}
