import { describe, expect, it } from "vitest";
import { inferRoleFromText } from "../../src/living/runtime.js";

describe("inferRoleFromText", () => {
  it("prefers explicit role labels in kickoff prompts", () => {
    const text =
      "Living Company go live. Architect: simplest next build. Auditor: score metrics. Chronicler: log lesson.";
    expect(inferRoleFromText(text)).toBe("architect");
  });

  it("routes auditor work from metrics language", () => {
    expect(inferRoleFromText("Auditor: score metrics for last sprint")).toBe("auditor");
  });

  it("defaults general goals to architect", () => {
    expect(inferRoleFromText("Ship the product faster")).toBe("architect");
  });
});
