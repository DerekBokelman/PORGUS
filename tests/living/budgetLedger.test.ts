import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/living/budgetLedger.js";
import { HardRuleViolation, HardRules } from "../../src/living/hardRules.js";
import { InMemoryLivingStore } from "../../src/living/inMemoryLivingStore.js";

const FIXED = () => new Date("2026-07-03T00:00:00.000Z");

function makeLedger(ceiling = 100000) {
  const store = new InMemoryLivingStore();
  const hardRules = new HardRules({
    humanSpendCeilingUsd: ceiling,
    swapRollbackWindowCycles: 3,
    auditorModel: "gemini",
    breederModel: "groq"
  });
  return { ledger: new BudgetLedger(store, hardRules, FIXED), store };
}

describe("BudgetLedger", () => {
  it("declares deficit mode when revenue is below 70% of spend", () => {
    const { ledger } = makeLedger();
    ledger.recordCost({ agentId: "architect", amountUsd: 100 });
    ledger.recordRevenue("content", 50);
    expect(ledger.coverageRatio()).toBeCloseTo(0.5);
    expect(ledger.mode()).toBe("deficit");
    expect(ledger.modeRules().experimentationFrozen).toBe(true);
    expect(ledger.modeRules().shadowBudgetsZeroed).toBe(true);
  });

  it("declares balance mode between 70% and 110%", () => {
    const { ledger } = makeLedger();
    ledger.recordCost({ agentId: "architect", amountUsd: 100 });
    ledger.recordRevenue("content", 90);
    expect(ledger.mode()).toBe("balance");
    expect(ledger.modeRules().experimentationFrozen).toBe(false);
  });

  it("declares surplus mode above 110%", () => {
    const { ledger } = makeLedger();
    ledger.recordCost({ agentId: "architect", amountUsd: 100 });
    ledger.recordRevenue("content", 200);
    expect(ledger.mode()).toBe("surplus");
  });

  it("treats zero spend as covered", () => {
    const { ledger } = makeLedger();
    expect(ledger.mode()).toBe("balance");
  });

  it("blocks spend past the human ceiling", () => {
    const { ledger } = makeLedger(10);
    ledger.recordCost({ agentId: "architect", amountUsd: 8 });
    expect(() => ledger.recordCost({ agentId: "architect", amountUsd: 5 })).toThrow(
      HardRuleViolation
    );
    expect(ledger.remainingCeilingUsd()).toBeCloseTo(2);
  });
});
