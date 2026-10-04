import dotenv from "dotenv";
dotenv.config();
console.log("groq key ",process.env.GROQ_API_KEY)

import OpenAI from "openai";




const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

export async function groq(message:string) {
  const response = await client.responses.create({
    model: "openai/gpt-oss-20b",
    input: message,
  });

  console.log(response.output_text);

  return response.output_text;
}
