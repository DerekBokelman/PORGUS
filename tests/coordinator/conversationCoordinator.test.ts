import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/agents/agentRegistry.js";
import { ConversationCoordinator } from "../../src/coordinator/conversationCoordinator.js";
import { BudgetGuard } from "../../src/memory/budgetGuard.js";
import { InMemoryMemoryStore } from "../../src/memory/inMemoryMemoryStore.js";
import type { AgentDefinition, ChannelMessage, LlmProvider } from "../../src/types.js";

describe("ConversationCoordinator", () => {
  it("chains agent replies and stops at maxConsecutiveAgentTurns", async () => {
    const memory = new InMemoryMemoryStore();
    const registry = makeRegistry([makeAgent("architect", "Architect", "mock"), makeAgent("auditor", "Auditor", "mock")], {
      maxConsecutiveAgentTurns: 2
    });
    const coordinator = new ConversationCoordinator({
      registry,
      memory,
      budgetGuard: new BudgetGuard(memory, 10),
      providerResolver: fakeResolver()
    });
    const source = await recordHuman(memory, "Let us plan a new product.");
    const posts: string[] = [];

    await coordinator.handleMessage(source, {
      async postAgentMessage(agent, text) {
        posts.push(`${agent.displayName}: ${text}`);
        return { ts: `agent-${posts.length}` };
      }
    });

    expect(posts).toEqual(["Architect: Architect response", "Auditor: Auditor response"]);
  });

  it("runs agent tool calls and appends their results to the posted message", async () => {
    const memory = new InMemoryMemoryStore();
    const registry = makeRegistry([makeAgent("architect", "Architect", "mock")], {
      maxConsecutiveAgentTurns: 1
    });
    const coordinator = new ConversationCoordinator({
      registry,
      memory,
      budgetGuard: new BudgetGuard(memory, 10),
      providerResolver: {
        createForAgent(agent: AgentDefinition): LlmProvider {
          return {
            async complete() {
              return `Organizing us.\n[SLACK] action=create_channel name=growth`;
            }
          };
        }
      }
    });
    const source = await recordHuman(memory, "Architect, set us up.");
    const posts: string[] = [];

    await coordinator.handleMessage(source, {
      async postAgentMessage(_agent, text) {
        posts.push(text);
        return { ts: `agent-${posts.length}` };
      },
      async runAgentTools(_agent, rawText) {
        return rawText.includes("create_channel") ? ["Created channel #growth"] : [];
      }
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Organizing us.");
    expect(posts[0]).toContain("Created channel #growth");
  });

  it("blocks real providers when the daily budget is exhausted", async () => {
    const memory = new InMemoryMemoryStore();
    const registry = makeRegistry([makeAgent("architect", "Architect", "gemini")], {
      maxConsecutiveAgentTurns: 1
    });
    const coordinator = new ConversationCoordinator({
      registry,
      memory,
      budgetGuard: new BudgetGuard(memory, 0),
      providerResolver: fakeResolver()
    });
    const source = await recordHuman(memory, "Architect, should we build this?");
    const posts: string[] = [];

    await coordinator.handleMessage(source, {
      async postAgentMessage(agent, text) {
        posts.push(`${agent.displayName}: ${text}`);
        return { ts: `agent-${posts.length}` };
      }
    });

    expect(posts).toEqual([]);
  });
});

function fakeResolver() {
  return {
    createForAgent(agent: AgentDefinition): LlmProvider {
      return {
        async complete() {
          return `${agent.displayName} response`;
        }
      };
    }
  };
}

function makeRegistry(
  agents: AgentDefinition[],
  coordination: Partial<ReturnType<AgentRegistry["getCoordination"]>> = {}
): AgentRegistry {
  return new AgentRegistry({
    defaults: {
      provider: "mock",
      model: "mock",
      temperature: 0.6,
      compressionStyle: "caveman",
      respondsWhen: "mentioned-or-relevant",
      cooldownMs: 0
    },
    budget: { dailyRealCallLimit: 10 },
    coordination: {
      maxConsecutiveAgentTurns: 2,
      responseDelayMs: 0,
      maxResponsesPerMessage: 1,
      recentMessageLimit: 10,
      ...coordination
    },
    agents
  });
}

function makeAgent(id: string, displayName: string, provider: AgentDefinition["provider"]): AgentDefinition {
  return {
    id,
    displayName,
    role: `${displayName} role`,
    personality: `${displayName} personality`,
    provider,
    model: provider === "mock" ? "mock" : "test-model",
    temperature: 0.6,
    compressionStyle: "caveman",
    respondsWhen: "always",
    cooldownMs: 0,
    slack: {
      botTokenEnv: `SLACK_${id.toUpperCase()}_BOT_TOKEN`,
      appTokenEnv: `SLACK_${id.toUpperCase()}_APP_TOKEN`
    },
    relevanceKeywords: []
  };
}

async function recordHuman(memory: InMemoryMemoryStore, text: string): Promise<ChannelMessage> {
  const message = await memory.recordChannelMessage({
    channelId: "C123",
    ts: "1000.000",
    authorType: "human",
    authorId: "U123",
    authorName: "Human",
    text
  });

  if (!message) {
    throw new Error("Test message was unexpectedly deduped.");
  }

  return message;
}
