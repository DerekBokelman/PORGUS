import type { AgentResponder } from "../coordinator/conversationCoordinator.js";
import type { ConversationCoordinator } from "../coordinator/conversationCoordinator.js";

export interface AutonomousLoopOptions {
  coordinator: ConversationCoordinator;
  responder: AgentResponder;
  channelId: string;
  /** Milliseconds between work cycles. */
  intervalMs: number;
  /** Optional short delay before the first tick (lets bots finish connecting). */
  startDelayMs?: number;
  log?: (message: string) => void;
}

/**
 * Drives the company without human input. On a fixed interval it asks the
 * ConversationCoordinator to run a heartbeat, which injects a synthetic work
 * cycle so agents claim tasks, execute, score, and grow on their own.
 *
 * Cost is bounded elsewhere: the budget guard caps real calls per agent per day
 * and the spend ledger enforces the human spend ceiling, so a stuck loop can
 * never run away.
 */
export class AutonomousLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false;

  constructor(private readonly options: AutonomousLoopOptions) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const first = this.options.startDelayMs ?? this.options.intervalMs;
    this.log(`Autonomous loop enabled: work cycle every ${Math.round(this.options.intervalMs / 1000)}s.`);
    this.schedule(first);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Run a single work cycle now. Safe to call directly (used by tests). */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.options.coordinator.runHeartbeat(this.options.channelId, this.options.responder);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      this.log(`Work cycle skipped: ${reason}`);
    } finally {
      this.ticking = false;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(this.options.intervalMs));
    }, delayMs);
    // Do not keep the process alive solely for the loop.
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  private log(message: string): void {
    (this.options.log ?? ((m: string) => console.log(m)))(message);
  }
}
