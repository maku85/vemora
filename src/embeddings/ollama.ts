import type { EmbeddingProvider } from "./provider";

interface OllamaEmbedResponse {
  embedding: number[];
}

/**
 * Ollama embedding provider — runs entirely locally, no API key needed.
 *
 * Requires Ollama running at baseUrl with the target model pulled:
 *   ollama pull nomic-embed-text
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly model: string;
  readonly dimensions: number;

  private baseUrl: string;

  constructor(
    model = "nomic-embed-text",
    baseUrl = "http://localhost:11434",
    dimensions = 768,
  ) {
    this.model = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    // Ollama's /api/embeddings endpoint processes one text at a time
    for (const text of texts) {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });

      if (!response.ok) {
        throw new Error(
          `Ollama embedding request failed: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as OllamaEmbedResponse;
      results.push(data.embedding);
    }

    return results;
  }
}
