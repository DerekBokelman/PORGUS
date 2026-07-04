import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/providers/mockProvider.js";
import type { AgentDefinition } from "../../src/types.js";

describe("MockProvider", () => {
  it("returns a role-flavored response without network access", async () => {
    const { text, usage } = await new MockProvider().complete({
      agent: makeAgent(),
      messages: [{ role: "user", content: "We need a launch plan." }]
    });

    expect(text).toContain("Mock Auditor");
    expect(text).toContain("Benchmarks");
    expect(text).toContain("launch plan");
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
  });
});

function makeAgent(): AgentDefinition {
  return {
    id: "auditor",
    displayName: "Auditor",
    role: "Benchmarks and selection pressure",
    personality: "Data-only",
    provider: "mock",
    model: "mock",
    temperature: 0.6,
    compressionStyle: "caveman",
    respondsWhen: "mentioned-or-relevant",
    cooldownMs: 0,
    slack: {
      botTokenEnv: "SLACK_AUDITOR_BOT_TOKEN",
      appTokenEnv: "SLACK_AUDITOR_APP_TOKEN"
    },
    relevanceKeywords: ["research"]
  };
}
