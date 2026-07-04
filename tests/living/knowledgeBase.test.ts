import { describe, expect, it } from "vitest";
import { InMemoryLivingStore } from "../../src/living/inMemoryLivingStore.js";
import { KnowledgeBase } from "../../src/living/knowledgeBase.js";

const FIXED = () => new Date("2026-07-03T00:00:00.000Z");

function makeKb() {
  return new KnowledgeBase(new InMemoryLivingStore(), FIXED);
}

describe("KnowledgeBase", () => {
  it("appends to the raw log and returns recent entries", () => {
    const kb = makeKb();
    kb.appendRaw("RESULT", "architect", "built queue", "T-00001");
    kb.appendRaw("SCORE", "auditor", "7.2/10", "T-00001");
    expect(kb.rawCount()).toBe(2);
    expect(kb.recentRaw(1)).toHaveLength(1);
    expect(kb.recentRaw(1)[0].type).toBe("SCORE");
  });

  it("upserts curated entries by key", () => {
    const kb = makeKb();
    kb.upsertCurated({ key: "strategy", category: "strategy", title: "Focus", body: "ship revenue" });
    kb.upsertCurated({ key: "strategy", category: "strategy", title: "Focus", body: "ship revenue faster" });
    expect(kb.listCurated()).toHaveLength(1);
    expect(kb.listCurated()[0].body).toBe("ship revenue faster");
  });

  it("adds do-not-repeat lessons from failures", () => {
    const kb = makeKb();
    kb.addDoNotRepeat("retry without backoff", "always use exponential backoff");
    const dnr = kb.listDoNotRepeat();
    expect(dnr).toHaveLength(1);
    expect(dnr[0].category).toBe("do-not-repeat");
    expect(dnr[0].body).toContain("exponential backoff");
  });

  it("caps injected curated context by a token budget", () => {
    const kb = makeKb();
    const big = "x".repeat(4000); // ~1000 tokens
    kb.upsertCurated({ key: "a", category: "strategy", title: "A", body: big });
    kb.upsertCurated({ key: "b", category: "lesson", title: "B", body: big });
    const context = kb.curatedContext({ tokenBudget: 1100 });
    expect(context).toContain("[strategy] A");
    expect(context).not.toContain("[lesson] B");
  });
});
