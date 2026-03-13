import type { SummarizationConfig } from "../core/types";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { OpenAIProvider } from "./openai";
import type { LLMProvider } from "./provider";

/**
 * Factory that instantiates the correct LLMProvider from config.
 */
export function createLLMProvider(config: SummarizationConfig): LLMProvider {
  const apiKey =
    (config.provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY) ??
    config.apiKey;

  switch (config.provider) {
    case "openai":
      if (!apiKey) throw new Error("OPENAI_API_KEY not found");
      return new OpenAIProvider(apiKey);

    case "anthropic":
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not found");
      return new AnthropicProvider(apiKey);

    case "ollama":
      return new OllamaProvider(config.baseUrl || "http://localhost:11434");

    default:
      throw new Error(`Unknown LLM provider: "${config.provider}"`);
  }
}
