import { Auditor } from "./auditor.js";
import { BudgetLedger } from "./budgetLedger.js";
import { type Clock, systemClock } from "./clock.js";
import { EvolutionEngine, type RosterEntry } from "./evolution.js";
import { HardRules, type HardRuleConfig } from "./hardRules.js";
import { KnowledgeBase } from "./knowledgeBase.js";
import type { LivingStore } from "./store.js";
import { TaskQueue } from "./taskQueue.js";
import type { Role, Task } from "./types.js";

export interface LivingCompanyOptions {
  store: LivingStore;
  hardRules: HardRuleConfig;
  roster: Map<Role, RosterEntry>;
  clock?: Clock;
}

/**
 * Wires the three shared structures (task queue, knowledge base, budget ledger)
 * with the Auditor and EvolutionEngine into a single object graph.
 */
export class LivingCompany {
  readonly hardRules: HardRules;
  readonly ledger: BudgetLedger;
  readonly knowledge: KnowledgeBase;
  readonly queue: TaskQueue;
  readonly auditor: Auditor;
  readonly evolution: EvolutionEngine;

  constructor(options: LivingCompanyOptions) {
    const clock = options.clock ?? systemClock;
    this.hardRules = new HardRules(options.hardRules);
    this.ledger = new BudgetLedger(options.store, this.hardRules, clock);
    this.knowledge = new KnowledgeBase(options.store, clock);
    this.queue = new TaskQueue(options.store, this.hardRules, this.ledger, clock);
    this.auditor = new Auditor(options.store, clock);
    this.evolution = new EvolutionEngine(
      options.roster,
      options.store,
      this.auditor,
      this.hardRules,
      this.ledger,
      this.knowledge,
      clock
    );
  }

  listOpenTasks(): Task[] {
    return this.queue.listOpen();
  }

  getTask(taskId: string): Task | undefined {
    return this.queue.getTask(taskId);
  }
}
