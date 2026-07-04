import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/providers/mockProvider.js";
import type { AgentDefinition } from "../../src/types.js";

describe("MockProvider", () => {
  it("returns a role-flavored response without network access", async () => {
    const response = await new MockProvider().complete({
      agent: makeAgent(),
      messages: [{ role: "user", content: "We need a launch plan." }]
    });

    expect(response).toContain("Mock Auditor");
    expect(response).toContain("Benchmarks");
    expect(response).toContain("launch plan");
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
