import { describe, expect, it } from "vitest";
import { ProviderFactory } from "../../src/providers/providerFactory.js";
import type { AgentDefinition } from "../../src/types.js";

describe("ProviderFactory", () => {
  it("creates mock providers without API keys", async () => {
    const provider = new ProviderFactory({ env: {} }).createForAgent(makeAgent());

    await expect(
      provider.complete({
        agent: makeAgent(),
        messages: [{ role: "user", content: "Hello" }]
      })
    ).resolves.toMatchObject({ text: expect.stringContaining("Mock Architect") });
  });

  it("requires provider-specific keys for real providers", () => {
    expect(() =>
      new ProviderFactory({ env: {} }).createForAgent(makeAgent({ provider: "gemini", model: "gemini-2.5-flash" }))
    ).toThrow("GEMINI_API_KEY");
  });

  it("caches providers by provider and model", () => {
    const factory = new ProviderFactory({ env: {} });
    const first = factory.createForAgent(makeAgent());
    const second = factory.createForAgent(makeAgent());

    expect(first).toBe(second);
  });
});

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "architect",
    displayName: "Architect",
    role: "System design",
    personality: "Cautious",
    provider: "mock",
    model: "mock",
    temperature: 0.6,
    compressionStyle: "caveman",
    respondsWhen: "always",
    cooldownMs: 0,
    slack: {
      botTokenEnv: "SLACK_ARCHITECT_BOT_TOKEN",
      appTokenEnv: "SLACK_ARCHITECT_APP_TOKEN"
    },
    relevanceKeywords: [],
    ...overrides
  };
}
