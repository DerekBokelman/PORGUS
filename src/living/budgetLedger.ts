import { randomUUID } from "node:crypto";
import { type Clock, systemClock } from "./clock.js";
import type { HardRules } from "./hardRules.js";
import type { LivingStore } from "./store.js";
import type { CostEntry, OperatorMode, RevenueEntry } from "./types.js";

export interface ModeRules {
  mode: OperatorMode;
  experimentationFrozen: boolean;
  shadowBudgetsZeroed: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TRAILING_DAYS = 30;

// Self-sufficiency thresholds from the founding framework.
const DEFICIT_CEILING = 0.7; // < 70% coverage
const SURPLUS_FLOOR = 1.1; // > 110% coverage

export interface RecordCostInput {
  agentId: string;
  amountUsd: number;
  taskId?: string | null;
  shadow?: boolean;
}

export class BudgetLedger {
  constructor(
    private readonly store: LivingStore,
    private readonly hardRules: HardRules,
    private readonly clock: Clock = systemClock
  ) {}

  recordCost(input: RecordCostInput): CostEntry {
    // Rule 1: never exceed the human spend ceiling.
    this.hardRules.assertWithinCeiling(this.store.totalSpend(), input.amountUsd);

    const entry: CostEntry = {
      id: randomUUID(),
      taskId: input.taskId ?? null,
      agentId: input.agentId,
      amountUsd: input.amountUsd,
      shadow: input.shadow ?? false,
      createdAt: this.clock().toISOString()
    };
    this.store.insertCost(entry);
    return entry;
  }

  recordRevenue(source: string, amountUsd: number): RevenueEntry {
    const entry: RevenueEntry = {
      id: randomUUID(),
      source,
      amountUsd,
      createdAt: this.clock().toISOString()
    };
    this.store.insertRevenue(entry);
    return entry;
  }

  private trailingIso(): string {
    return new Date(this.clock().getTime() - TRAILING_DAYS * DAY_MS).toISOString();
  }

  trailingSpend(): number {
    return this.store
      .listCostsSince(this.trailingIso())
      .reduce((sum, entry) => sum + entry.amountUsd, 0);
  }

  trailingRevenue(): number {
    return this.store
      .listRevenueSince(this.trailingIso())
      .reduce((sum, entry) => sum + entry.amountUsd, 0);
  }

  // revenue / spend over trailing 30 days. No spend => treat as fully covered.
  coverageRatio(): number {
    const spend = this.trailingSpend();
    if (spend <= 0) {
      return this.trailingRevenue() > 0 ? Number.POSITIVE_INFINITY : 1;
    }
    return this.trailingRevenue() / spend;
  }

  mode(): OperatorMode {
    const coverage = this.coverageRatio();
    if (coverage < DEFICIT_CEILING) {
      return "deficit";
    }
    if (coverage > SURPLUS_FLOOR) {
      return "surplus";
    }
    return "balance";
  }

  modeRules(): ModeRules {
    const mode = this.mode();
    return {
      mode,
      experimentationFrozen: mode === "deficit",
      shadowBudgetsZeroed: mode === "deficit"
    };
  }

  remainingCeilingUsd(): number {
    return Math.max(0, this.hardRules.spendCeilingUsd - this.store.totalSpend());
  }
}
