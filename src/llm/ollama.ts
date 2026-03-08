import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
  LLMResponse,
} from "./provider";

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private baseUrl: string;

  constructor(baseUrl: string = "http://localhost:11434") {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<LLMResponse> {
    const stream = options.stream || !!options.onToken;
    const model = options.model || "llama3";

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.maxTokens,
        },
        stream,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${error}`);
    }

    if (stream) {
      if (!response.body) throw new Error("Ollama response body is empty");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          // Ollama sends multiple JSON objects, one per line (NDJSON)
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              if (data.message?.content) {
                const token = data.message.content;
                fullContent += token;
                options.onToken?.(token);
              }
            } catch (_e) {
              // Partial JSON, wait for more data
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      return { content: fullContent };
    }

    const data = (await response.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      content: data.message?.content || "",
      usage: data.prompt_eval_count
        ? {
            promptTokens: data.prompt_eval_count,
            completionTokens: data.eval_count ?? 0,
            totalTokens: data.prompt_eval_count + (data.eval_count ?? 0),
          }
        : undefined,
    };
  }
}
