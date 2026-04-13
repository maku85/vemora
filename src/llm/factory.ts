import type { SummarizationConfig } from "../core/types";
import { AnthropicProvider } from "./anthropic";
import { ClaudeCodeProvider } from "./claude-code";
import { OllamaProvider } from "./ollama";
import { OpenAIProvider } from "./openai";
import type { LLMProvider } from "./provider";

/**
 * Factory that instantiates the correct LLMProvider from config.
 */
export function createLLMProvider(config: SummarizationConfig): LLMProvider {
  const apiKey =
    config.apiKey ??
    (config.provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY
      : config.provider === "gemini"
        ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)
        : process.env.OPENAI_API_KEY);

  switch (config.provider) {
    case "openai":
      if (!apiKey) throw new Error("OPENAI_API_KEY not found");
      return new OpenAIProvider(apiKey, config.baseUrl);

    case "anthropic":
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not found");
      return new AnthropicProvider(apiKey);

    case "gemini": {
      if (!apiKey) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) not found");
      const baseUrl =
        config.baseUrl ??
        "https://generativelanguage.googleapis.com/v1beta/openai/";
      return new OpenAIProvider(apiKey, baseUrl);
    }

    case "ollama":
      return new OllamaProvider(config.baseUrl || "http://localhost:11434");

    case "claude-code":
      return new ClaudeCodeProvider({
        command: config.baseUrl || "claude", // baseUrl repurposed as binary path
        model: config.model || undefined,
        allowedTools: config.allowedTools,
        maxBudgetUsd: config.maxBudgetUsd,
      });

    default:
      throw new Error(`Unknown LLM provider: "${config.provider}"`);
  }
}
