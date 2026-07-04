import type { Auditor, CompareOptions } from "./auditor.js";
import type { BudgetLedger } from "./budgetLedger.js";
import { type Clock, systemClock } from "./clock.js";
import { HardRuleViolation, type HardRules } from "./hardRules.js";
import type { KnowledgeBase } from "./knowledgeBase.js";
import type { LivingStore } from "./store.js";
import type { Candidate, Role } from "./types.js";

export interface RosterEntry {
  agentId: string;
  model: string;
  config: string;
}

export interface SwapRecord {
  role: Role;
  archivedAgentId: string;
  newAgentId: string;
  cycle: number;
}

export interface ProposeSwapInput {
  role: Role;
  candidate: Candidate;
  humanApproved?: boolean;
  compareOptions?: CompareOptions;
}

export interface SwapResult {
  swapped: boolean;
  reason: string;
  record?: SwapRecord;
}

export class EvolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionError";
  }
}

export class EvolutionEngine {
  private cycle = 1;
  private readonly swaps: SwapRecord[] = [];

  constructor(
    private readonly roster: Map<Role, RosterEntry>,
    private readonly store: LivingStore,
    private readonly auditor: Auditor,
    private readonly hardRules: HardRules,
    private readonly ledger: BudgetLedger,
    private readonly knowledge: KnowledgeBase,
    private readonly clock: Clock = systemClock
  ) {}

  currentCycle(): number {
    return this.cycle;
  }

  advanceCycle(): number {
    this.cycle += 1;
    return this.cycle;
  }

  incumbent(role: Role): RosterEntry | undefined {
    return this.roster.get(role);
  }

  rosterSnapshot(): Record<string, RosterEntry> {
    return Object.fromEntries(this.roster.entries());
  }

  // Draft -> shadow -> Auditor verdict -> protocol swap. No shortcuts.
  proposeSwap(input: ProposeSwapInput): SwapResult {
    this.hardRules.killSwitch.assertRunnable();

    if (this.ledger.modeRules().experimentationFrozen) {
      throw new EvolutionError("Experimentation frozen (deficit mode). No swaps.");
    }

    const incumbent = this.roster.get(input.role);
    if (!incumbent) {
      throw new EvolutionError(`No incumbent for role ${input.role}.`);
    }

    // Rule 3: Auditor replacement always requires human approval.
    try {
      this.hardRules.assertSwapAllowed(input.role, input.humanApproved ?? false);
    } catch (error) {
      if (error instanceof HardRuleViolation) {
        throw new EvolutionError(error.message);
      }
      throw error;
    }

    // Rule 4: Breeder and Auditor must run on different base models.
    this.assertModelIndependenceAfterSwap(input.role, input.candidate.model);

    // Auditor is the fitness function: candidate must beat incumbent by margin.
    const comparison = this.auditor.compareCandidate(
      incumbent.agentId,
      input.candidate.candidateId,
      input.compareOptions
    );
    if (!comparison.beats) {
      return { swapped: false, reason: comparison.reason };
    }

    // Firing is archival, not deletion.
    const historicalAvg = this.auditor.summaryFor(incumbent.agentId).avgScorePerDollar;
    this.store.archiveAgent({
      agentId: incumbent.agentId,
      role: input.role,
      config: incumbent.config,
      historicalAvgScorePerDollar: historicalAvg,
      reason: comparison.reason,
      archivedAt: this.clock().toISOString(),
      archivedAtCycle: this.cycle
    });

    this.knowledge.appendRaw(
      "SYSTEM",
      "evolution",
      `SWAP ${input.role}: ${incumbent.agentId} -> ${input.candidate.candidateId} @cycle ${this.cycle}`
    );

    this.roster.set(input.role, {
      agentId: input.candidate.candidateId,
      model: input.candidate.model,
      config: JSON.stringify(input.candidate)
    });

    const record: SwapRecord = {
      role: input.role,
      archivedAgentId: incumbent.agentId,
      newAgentId: input.candidate.candidateId,
      cycle: this.cycle
    };
    this.swaps.push(record);
    this.writeTransitionRecord(record, historicalAvg, comparison.reason);
    return { swapped: true, reason: comparison.reason, record };
  }

  // If a new agent's live performance drops below the archived agent's historical
  // average within the rollback window, roll back automatically.
  checkRollbacks(): SwapRecord[] {
    const rolledBack: SwapRecord[] = [];
    for (const swap of [...this.swaps]) {
      const age = this.cycle - swap.cycle;
      if (age <= 0 || age > this.hardRules.rollbackWindowCycles) {
        continue;
      }
      const current = this.roster.get(swap.role);
      if (!current || current.agentId !== swap.newAgentId) {
        continue;
      }
      const summary = this.auditor.summaryFor(swap.newAgentId);
      if (summary.samples === 0) {
        continue;
      }
      const archived = this.store.getArchived(swap.archivedAgentId);
      const historicalAvg = archived?.historicalAvgScorePerDollar ?? 0;
      if (summary.avgScorePerDollar < historicalAvg) {
        this.rollback(swap, archived?.config ?? "");
        rolledBack.push(swap);
      }
    }
    return rolledBack;
  }

  private rollback(swap: SwapRecord, archivedConfig: string): void {
    let model = "";
    try {
      const parsed = JSON.parse(archivedConfig) as { model?: string };
      model = parsed.model ?? "";
    } catch {
      model = "";
    }
    this.roster.set(swap.role, {
      agentId: swap.archivedAgentId,
      model,
      config: archivedConfig
    });
    this.knowledge.appendRaw(
      "SYSTEM",
      "evolution",
      `ROLLBACK ${swap.role}: restored ${swap.archivedAgentId} (new agent underperformed within window)`
    );
    this.knowledge.upsertCurated({
      key: `transition:${swap.role}:rollback:${swap.cycle}`,
      category: "lesson",
      title: `Rollback of ${swap.role} swap from cycle ${swap.cycle}`,
      body: `Agent ${swap.newAgentId} dropped below archived ${swap.archivedAgentId}'s historical average within the rollback window. Restored incumbent.`
    });
  }

  private writeTransitionRecord(record: SwapRecord, historicalAvg: number, reason: string): void {
    this.knowledge.upsertCurated({
      key: `transition:${record.role}:${record.cycle}`,
      category: "lesson",
      title: `Transition ${record.role} @cycle ${record.cycle}`,
      body: `Replaced ${record.archivedAgentId} (hist score/$ ${historicalAvg.toFixed(3)}) with ${record.newAgentId}. Reason: ${reason}.`
    });
  }

  private assertModelIndependenceAfterSwap(role: Role, newModel: string): void {
    let breederModel = this.roster.get("breeder")?.model ?? "";
    let auditorModel = this.roster.get("auditor")?.model ?? "";
    if (role === "breeder") {
      breederModel = newModel;
    }
    if (role === "auditor") {
      auditorModel = newModel;
    }
    try {
      this.hardRules.assertModelIndependence(breederModel, auditorModel);
    } catch (error) {
      if (error instanceof HardRuleViolation) {
        throw new EvolutionError(error.message);
      }
      throw error;
    }
  }
}
