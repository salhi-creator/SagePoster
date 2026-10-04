import dotenv from "dotenv";
dotenv.config();

import axios from "axios";

export async function mistral(message) {
let res = await axios.post(
  "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2",
  {
    inputs: message,
  },
  {
    headers: {
      Authorization: `Bearer ${process.env.HF_API_KEY}`,
    },
  }
);

  return res.data?.[0]?.generated_text;
}