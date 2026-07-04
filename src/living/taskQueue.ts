import { randomUUID } from "node:crypto";
import type { BudgetLedger } from "./budgetLedger.js";
import { type Clock, systemClock } from "./clock.js";
import { HardRuleViolation, type HardRules } from "./hardRules.js";
import type { LivingStore } from "./store.js";
import type { CreateTaskInput, RawLogEntry, Role, Task } from "./types.js";

export interface CompleteTaskInput {
  agentId: string;
  result: string;
  costActualUsd: number;
}

export class TaskQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskQueueError";
  }
}

export class TaskQueue {
  constructor(
    private readonly store: LivingStore,
    private readonly hardRules: HardRules,
    private readonly ledger: BudgetLedger,
    private readonly clock: Clock = systemClock
  ) {}

  private log(type: RawLogEntry["type"], actor: string, refId: string | null, payload: string): void {
    this.store.appendRaw({
      id: randomUUID(),
      type,
      actor,
      refId,
      payload,
      createdAt: this.clock().toISOString()
    });
  }

  private nextTaskId(): string {
    const seq = this.store.countTasks() + 1;
    return `T-${String(seq).padStart(5, "0")}`;
  }

  create(input: CreateTaskInput): Task {
    this.hardRules.killSwitch.assertRunnable();
    // Rule: no task runs without a positive budget cap.
    this.hardRules.assertBudgetCap(input.budgetCapUsd);

    const shadow = input.shadow ?? false;
    const rules = this.ledger.modeRules();
    // Deficit mode freezes experimentation and zeroes shadow budgets.
    if (shadow && (rules.experimentationFrozen || rules.shadowBudgetsZeroed)) {
      throw new TaskQueueError("Shadow/experimental tasks are frozen in deficit mode.");
    }

    const nowIso = this.clock().toISOString();
    const task: Task = {
      taskId: this.nextTaskId(),
      createdBy: input.createdBy,
      roleRequired: input.roleRequired,
      priority: input.priority ?? 3,
      title: input.title,
      spec: input.spec,
      budgetCapUsd: input.budgetCapUsd,
      status: "open",
      claimedBy: null,
      result: null,
      costActualUsd: null,
      auditorScore: null,
      shadow,
      createdAt: nowIso,
      updatedAt: nowIso
    };

    this.store.insertTask(task);
    this.log("TASK", input.createdBy, task.taskId, `${task.title} [${task.roleRequired}]`);
    return task;
  }

  claim(taskId: string, agentId: string, role: Role): Task {
    this.hardRules.killSwitch.assertRunnable();
    const task = this.requireTask(taskId);

    if (task.status !== "open") {
      throw new TaskQueueError(`Task ${taskId} is not open (status: ${task.status}).`);
    }
    if (task.roleRequired !== role) {
      throw new TaskQueueError(
        `Task ${taskId} requires role ${task.roleRequired}, not ${role}.`
      );
    }

    const updated: Task = {
      ...task,
      status: "claimed",
      claimedBy: agentId,
      updatedAt: this.clock().toISOString()
    };
    this.store.replaceTask(updated);
    return updated;
  }

  complete(taskId: string, input: CompleteTaskInput): Task {
    this.hardRules.killSwitch.assertRunnable();
    const task = this.requireTask(taskId);

    if (task.status !== "claimed") {
      throw new TaskQueueError(`Task ${taskId} must be claimed before completion.`);
    }

    // Runaway loops die at the cap, not at the credit card limit.
    if (input.costActualUsd > task.budgetCapUsd) {
      return this.failInternal(task, {
        agentId: input.agentId,
        result: `Budget cap exceeded: ${input.costActualUsd} > ${task.budgetCapUsd}. Killed at cap.`,
        costActualUsd: task.budgetCapUsd
      });
    }

    this.recordCost(task, input.agentId, input.costActualUsd);
    const updated: Task = {
      ...task,
      status: "done",
      result: input.result,
      costActualUsd: input.costActualUsd,
      updatedAt: this.clock().toISOString()
    };
    this.store.replaceTask(updated);
    this.log("RESULT", input.agentId, task.taskId, truncate(input.result));
    return updated;
  }

  fail(taskId: string, input: CompleteTaskInput): Task {
    this.hardRules.killSwitch.assertRunnable();
    const task = this.requireTask(taskId);
    return this.failInternal(task, input);
  }

  private failInternal(task: Task, input: CompleteTaskInput): Task {
    const cappedCost = Math.min(input.costActualUsd, task.budgetCapUsd);
    if (cappedCost > 0) {
      this.recordCost(task, input.agentId, cappedCost);
    }
    const updated: Task = {
      ...task,
      status: "failed",
      result: input.result,
      costActualUsd: cappedCost,
      updatedAt: this.clock().toISOString()
    };
    this.store.replaceTask(updated);
    this.log("RESULT", input.agentId, task.taskId, `FAILED: ${truncate(input.result)}`);
    return updated;
  }

  veto(taskId: string, actor: string, reason: string): Task {
    const task = this.requireTask(taskId);
    const updated: Task = {
      ...task,
      status: "vetoed",
      result: reason,
      updatedAt: this.clock().toISOString()
    };
    this.store.replaceTask(updated);
    this.log("VETO", actor, task.taskId, reason);
    return updated;
  }

  private recordCost(task: Task, agentId: string, amountUsd: number): void {
    try {
      this.ledger.recordCost({
        agentId,
        amountUsd,
        taskId: task.taskId,
        shadow: task.shadow
      });
    } catch (error) {
      if (error instanceof HardRuleViolation) {
        throw new TaskQueueError(error.message);
      }
      throw error;
    }
  }

  private requireTask(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new TaskQueueError(`Unknown task: ${taskId}`);
    }
    return task;
  }

  getTask(taskId: string): Task | undefined {
    return this.store.getTask(taskId);
  }

  listOpen(): Task[] {
    return this.store.listTasks({ status: "open" });
  }

  listDoneUnscored(): Task[] {
    return this.store.listTasks({ status: "done" }).filter((task) => task.auditorScore == null);
  }
}

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
