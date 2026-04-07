import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
  LLMResponse,
} from "./provider";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  // biome-ignore lint/suspicious/noExplicitAny: openai is an optional peer dependency
  private client: any;

  constructor(apiKey: string, baseUrl?: string) {
    let OpenAI: any;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: optional peer dependency
      OpenAI = require("openai").default ?? require("openai");
    } catch {
      throw new Error(
        'Package "openai" is not installed. Run: npm install openai',
      );
    }
    this.client = new OpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<LLMResponse> {
    const stream = options.stream || !!options.onToken;

    if (stream) {
      const responseStream = await this.client.chat.completions.create({
        model: options.model || "gpt-4o-mini",
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens,
        stream: true,
      });

      let fullContent = "";
      for await (const chunk of responseStream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
          fullContent += content;
          options.onToken?.(content);
        }
      }

      return { content: fullContent };
    }

    const response = await this.client.chat.completions.create({
      model: options.model || "gpt-4o-mini",
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
    });

    const content = response.choices[0]?.message?.content || "";

    return {
      content,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }
}
