import type { AgentResponder } from "../coordinator/conversationCoordinator.js";
import type { ConversationCoordinator } from "../coordinator/conversationCoordinator.js";

export interface AutonomousLoopOptions {
  coordinator: ConversationCoordinator;
  responder: AgentResponder;
  channelId: string;
  /** Delay between cycles while agents are actively working. */
  busyIntervalMs: number;
  /** Maximum delay between cycles when agents are idle (backoff ceiling). */
  idleIntervalMs: number;
  /** Optional short delay before the first tick (lets bots finish connecting). */
  startDelayMs?: number;
  log?: (message: string) => void;
}

/**
 * Drives the company without human input using an adaptive cadence:
 *  - When a cycle produces agent turns, run the next one quickly (busyIntervalMs).
 *  - When a cycle is idle (0 turns — e.g. every agent is budget/rate-limited or
 *    the kill switch is engaged), back off exponentially up to idleIntervalMs.
 *
 * This goes as fast as the free tiers allow, then eases off automatically instead
 * of hammering rate limits or burning the daily call budget on empty cycles.
 *
 * Cost is still hard-bounded elsewhere: the budget guard caps real calls per agent
 * per day and the spend ledger enforces the human spend ceiling.
 */
export class AutonomousLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false;
  private currentDelayMs: number;

  constructor(private readonly options: AutonomousLoopOptions) {
    this.currentDelayMs = options.busyIntervalMs;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const first = this.options.startDelayMs ?? this.options.busyIntervalMs;
    this.log(
      `Autonomous loop enabled: ${Math.round(this.options.busyIntervalMs / 1000)}s while busy, ` +
        `backing off to ${Math.round(this.options.idleIntervalMs / 1000)}s when idle.`
    );
    this.schedule(first);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single work cycle now. Returns the delay (ms) that should precede the
   * next cycle, based on whether this one produced work. Safe to call directly.
   */
  async tick(): Promise<number> {
    if (this.ticking) {
      return this.currentDelayMs;
    }
    this.ticking = true;
    try {
      const turns = await this.options.coordinator.runHeartbeat(
        this.options.channelId,
        this.options.responder
      );
      if (turns > 0) {
        this.currentDelayMs = this.options.busyIntervalMs;
      } else {
        this.currentDelayMs = Math.min(
          this.options.idleIntervalMs,
          Math.max(this.options.busyIntervalMs, this.currentDelayMs * 2)
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      this.log(`Work cycle skipped: ${reason}`);
      this.currentDelayMs = this.options.idleIntervalMs;
    } finally {
      this.ticking = false;
    }
    return this.currentDelayMs;
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick().then((nextDelay) => this.schedule(nextDelay));
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
