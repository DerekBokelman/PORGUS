import type { Role } from "./types.js";

export interface HardRuleConfig {
  humanSpendCeilingUsd: number;
  swapRollbackWindowCycles: number;
  auditorModel: string;
  breederModel: string;
}

export const MIN_ROLLBACK_WINDOW_CYCLES = 3;

export class HardRuleViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HardRuleViolation";
  }
}

// Rule 2: one command halts all agent execution.
export class KillSwitch {
  private engaged = false;

  halt(): void {
    this.engaged = true;
  }

  resume(): void {
    this.engaged = false;
  }

  isEngaged(): boolean {
    return this.engaged;
  }

  assertRunnable(): void {
    if (this.engaged) {
      throw new HardRuleViolation("Kill switch engaged: agent execution halted.");
    }
  }
}

export class HardRules {
  readonly killSwitch = new KillSwitch();

  constructor(private readonly config: HardRuleConfig) {
    if (config.swapRollbackWindowCycles < MIN_ROLLBACK_WINDOW_CYCLES) {
      throw new HardRuleViolation(
        `Rollback window must be >= ${MIN_ROLLBACK_WINDOW_CYCLES} cycles.`
      );
    }
    this.assertModelIndependence(config.breederModel, config.auditorModel);
  }

  get spendCeilingUsd(): number {
    return this.config.humanSpendCeilingUsd;
  }

  get rollbackWindowCycles(): number {
    return this.config.swapRollbackWindowCycles;
  }

  // Rule 1: total system spend has a human-set ceiling. Agents cannot raise it.
  assertWithinCeiling(currentTotalSpendUsd: number, nextChargeUsd: number): void {
    if (nextChargeUsd < 0) {
      throw new HardRuleViolation("Charge cannot be negative.");
    }
    if (currentTotalSpendUsd + nextChargeUsd > this.config.humanSpendCeilingUsd) {
      throw new HardRuleViolation(
        "Human spend ceiling reached. Only the human can raise it."
      );
    }
  }

  // Every task must carry a budget cap; runaway loops die at the cap.
  assertBudgetCap(budgetCapUsd: number | null | undefined): void {
    if (budgetCapUsd == null || budgetCapUsd <= 0) {
      throw new HardRuleViolation("No task runs without a positive budget cap.");
    }
  }

  // Rule 4: creator and judge stay independent.
  // "mock" is a placeholder provider used for local testing and is exempt.
  assertModelIndependence(breederModel: string, auditorModel: string): void {
    if (!breederModel.trim() || breederModel === "mock" || auditorModel === "mock") {
      return;
    }
    if (breederModel === auditorModel) {
      throw new HardRuleViolation("Breeder and Auditor must run on different base models.");
    }
  }

  // Rule 3: the fitness function is sacred.
  requiresHumanApproval(role: Role): boolean {
    return role === "auditor";
  }

  assertSwapAllowed(role: Role, humanApproved: boolean): void {
    if (this.requiresHumanApproval(role) && !humanApproved) {
      throw new HardRuleViolation("Auditor replacement requires human approval.");
    }
  }

  // Rule 8: measurement and memory are never defunded.
  isProtectedFromDefunding(role: Role): boolean {
    return role === "auditor" || role === "chronicler";
  }
}
