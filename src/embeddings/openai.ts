import OpenAI from "openai";
import type { EmbeddingProvider } from "./provider";

/** Maximum inputs per API call (OpenAI allows up to 2048) */
const BATCH_SIZE = 100;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly model: string;
  readonly dimensions: number;

  private client: OpenAI;

  constructor(
    apiKey?: string,
    model = "text-embedding-3-small",
    dimensions = 1536,
  ) {
    this.model = model;
    this.dimensions = dimensions;
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env.OPENAI_API_KEY,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        // text-embedding-3-* supports custom dimensions via Matryoshka reduction
        ...(this.model.startsWith("text-embedding-3") && {
          dimensions: this.dimensions,
        }),
      });

      // Sort by index to guarantee order matches input
      const sorted = response.data.sort((a, b) => a.index - b.index);
      results.push(...sorted.map((e) => e.embedding));
    }

    return results;
  }
}
