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
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      batches.push(texts.slice(i, i + BATCH_SIZE));
    }

    const MAX_PARALLEL = 4;
    for (let i = 0; i < batches.length; i += MAX_PARALLEL) {
      const parallelBatches = batches.slice(i, i + MAX_PARALLEL);
      try {
        const responses = await Promise.all(
          parallelBatches.map(async (batch, idx) => {
            try {
              return await this.client.embeddings.create({
                model: this.model,
                input: batch,
                ...(this.model.startsWith("text-embedding-3") && {
                  dimensions: this.dimensions,
                }),
              });
            } catch (err) {
              console.error(`OpenAI embedding batch ${i + idx} failed:`, err);
              return { data: [] };
            }
          })
        );
        for (const response of responses) {
          const sorted = response.data.sort((a, b) => a.index - b.index);
          results.push(...sorted.map((e) => e.embedding));
        }
      } catch (err) {
        console.error(`OpenAI embedding batch group ${i / MAX_PARALLEL} failed:`, err);
      }
    }
    return results;
  }
}
