import type { AgentDefinition } from "../types.js";
import type { MemoryStore } from "./memoryStore.js";

export class BudgetGuard {
  constructor(
    private readonly memory: MemoryStore,
    private readonly dailyRealCallLimit: number
  ) {}

  async canUseRealCall(agent: AgentDefinition, day = today()): Promise<boolean> {
    if (agent.provider === "mock") {
      return true;
    }

    const used = await this.memory.getDailyRealUsage(day);
    return used < this.dailyRealCallLimit;
  }

  async recordRealCall(agent: AgentDefinition, day = today()): Promise<void> {
    if (agent.provider === "mock") {
      return;
    }

    await this.memory.incrementDailyRealUsage(day);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
