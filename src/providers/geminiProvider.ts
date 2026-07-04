import { GoogleGenAI, type Content } from "@google/genai";
import type { ChatMessage, LlmCompletionInput, LlmProvider } from "../types.js";

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
}

export class GeminiProvider implements LlmProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(options: GeminiProviderOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model;
  }

  async complete(input: LlmCompletionInput): Promise<string> {
    const caveman = input.agent.compressionStyle === "caveman";
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: toGeminiContents(input.messages),
      config: {
        systemInstruction: buildSystemInstruction(input.messages),
        temperature: input.temperature ?? 0.4,
        maxOutputTokens: caveman ? 350 : 1200
      }
    });

    return response.text?.trim() ?? "";
  }
}

function buildSystemInstruction(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
}

function toGeminiContents(messages: ChatMessage[]): Content[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }]
    }));
}
