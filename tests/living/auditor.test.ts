import { describe, expect, it } from "vitest";
import { Auditor } from "../../src/living/auditor.js";
import { InMemoryLivingStore } from "../../src/living/inMemoryLivingStore.js";
import type { Role, Task } from "../../src/living/types.js";

const FIXED = () => new Date("2026-07-03T00:00:00.000Z");

function makeTask(taskId: string, role: Role, cost: number, shadow = false): Task {
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

function scoreMany(
  auditor: Auditor,
  agentId: string,
  role: Role,
  count: number,
  scoreOverall: number,
  cost: number,
  opts: { shadow?: boolean; prefix?: string } = {}
) {
  for (let i = 0; i < count; i += 1) {
    const taskId = `${opts.prefix ?? agentId}-T${i}`;
    auditor.score(makeTask(taskId, role, cost, opts.shadow ?? false), {
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

describe("Auditor", () => {
  it("computes score-per-dollar from actual cost", () => {
    const auditor = new Auditor(new InMemoryLivingStore(), FIXED);
    const entry = auditor.score(makeTask("T-1", "architect", 2), {
      agentId: "architect-v1",
      success: true,
      scoreOverall: 8,
      costEfficiency: 6,
      latencyMs: 50,
      errorRate: 0,
      rationale: "solid"
    });
    expect(entry.scorePerDollar).toBeCloseTo(4);
  });

  it("builds a scoreboard from live scores, sorted by score-per-dollar", () => {
    const auditor = new Auditor(new InMemoryLivingStore(), FIXED);
    scoreMany(auditor, "architect-v1", "architect", 3, 6, 1);
    scoreMany(auditor, "operator-v1", "operator", 3, 9, 1);
    const board = auditor.scoreboard();
    expect(board[0].agentId).toBe("operator-v1");
    expect(board[1].agentId).toBe("architect-v1");
    expect(auditor.weakestAgent()?.agentId).toBe("architect-v1");
  });

  it("excludes shadow scores from the scoreboard", () => {
    const auditor = new Auditor(new InMemoryLivingStore(), FIXED);
    scoreMany(auditor, "cand-v1", "architect", 3, 9, 1, { shadow: true });
    expect(auditor.scoreboard()).toHaveLength(0);
  });

  it("rejects candidates on too-small samples", () => {
    const auditor = new Auditor(new InMemoryLivingStore(), FIXED);
    scoreMany(auditor, "inc", "architect", 5, 5, 1, { prefix: "shared" });
    scoreMany(auditor, "cand", "architect", 5, 9, 1, { prefix: "shared" });
    const comparison = auditor.compareCandidate("inc", "cand");
    expect(comparison.beats).toBe(false);
    expect(comparison.sampleSize).toBe(5);
  });

  it("passes candidates that beat the incumbent by the margin over enough tasks", () => {
    const auditor = new Auditor(new InMemoryLivingStore(), FIXED);
    scoreMany(auditor, "inc", "architect", 20, 5, 1, { prefix: "shared" });
    scoreMany(auditor, "cand", "architect", 20, 7, 1, { prefix: "shared", shadow: true });
    const comparison = auditor.compareCandidate("inc", "cand");
    expect(comparison.sampleSize).toBe(20);
    expect(comparison.beats).toBe(true);
  });

  it("fails a candidate whose margin is too thin", () => {
    const auditor = new Auditor(new InMemoryLivingStore(), FIXED);
    scoreMany(auditor, "inc", "architect", 20, 5, 1, { prefix: "shared" });
    scoreMany(auditor, "cand", "architect", 20, 5.5, 1, { prefix: "shared", shadow: true });
    expect(auditor.compareCandidate("inc", "cand").beats).toBe(false);
  });

  it("computes calibration error as mean absolute error", () => {
    const auditor = new Auditor(new InMemoryLivingStore(), FIXED);
    const error = auditor.calibrationError([
      { predicted: 8, realized: 7 },
      { predicted: 5, realized: 5 }
    ]);
    expect(error).toBeCloseTo(0.5);
  });
});
