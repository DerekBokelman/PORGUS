import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/agents/agentRegistry.js";
import { CompositeAgentRegistry } from "../../src/agents/compositeRegistry.js";
import { ConversationCoordinator } from "../../src/coordinator/conversationCoordinator.js";
import type { AgentResponder } from "../../src/coordinator/conversationCoordinator.js";
import { AutonomousLoop } from "../../src/living/autonomousLoop.js";
import { bootstrapLivingCompany } from "../../src/living/bootstrap.js";
import { HeadcountManager } from "../../src/living/headcount.js";
import { InMemoryLivingStore } from "../../src/living/inMemoryLivingStore.js";
import { LivingCompanyRuntime } from "../../src/living/runtime.js";
import { BudgetGuard } from "../../src/memory/budgetGuard.js";
import { InMemoryMemoryStore } from "../../src/memory/inMemoryMemoryStore.js";
import type { AgentDefinition, LlmProvider } from "../../src/types.js";

describe("AutonomousLoop", () => {
  it("runs a heartbeat with the configured channel and responder", async () => {
    const calls: Array<{ channelId: string; responder: AgentResponder }> = [];
    const responder = noopResponder();
    const loop = new AutonomousLoop({
      coordinator: {
        async runHeartbeat(channelId: string, r: AgentResponder) {
          calls.push({ channelId, responder: r });
          return 3;
        }
      } as unknown as ConversationCoordinator,
      responder,
      channelId: "C-TEST",
      busyIntervalMs: 1000,
      idleIntervalMs: 8000
    });

    await loop.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0].channelId).toBe("C-TEST");
    expect(calls[0].responder).toBe(responder);
  });

  it("stays fast while busy and backs off when idle", async () => {
    let turns = 2;
    const loop = new AutonomousLoop({
      coordinator: {
        async runHeartbeat() {
          return turns;
        }
      } as unknown as ConversationCoordinator,
      responder: noopResponder(),
      channelId: "C-TEST",
      busyIntervalMs: 1000,
      idleIntervalMs: 8000
    });

    expect(await loop.tick()).toBe(1000); // produced work -> fast

    turns = 0;
    expect(await loop.tick()).toBe(2000); // idle -> back off (1000 * 2)
    expect(await loop.tick()).toBe(4000);
    expect(await loop.tick()).toBe(8000); // capped at idle ceiling
    expect(await loop.tick()).toBe(8000);

    turns = 5;
    expect(await loop.tick()).toBe(1000); // work again -> snap back to fast
  });

  it("swallows heartbeat errors so the loop keeps running", async () => {
    const logs: string[] = [];
    const loop = new AutonomousLoop({
      coordinator: {
        async runHeartbeat() {
          throw new Error("kill switch engaged");
        }
      } as unknown as ConversationCoordinator,
      responder: noopResponder(),
      channelId: "C-TEST",
      busyIntervalMs: 1000,
      idleIntervalMs: 8000,
      log: (m) => logs.push(m)
    });

    await expect(loop.tick()).resolves.toBe(8000);
    expect(logs.some((line) => line.includes("kill switch engaged"))).toBe(true);
  });

  it("drives an idle company to claim and complete an open task without human input", async () => {
    const memory = new InMemoryMemoryStore();
    const store = new InMemoryLivingStore();
    const base = makeRegistry([
      makeAgent("architect", "Architect"),
      makeAgent("auditor", "Auditor")
    ]);
    const registry = new CompositeAgentRegistry(base, store, {});

    const company = bootstrapLivingCompany({ registry: base, store, spendCeilingUsd: 1000 });
    const headcount = new HeadcountManager(store, company.ledger, {
      humanMaxSlots: 10,
      coreAgentCount: base.list().length
    });
    const livingRuntime = new LivingCompanyRuntime({ company, headcount, registry });

    const task = company.queue.create({
      createdBy: "human",
      roleRequired: "architect",
      title: "Design the retry executor",
      spec: "Add bounded retry with backoff",
      budgetCapUsd: 0.5
    });
    expect(company.listOpenTasks()).toHaveLength(1);

    const coordinator = new ConversationCoordinator({
      registry,
      memory,
      budgetGuard: new BudgetGuard(memory, 100),
      providerResolver: fakeResolver(),
      livingRuntime
    });

    const posts: string[] = [];
    await coordinator.runHeartbeat("C-TEST", {
      async postAgentMessage(agent, text) {
        posts.push(`${agent.displayName}: ${text}`);
        return { ts: `agent-${posts.length}` };
      }
    });

    expect(posts.length).toBeGreaterThan(0);
    const done = company.getTask(task.taskId);
    expect(done?.status).not.toBe("open");
  });
});

function noopResponder(): AgentResponder {
  return {
    async postAgentMessage() {
      return { ts: "ts" };
    }
  };
}

function fakeResolver() {
  return {
    createForAgent(agent: AgentDefinition): LlmProvider {
      return {
        async complete() {
          return `${agent.displayName} did the work.`;
        }
      };
    }
  };
}

function makeRegistry(agents: AgentDefinition[]): AgentRegistry {
  return new AgentRegistry({
    defaults: {
      provider: "mock",
      model: "mock",
      temperature: 0.6,
      compressionStyle: "caveman",
      respondsWhen: "always",
      cooldownMs: 0
    },
    budget: { dailyRealCallLimit: 100 },
    coordination: {
      maxConsecutiveAgentTurns: 3,
      responseDelayMs: 0,
      maxResponsesPerMessage: 1,
      recentMessageLimit: 10
    },
    agents
  });
}

function makeAgent(id: string, displayName: string): AgentDefinition {
  return {
    id,
    displayName,
    role: `${displayName} role`,
    personality: `${displayName} personality`,
    provider: "mock",
    model: "mock",
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
