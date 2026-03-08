import type { EmbeddingProvider } from "./provider";

/**
 * No-op embedding provider — used when provider is set to "none".
 *
 * Returns empty vectors. The query command will automatically fall back
 * to keyword search when embeddings are empty.
 *
 * Useful for: testing the indexer pipeline, inspecting index structure,
 * or repositories where semantic search isn't needed.
 */
export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly name = "none";
  readonly model = "none";
  readonly dimensions = 0;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}
