import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/agents/agentRegistry.js";
import { CompositeAgentRegistry } from "../../src/agents/compositeRegistry.js";
import { bootstrapLivingCompany } from "../../src/living/bootstrap.js";
import { HeadcountManager } from "../../src/living/headcount.js";
import { InMemoryLivingStore } from "../../src/living/inMemoryLivingStore.js";
import { LivingCompanyRuntime } from "../../src/living/runtime.js";
import type { AgentDefinition, ChannelMessage } from "../../src/types.js";

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

function setup() {
  const store = new InMemoryLivingStore();
  const base = new AgentRegistry({
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
      maxConsecutiveAgentTurns: 8,
      responseDelayMs: 0,
      maxResponsesPerMessage: 2,
      recentMessageLimit: 10
    },
    agents: [
      makeAgent("architect", "Architect"),
      makeAgent("auditor", "Auditor"),
      makeAgent("operator", "Operator"),
      makeAgent("breeder", "Breeder"),
      makeAgent("chronicler", "Chronicler")
    ]
  });
  const registry = new CompositeAgentRegistry(base, store, {});
  const company = bootstrapLivingCompany({ registry: base, store, spendCeilingUsd: 100000 });
  const headcount = new HeadcountManager(store, company.ledger, {
    humanMaxSlots: 10,
    coreAgentCount: base.list().length
  });
  const runtime = new LivingCompanyRuntime({ company, headcount, registry });
  return { store, company, headcount, runtime };
}

function agentMessage(authorAgentId: string, text: string): ChannelMessage {
  return {
    id: `msg-${authorAgentId}-${text.slice(0, 8)}`,
    channelId: "C-TEST",
    ts: "1000.000",
    authorType: "agent",
    authorId: authorAgentId,
    authorName: authorAgentId,
    authorAgentId,
    text,
    createdAt: new Date().toISOString()
  };
}

describe("LivingCompanyRuntime protocol gating", () => {
  it("rejects [SCORE] from a non-auditor actor", () => {
    const { company, runtime } = setup();
    const task = company.queue.create({
      createdBy: "architect",
      roleRequired: "architect",
      title: "Ship the thing",
      spec: "Do it",
      budgetCapUsd: 0.5
    });
    company.queue.claim(task.taskId, "architect", "architect");
    company.queue.complete(task.taskId, { agentId: "architect", result: "done", costActualUsd: 0.01 });

    const effects = runtime.handleIncomingMessage(
      agentMessage("architect", `[SCORE] task=${task.taskId} overall=9 cost_eff=9 rationale=self praise`)
    );

    expect(effects.some((e) => e.includes("SCORE failed"))).toBe(true);
    expect(company.getTask(task.taskId)?.auditorScore).toBeNull();
  });

  it("accepts [SCORE] from the auditor and records a real score", () => {
    const { company, runtime } = setup();
    const task = company.queue.create({
      createdBy: "architect",
      roleRequired: "architect",
      title: "Ship the thing",
      spec: "Do it",
      budgetCapUsd: 0.5
    });
    company.queue.claim(task.taskId, "architect", "architect");
    company.queue.complete(task.taskId, { agentId: "architect", result: "done", costActualUsd: 0.01 });

    const effects = runtime.handleIncomingMessage(
      agentMessage("auditor", `[SCORE] task=${task.taskId} overall=7 cost_eff=8 rationale=meets spec`)
    );

    expect(effects.some((e) => e.includes(`Scored ${task.taskId}`))).toBe(true);
    expect(company.getTask(task.taskId)?.auditorScore).toBe(7);
  });

  it("rejects [APPROVE] from a non-operator actor", () => {
    const { company, headcount, runtime } = setup();
    company.ledger.recordRevenue("content", 50); // spend 0 + revenue -> surplus
    const proposal = headcount.proposeHeadcount({
      requestedSlots: 1,
      reason: "growth",
      createdBy: "breeder"
    });

    const effects = runtime.handleIncomingMessage(agentMessage("breeder", `[APPROVE] ref=${proposal.proposalId}`));

    expect(effects.some((e) => e.includes("APPROVE failed"))).toBe(true);
    expect(headcount.listPendingProposals()).toHaveLength(1);
  });

  it("no longer auto-approves headcount proposals in surplus mode; only an explicit operator [APPROVE] does", () => {
    const { company, headcount, runtime } = setup();
    company.ledger.recordRevenue("content", 50);
    expect(company.ledger.mode()).toBe("surplus");

    const created = runtime.handleIncomingMessage(
      agentMessage("breeder", `[PROPOSAL] kind=headcount slots=1 reason=growth`)
    );
    expect(created.some((e) => e.includes("Proposed headcount"))).toBe(true);
    expect(created.some((e) => e.includes("Auto-approved"))).toBe(false);
    const proposal = headcount.listPendingProposals()[0];
    expect(proposal).toBeDefined();
    expect(headcount.state().activeSlotLimit).toBe(5);

    const approved = runtime.handleIncomingMessage(agentMessage("operator", `[APPROVE] ref=${proposal.proposalId}`));
    expect(approved.some((e) => e.includes("Operator approved"))).toBe(true);
    expect(headcount.state().activeSlotLimit).toBe(6);
  });

  it("logs a [LESSON] as a do-not-repeat knowledge entry", () => {
    const { company, runtime } = setup();
    runtime.handleIncomingMessage(
      agentMessage("chronicler", '[LESSON] trigger="retry storm" body="cap retries at 3"')
    );

    const entries = company.knowledge.listDoNotRepeat();
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toContain("cap retries at 3");
  });

  it("surfaces done-but-unscored task detail to the auditor's prompt context", () => {
    const { company, runtime } = setup();
    const task = company.queue.create({
      createdBy: "architect",
      roleRequired: "architect",
      title: "Ship the retry fix",
      spec: "Add bounded retry",
      budgetCapUsd: 0.5
    });
    company.queue.claim(task.taskId, "architect", "architect");
    company.queue.complete(task.taskId, {
      agentId: "architect",
      result: "Added retry with backoff",
      costActualUsd: 0.02
    });

    const context = runtime.buildAgentContext(makeAgent("auditor", "Auditor"));
    expect(context).toContain(task.taskId);
    expect(context).toContain("Added retry with backoff");
    expect(context).toContain("[SCORE] task=");
  });
});
