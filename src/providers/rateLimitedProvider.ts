import type { LlmCompletionInput, LlmCompletionResult, LlmProvider } from "../types.js";

export class RateLimitedProvider implements LlmProvider {
  private nextAvailableAt = 0;
  private queue = Promise.resolve();

  constructor(
    private readonly provider: LlmProvider,
    private readonly minIntervalMs: number
  ) {}

  async complete(input: LlmCompletionInput): Promise<LlmCompletionResult> {
    const run = this.queue.then(async () => {
      const waitMs = Math.max(0, this.nextAvailableAt - Date.now());

      if (waitMs > 0) {
        await delay(waitMs);
      }

      this.nextAvailableAt = Date.now() + this.minIntervalMs;
      return this.provider.complete(input);
    });

    this.queue = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
