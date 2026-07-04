import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/agents/agentRegistry.js";

describe("AgentRegistry", () => {
  it("loads the configured business agents", () => {
    const registry = AgentRegistry.fromYamlFile(resolve("config/agents.yaml"));
    const agents = registry.list();

    expect(agents.map((agent) => agent.id)).toEqual([
      "architect",
      "auditor",
      "operator",
      "breeder",
      "chronicler"
    ]);
    expect(agents).toHaveLength(5);
    expect(agents.every((agent) => agent.compressionStyle === "normal")).toBe(true);
    expect(registry.getRequired("architect").provider).toBe("gemini");
    expect(registry.getRequired("auditor").provider).toBe("groq");
    expect(registry.getRequired("operator").provider).toBe("openrouter");
    expect(registry.getRequired("breeder").provider).toBe("groq");
    expect(registry.getRequired("chronicler").provider).toBe("ollama");
    expect(registry.getRequired("auditor").model).not.toBe(registry.getRequired("breeder").model);
    expect(registry.getRequired("auditor").temperature).toBe(0.2);
    expect(registry.getBudget().dailyRealCallLimit).toBe(45);
  });

  it("rejects duplicate agent ids", () => {
    const agent = {
      id: "architect",
      displayName: "Architect",
      role: "System design",
      personality: "Direct",
      provider: "mock" as const,
      model: "mock",
      temperature: 0.6,
      compressionStyle: "caveman" as const,
      respondsWhen: "always" as const,
      cooldownMs: 0,
      slack: {
        botTokenEnv: "SLACK_ARCHITECT_BOT_TOKEN",
        appTokenEnv: "SLACK_ARCHITECT_APP_TOKEN"
      },
      relevanceKeywords: []
    };

    expect(
      () =>
        new AgentRegistry({
          defaults: {
            provider: "mock",
            model: "mock",
            temperature: 0.6,
            compressionStyle: "caveman",
            respondsWhen: "mentioned-or-relevant",
            cooldownMs: 0
          },
          budget: { dailyRealCallLimit: 1 },
          coordination: {
            maxConsecutiveAgentTurns: 1,
            responseDelayMs: 0,
            maxResponsesPerMessage: 1,
            recentMessageLimit: 5
          },
          agents: [agent, agent]
        })
    ).toThrow("duplicate ids");
  });
});
