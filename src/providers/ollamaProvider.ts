import type { ChatMessage, LlmCompletionInput, LlmProvider } from "../types.js";

interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
}

interface OllamaResponse {
  message?: {
    content?: string;
  };
  error?: string;
}

export class OllamaProvider implements LlmProvider {
  constructor(private readonly options: OllamaProviderOptions) {}

  async complete(input: LlmCompletionInput): Promise<string> {
    const caveman = input.agent.compressionStyle === "caveman";
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.options.model,
        stream: false,
        messages: input.messages.map(toOllamaMessage),
        options: {
          temperature: input.temperature ?? input.agent.temperature,
          num_predict: caveman ? 350 : 1200
        }
      })
    });

    const body = (await response.json()) as OllamaResponse;

    if (!response.ok) {
      throw new Error(body.error ?? `Ollama provider failed: ${response.status}`);
    }

    return body.message?.content?.trim() ?? "";
  }
}

function toOllamaMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: message.content
  };
}
