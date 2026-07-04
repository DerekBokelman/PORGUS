import { describe, expect, it } from "vitest";
import { parseProtocol, stripProtocol } from "../../src/living/protocol.js";

describe("parseProtocol", () => {
  it("parses TASK tags", () => {
    const actions = parseProtocol('[TASK] role=architect cap=0.25 title="Build queue" spec=Add retry');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "TASK",
      role: "architect",
      cap: 0.25,
      title: "Build queue"
    });
  });

  it("parses headcount and agent proposals", () => {
    const actions = parseProtocol(
      "[PROPOSAL] kind=headcount slots=1 reason=Need researcher\n" +
        '[PROPOSAL] kind=agent id=researcher display=Researcher role="Find facts" reason=gap'
    );
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: "PROPOSAL", kind: "headcount", slots: 1 });
    expect(actions[1]).toMatchObject({ type: "PROPOSAL", kind: "agent", agentId: "researcher" });
  });

  it("strips protocol tags from display text", () => {
    const text = "Done.\n[RESULT] task=T-00001 cost=0.01 body=shipped";
    expect(stripProtocol(text)).toBe("Done.");
  });
});
