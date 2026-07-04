import { describe, expect, it } from "vitest";
import type { Auditor } from "../../src/living/auditor.js";
import { EvolutionError } from "../../src/living/evolution.js";
import type { RosterEntry } from "../../src/living/evolution.js";
import { LivingCompany } from "../../src/living/livingCompany.js";
import { InMemoryLivingStore } from "../../src/living/inMemoryLivingStore.js";
import type { Candidate, Role, Task } from "../../src/living/types.js";

const FIXED = () => new Date("2026-07-03T00:00:00.000Z");

function makeTask(taskId: string, role: Role, cost: number, shadow: boolean): Task {
  return {
    taskId,
    createdBy: "operator",
    roleRequired: role,
    priority: 3,
    title: taskId,
    spec: "",
    budgetCapUsd: cost,
    status: "done",
    claimedBy: "x",
    result: "ok",
    costActualUsd: cost,
    auditorScore: null,
    shadow,
    createdAt: FIXED().toISOString(),
    updatedAt: FIXED().toISOString()
  };
}

function scoreShared(
  auditor: Auditor,
  agentId: string,
  count: number,
  scoreOverall: number,
  shadow: boolean,
  prefix = "shared"
) {
  for (let i = 0; i < count; i += 1) {
    auditor.score(makeTask(`${prefix}-T${i}`, "architect", 1, shadow), {
      agentId,
      success: scoreOverall >= 5,
      scoreOverall,
      costEfficiency: 5,
      latencyMs: 100,
      errorRate: 0,
      rationale: "n"
    });
  }
}

function setup() {
  const store = new InMemoryLivingStore();
  const roster = new Map<Role, RosterEntry>([
    ["architect", { agentId: "arch-v1", model: "groq", config: JSON.stringify({ model: "groq" }) }],
    ["auditor", { agentId: "aud-v1", model: "gemini", config: "{}" }],
    ["breeder", { agentId: "bre-v1", model: "groq", config: "{}" }]
  ]);
  const company = new LivingCompany({
    store,
    roster,
    clock: FIXED,
    hardRules: {
      humanSpendCeilingUsd: 100000,
      swapRollbackWindowCycles: 3,
      auditorModel: "gemini",
      breederModel: "groq"
    }
  });
  return { store, roster, company };
}

function candidate(candidateId: string, role: Role, model: string): Candidate {
  return {
    candidateId,
    role,
    basePrompt: "prompt",
    model,
    toolset: [],
    hypothesis: "beats incumbent",
    createdBy: "breeder",
    createdAt: FIXED().toISOString()
  };
}

describe("EvolutionEngine", () => {
  it("swaps a winning candidate and archives the incumbent", () => {
    const { company, roster, store } = setup();
    scoreShared(company.auditor, "arch-v1", 20, 5, false);
    scoreShared(company.auditor, "arch-v2", 20, 7, true);

    const result = company.evolution.proposeSwap({
      role: "architect",
      candidate: candidate("arch-v2", "architect", "groq")
    });

    expect(result.swapped).toBe(true);
    expect(roster.get("architect")?.agentId).toBe("arch-v2");
    expect(store.getArchived("arch-v1")?.historicalAvgScorePerDollar).toBeCloseTo(5);
  });

  it("refuses a candidate that fails the margin", () => {
    const { company } = setup();
    scoreShared(company.auditor, "arch-v1", 20, 5, false);
    scoreShared(company.auditor, "arch-v2", 20, 5.2, true);
    const result = company.evolution.proposeSwap({
      role: "architect",
      candidate: candidate("arch-v2", "architect", "groq")
    });
    expect(result.swapped).toBe(false);
  });

  it("requires human approval to replace the Auditor", () => {
    const { company } = setup();
    expect(() =>
      company.evolution.proposeSwap({
        role: "auditor",
        candidate: candidate("aud-v2", "auditor", "openrouter")
      })
    ).toThrow(EvolutionError);
  });

  it("blocks a Breeder swap that would match the Auditor's model", () => {
    const { company } = setup();
    expect(() =>
      company.evolution.proposeSwap({
        role: "breeder",
        candidate: candidate("bre-v2", "breeder", "gemini")
      })
    ).toThrow(EvolutionError);
  });

  it("freezes swaps in deficit mode", () => {
    const { company } = setup();
    company.ledger.recordCost({ agentId: "architect", amountUsd: 100 });
    company.ledger.recordRevenue("content", 10);
    expect(() =>
      company.evolution.proposeSwap({
        role: "architect",
        candidate: candidate("arch-v2", "architect", "groq")
      })
    ).toThrow(EvolutionError);
  });

  it("rolls back a new agent that underperforms within the window", () => {
    const { company, roster } = setup();
    scoreShared(company.auditor, "arch-v1", 20, 5, false);
    scoreShared(company.auditor, "arch-v2", 20, 7, true);
    company.evolution.proposeSwap({
      role: "architect",
      candidate: candidate("arch-v2", "architect", "groq")
    });
    expect(roster.get("architect")?.agentId).toBe("arch-v2");

    // New agent performs poorly in live tasks, dragging its average below the
    // archived incumbent's historical average.
    scoreShared(company.auditor, "arch-v2", 20, 1, false, "live");

    company.evolution.advanceCycle();
    const rolledBack = company.evolution.checkRollbacks();
    expect(rolledBack).toHaveLength(1);
    expect(roster.get("architect")?.agentId).toBe("arch-v1");
  });
});
