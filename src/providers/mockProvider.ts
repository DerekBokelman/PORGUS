import type { LlmCompletionInput, LlmCompletionResult, LlmProvider } from "../types.js";

// Rough token estimate for a provider with no real usage metadata: ~4 chars per token.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class MockProvider implements LlmProvider {
  async complete(input: LlmCompletionInput): Promise<LlmCompletionResult> {
    const latestUserMessage = [...input.messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    const focus = latestUserMessage?.slice(0, 180) ?? "the current project";

    const text = input.agent.compressionStyle === "caveman"
      ? [
          `Mock ${input.agent.displayName}:`,
          `Role: ${input.agent.role}`,
          `Take: ${focus}`,
          "Next: test biggest assumption before real call."
        ].join("\n")
      : [
          `Mock ${input.agent.displayName}:`,
          `Role: ${input.agent.role}`,
          `Personality: ${input.agent.personality}`,
          `My take: ${focus}`,
          "Next: I would clarify the highest-impact assumption before spending a real model call."
        ].join("\n");

    const inputTokens = input.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    return { text, usage: { inputTokens, outputTokens: estimateTokens(text) } };
  }
}
