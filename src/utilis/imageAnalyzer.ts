
import { InferenceClient } from "@huggingface/inference";
import "dotenv/config";

const hf = new InferenceClient(process.env.HF_TOKEN);

export async function describeImage(imageUrl: string): Promise<string | undefined> {
  const response = await fetch(imageUrl);

  if (!response.ok) {
    throw new Error(`Could not download image: ${response.status}`);
  }

  const imageBuffer = await response.arrayBuffer();

  const result = await hf.imageToText({
    model: "nlpconnect/vit-gpt2-image-captioning",
    data: new Blob([imageBuffer]),
  });

  return result.generated_text;
}
