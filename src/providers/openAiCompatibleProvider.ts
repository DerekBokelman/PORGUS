import type { ChatMessage, LlmCompletionInput, LlmCompletionResult, LlmProvider } from "../types.js";

interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  title?: string;
  referer?: string;
  appName?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: {
    message?: string;
    metadata?: {
      retry_after_seconds?: number;
    };
  };
}

const MAX_RATE_LIMIT_RETRIES = 3;

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly options: OpenAiCompatibleProviderOptions) {}

  async complete(input: LlmCompletionInput): Promise<LlmCompletionResult> {
    const caveman = input.agent.compressionStyle === "caveman";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      "Content-Type": "application/json"
    };

    if (this.options.referer) {
      headers["HTTP-Referer"] = this.options.referer;
    }
    if (this.options.appName) {
      headers["X-Title"] = this.options.appName;
    } else if (this.options.title) {
      headers["X-Title"] = this.options.title;
    }

    const payload = JSON.stringify({
      model: this.options.model,
      temperature: input.temperature ?? input.agent.temperature,
      max_tokens: caveman ? 350 : 1200,
      messages: input.messages.map(toOpenAiMessage)
    });

    const url = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      const response = await fetch(url, { method: "POST", headers, body: payload });
      const body = (await response.json()) as ChatCompletionResponse;

      if (response.ok) {
        return {
          text: body.choices?.[0]?.message?.content?.trim() ?? "",
          usage: body.usage
            ? {
                inputTokens: body.usage.prompt_tokens ?? 0,
                outputTokens: body.usage.completion_tokens ?? 0
              }
            : undefined
        };
      }

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfterMs = Math.ceil((body.error?.metadata?.retry_after_seconds ?? 4) * 1000);
        await delay(retryAfterMs);
        continue;
      }

      throw new Error(body.error?.message ?? `OpenAI-compatible provider failed: ${response.status}`);
    }

    throw new Error("OpenAI-compatible provider failed after rate-limit retries");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toOpenAiMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: message.content
  };
}
