export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  onToken?: (token: string) => void;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMProvider {
  readonly name: string;

  /**
   * Sends a chat request to the LLM.
   * If options.stream is true, it should ideally handle streaming
   * (to be refined based on CLI requirements).
   */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse>;
}
