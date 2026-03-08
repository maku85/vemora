/**
 * EmbeddingProvider — the interface every embedding backend must implement.
 *
 * Swap implementations by changing `config.embedding.provider` in config.json.
 * Current implementations: openai, ollama, none.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;

  /**
   * Generate embeddings for a batch of texts.
   * Returns one float vector per input text, in the same order.
   *
   * Implementations should handle rate limits, batching, and retries internally.
   */
  embed(texts: string[]): Promise<number[][]>;
}
