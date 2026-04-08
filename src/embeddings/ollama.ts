import type { EmbeddingProvider } from "./provider";

interface OllamaEmbedResponse {
  embedding: number[];
}

/**
 * Ollama embedding provider — runs entirely locally, no API key needed.
 *
 * Requires Ollama running at baseUrl with the target model pulled:
 *   ollama pull nomic-embed-text
 *
 * Texts are truncated to maxChars before embedding to avoid hitting
 * the model's context window limit. Default: 3800 chars (safe for
 * nomic-embed-text, which has a 2048-token context ≈ 4050 chars empirically).
 * Override via embedding.maxChars in .vemora/config.json.
 */
const DEFAULT_MAX_CHARS = 3800;

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly model: string;
  readonly dimensions: number;

  private baseUrl: string;
  private maxChars: number;

  constructor(
    model = "nomic-embed-text",
    baseUrl = "http://localhost:11434",
    dimensions = 768,
    maxChars = DEFAULT_MAX_CHARS,
  ) {
    this.model = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.maxChars = maxChars;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    // Ollama's /api/embeddings endpoint processes one text at a time
    for (const text of texts) {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text.slice(0, this.maxChars) }),
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
