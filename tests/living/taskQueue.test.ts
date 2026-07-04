import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/living/budgetLedger.js";
import { HardRules } from "../../src/living/hardRules.js";
import { InMemoryLivingStore } from "../../src/living/inMemoryLivingStore.js";
import { TaskQueue, TaskQueueError } from "../../src/living/taskQueue.js";

const FIXED = () => new Date("2026-07-03T00:00:00.000Z");

function setup(ceiling = 100000) {
  const store = new InMemoryLivingStore();
  const hardRules = new HardRules({
    humanSpendCeilingUsd: ceiling,
    swapRollbackWindowCycles: 3,
    auditorModel: "gemini",
    breederModel: "groq"
  });
  const ledger = new BudgetLedger(store, hardRules, FIXED);
  const queue = new TaskQueue(store, hardRules, ledger, FIXED);
  return { store, hardRules, ledger, queue };
}

const baseTask = {
  createdBy: "operator",
  roleRequired: "architect" as const,
  title: "Build retry logic",
  spec: "Add retry to executor",
  budgetCapUsd: 0.5
};

describe("TaskQueue", () => {
  it("refuses tasks without a positive budget cap", () => {
    const { queue } = setup();
    expect(() => queue.create({ ...baseTask, budgetCapUsd: 0 })).toThrow();
  });

  it("creates sequential task ids and logs the TASK message", () => {
    const { queue, store } = setup();
    const first = queue.create(baseTask);
    const second = queue.create(baseTask);
    expect(first.taskId).toBe("T-00001");
    expect(second.taskId).toBe("T-00002");
    expect(store.listRaw().some((entry) => entry.type === "TASK")).toBe(true);
  });

  it("only lets a matching role claim an open task", () => {
    const { queue } = setup();
    const task = queue.create(baseTask);
    expect(() => queue.claim(task.taskId, "auditor-v1", "auditor")).toThrow(TaskQueueError);
    const claimed = queue.claim(task.taskId, "architect-v1", "architect");
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimedBy).toBe("architect-v1");
  });

  it("records cost and marks a task done on completion", () => {
    const { queue, store } = setup();
    const task = queue.create(baseTask);
    queue.claim(task.taskId, "architect-v1", "architect");
    const done = queue.complete(task.taskId, {
      agentId: "architect-v1",
      result: "shipped",
      costActualUsd: 0.3
    });
    expect(done.status).toBe("done");
    expect(done.costActualUsd).toBeCloseTo(0.3);
    expect(store.totalSpend()).toBeCloseTo(0.3);
  });

  it("kills a task at its cap when actual cost exceeds the cap", () => {
    const { queue, store } = setup();
    const task = queue.create(baseTask);
    queue.claim(task.taskId, "architect-v1", "architect");
    const result = queue.complete(task.taskId, {
      agentId: "architect-v1",
      result: "runaway",
      costActualUsd: 5
    });
    expect(result.status).toBe("failed");
    expect(result.costActualUsd).toBeCloseTo(0.5);
    expect(store.totalSpend()).toBeCloseTo(0.5);
  });

  it("freezes shadow tasks in deficit mode", () => {
    const { queue, ledger } = setup();
    ledger.recordCost({ agentId: "architect", amountUsd: 100 });
    ledger.recordRevenue("content", 10);
    expect(ledger.mode()).toBe("deficit");
    expect(() => queue.create({ ...baseTask, shadow: true })).toThrow(TaskQueueError);
  });

  it("vetoes an open task", () => {
    const { queue } = setup();
    const task = queue.create(baseTask);
    const vetoed = queue.veto(task.taskId, "operator", "too expensive");
    expect(vetoed.status).toBe("vetoed");
    expect(vetoed.result).toBe("too expensive");
  });
});
