import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/living/budgetLedger.js";
import { HardRules } from "../../src/living/hardRules.js";
import { HeadcountManager } from "../../src/living/headcount.js";
import { InMemoryLivingStore } from "../../src/living/inMemoryLivingStore.js";

const FIXED = () => new Date("2026-07-03T00:00:00.000Z");

function setup(max = 10) {
  const store = new InMemoryLivingStore();
  const hardRules = new HardRules({
    humanSpendCeilingUsd: 100000,
    swapRollbackWindowCycles: 3,
    auditorModel: "gemini",
    breederModel: "groq"
  });
  const ledger = new BudgetLedger(store, hardRules, FIXED);
  const headcount = new HeadcountManager(store, ledger, {
    humanMaxSlots: max,
    coreAgentCount: 5
  });
  headcount.initialize();
  return { store, ledger, headcount };
}

describe("HeadcountManager", () => {
  it("starts at core agent count", () => {
    const { headcount } = setup();
    expect(headcount.state().activeSlotLimit).toBe(5);
    expect(headcount.availableSlots()).toBe(0);
  });

  it("approves +1 slot in surplus mode automatically", () => {
    const { ledger, headcount } = setup();
    ledger.recordCost({ agentId: "architect", amountUsd: 10 });
    ledger.recordRevenue("content", 50);
    expect(ledger.mode()).toBe("surplus");

    const proposal = headcount.proposeHeadcount({
      requestedSlots: 1,
      reason: "Need researcher",
      createdBy: "breeder"
    });
    headcount.approveProposal(proposal.proposalId, "operator");
    expect(headcount.state().activeSlotLimit).toBe(6);
    expect(headcount.availableSlots()).toBe(1);
  });

  it("blocks headcount increase in deficit without human approval", () => {
    const { ledger, headcount } = setup();
    ledger.recordCost({ agentId: "architect", amountUsd: 100 });
    ledger.recordRevenue("content", 10);
    const proposal = headcount.proposeHeadcount({
      requestedSlots: 1,
      reason: "Need help",
      createdBy: "breeder"
    });
    expect(() => headcount.approveProposal(proposal.proposalId, "operator")).toThrow();
    headcount.approveProposal(proposal.proposalId, "human", { humanApproved: true });
    expect(headcount.state().activeSlotLimit).toBe(6);
  });

  it("registers a new agent when an agent proposal is approved", () => {
    const { store, ledger, headcount } = setup();
    ledger.recordCost({ agentId: "architect", amountUsd: 10 });
    ledger.recordRevenue("content", 50);
    headcount.approveProposal(
      headcount.proposeHeadcount({ requestedSlots: 1, reason: "expand", createdBy: "breeder" })
        .proposalId,
      "operator"
    );

    const proposal = headcount.proposeAgent({
      id: "researcher",
      displayName: "Researcher",
      roleDescription: "Finds evidence",
      personality: "Curious",
      createdBy: "breeder"
    });
    headcount.approveProposal(proposal.proposalId, "human", { humanApproved: true });
    expect(headcount.activeAgentCount()).toBe(6);
    expect(store.listDynamicAgents("active")).toHaveLength(1);
  });
});
