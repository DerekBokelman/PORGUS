import type { LlmCompletionInput, LlmProvider } from "../types.js";

export class MockProvider implements LlmProvider {
  async complete(input: LlmCompletionInput): Promise<string> {
    const latestUserMessage = [...input.messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    const focus = latestUserMessage?.slice(0, 180) ?? "the current project";

    if (input.agent.compressionStyle === "caveman") {
      return [
        `Mock ${input.agent.displayName}:`,
        `Role: ${input.agent.role}`,
        `Take: ${focus}`,
        "Next: test biggest assumption before real call."
      ].join("\n");
    }

    return [
      `Mock ${input.agent.displayName}:`,
      `Role: ${input.agent.role}`,
      `Personality: ${input.agent.personality}`,
      `My take: ${focus}`,
      "Next: I would clarify the highest-impact assumption before spending a real model call."
    ].join("\n");
  }
}
