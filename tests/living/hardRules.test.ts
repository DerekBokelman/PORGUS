import { describe, expect, it } from "vitest";
import { HardRuleViolation, HardRules } from "../../src/living/hardRules.js";

function makeRules() {
  return new HardRules({
    humanSpendCeilingUsd: 100,
    swapRollbackWindowCycles: 3,
    auditorModel: "gemini",
    breederModel: "groq"
  });
}

describe("HardRules", () => {
  it("halts execution via the kill switch", () => {
    const rules = makeRules();
    expect(rules.killSwitch.isEngaged()).toBe(false);
    rules.killSwitch.halt();
    expect(() => rules.killSwitch.assertRunnable()).toThrow(HardRuleViolation);
    rules.killSwitch.resume();
    expect(() => rules.killSwitch.assertRunnable()).not.toThrow();
  });

  it("enforces the human spend ceiling", () => {
    const rules = makeRules();
    expect(() => rules.assertWithinCeiling(90, 5)).not.toThrow();
    expect(() => rules.assertWithinCeiling(90, 20)).toThrow(HardRuleViolation);
  });

  it("requires a positive budget cap on every task", () => {
    const rules = makeRules();
    expect(() => rules.assertBudgetCap(0)).toThrow(HardRuleViolation);
    expect(() => rules.assertBudgetCap(undefined)).toThrow(HardRuleViolation);
    expect(() => rules.assertBudgetCap(0.5)).not.toThrow();
  });

  it("keeps Breeder and Auditor on different models", () => {
    expect(
      () =>
        new HardRules({
          humanSpendCeilingUsd: 100,
          swapRollbackWindowCycles: 3,
          auditorModel: "gemini",
          breederModel: "gemini"
        })
    ).toThrow(HardRuleViolation);
  });

  it("requires human approval to replace the Auditor", () => {
    const rules = makeRules();
    expect(rules.requiresHumanApproval("auditor")).toBe(true);
    expect(rules.requiresHumanApproval("architect")).toBe(false);
    expect(() => rules.assertSwapAllowed("auditor", false)).toThrow(HardRuleViolation);
    expect(() => rules.assertSwapAllowed("auditor", true)).not.toThrow();
    expect(() => rules.assertSwapAllowed("architect", false)).not.toThrow();
  });

  it("rejects a rollback window shorter than three cycles", () => {
    expect(
      () =>
        new HardRules({
          humanSpendCeilingUsd: 100,
          swapRollbackWindowCycles: 2,
          auditorModel: "gemini",
          breederModel: "groq"
        })
    ).toThrow(HardRuleViolation);
  });

  it("protects measurement and memory from defunding", () => {
    const rules = makeRules();
    expect(rules.isProtectedFromDefunding("auditor")).toBe(true);
    expect(rules.isProtectedFromDefunding("chronicler")).toBe(true);
    expect(rules.isProtectedFromDefunding("breeder")).toBe(false);
  });
});
