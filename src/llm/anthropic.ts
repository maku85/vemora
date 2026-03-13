import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
  LLMResponse,
} from "./provider";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  // biome-ignore lint/suspicious/noExplicitAny: @anthropic-ai/sdk is an optional peer dependency
  private client: any;

  constructor(apiKey: string) {
    let Anthropic: any;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: optional peer dependency
      Anthropic = require("@anthropic-ai/sdk").default ?? require("@anthropic-ai/sdk");
    } catch {
      throw new Error(
        'Package "@anthropic-ai/sdk" is not installed. Run: npm install @anthropic-ai/sdk',
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<LLMResponse> {
    const stream = options.stream || !!options.onToken;
    const model = options.model || "claude-3-5-sonnet-20240620";

    // Anthropic requires a separate system prompt from the messages array
    const systemMessage = messages.find((m) => m.role === "system");
    const userMessages = messages.filter((m) => m.role !== "system");

    if (stream) {
      const responseStream = await this.client.messages.create({
        model,
        system: systemMessage?.content,
        messages: userMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.7,
        stream: true,
      });

      let fullContent = "";
      for await (const event of responseStream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          const token = event.delta.text;
          fullContent += token;
          options.onToken?.(token);
        }
      }

      return { content: fullContent };
    }

    const response = await this.client.messages.create({
      model,
      system: systemMessage?.content,
      messages: userMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature ?? 0.7,
    });

    // Anthropic response content can be an array of blocks
    const content = response.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n");

    return {
      content,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens:
              response.usage.input_tokens + response.usage.output_tokens,
          }
        : undefined,
    };
  }
}
