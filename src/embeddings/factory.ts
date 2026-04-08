import type { EmbeddingConfig } from "../core/types";
import { NoopEmbeddingProvider } from "./noop";
import { OllamaEmbeddingProvider } from "./ollama";
import { OpenAIEmbeddingProvider } from "./openai";
import type { EmbeddingProvider } from "./provider";

/**
 * Factory that instantiates the correct EmbeddingProvider from config.
 * Adding a new provider only requires implementing EmbeddingProvider and
 * adding a case here — no other code needs to change.
 */
export function createEmbeddingProvider(
  config: EmbeddingConfig,
): EmbeddingProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAIEmbeddingProvider(
        config.apiKey,
        config.model,
        config.dimensions,
      );

    case "ollama":
      return new OllamaEmbeddingProvider(
        config.model,
        config.baseUrl,
        config.dimensions,
        config.maxChars,
      );

    case "none":
      return new NoopEmbeddingProvider();

    default: {
      const p = (config as EmbeddingConfig).provider;
      throw new Error(
        `Unknown embedding provider: "${p}". Valid options: openai, ollama, none`,
      );
    }
  }
}
