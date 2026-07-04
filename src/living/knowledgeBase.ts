import { randomUUID } from "node:crypto";
import { type Clock, systemClock } from "./clock.js";
import type { LivingStore } from "./store.js";
import type { CuratedCategory, CuratedEntry, MessageType, RawLogEntry, Role } from "./types.js";

// Rough token estimate: ~4 chars per token.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface CuratedInput {
  key: string;
  category: CuratedCategory;
  title: string;
  body: string;
}

export interface CuratedContextOptions {
  role?: Role;
  tokenBudget?: number;
}

export class KnowledgeBase {
  constructor(
    private readonly store: LivingStore,
    private readonly clock: Clock = systemClock
  ) {}

  // Raw log is append-only. There is deliberately no edit or delete method.
  appendRaw(type: MessageType | "SYSTEM", actor: string, payload: string, refId?: string): RawLogEntry {
    return this.store.appendRaw({
      id: randomUUID(),
      type,
      actor,
      refId: refId ?? null,
      payload,
      createdAt: this.clock().toISOString()
    });
  }

  recentRaw(limit = 50): RawLogEntry[] {
    return this.store.listRaw(limit);
  }

  rawCount(): number {
    return this.store.countRaw();
  }

  upsertCurated(input: CuratedInput): CuratedEntry {
    const entry: CuratedEntry = {
      key: input.key,
      category: input.category,
      title: input.title,
      body: input.body,
      tokenEstimate: estimateTokens(`${input.title}\n${input.body}`),
      updatedAt: this.clock().toISOString()
    };
    this.store.upsertCurated(entry);
    return entry;
  }

  // Every failure gets a do-not-repeat entry with the triggering condition.
  addDoNotRepeat(condition: string, lesson: string): CuratedEntry {
    const key = `dnr:${simpleHash(condition)}`;
    return this.upsertCurated({
      key,
      category: "do-not-repeat",
      title: `Do not repeat: ${truncate(condition, 80)}`,
      body: `Condition: ${condition}\nLesson: ${lesson}`
    });
  }

  listCurated(): CuratedEntry[] {
    return this.store.listCurated();
  }

  listDoNotRepeat(): CuratedEntry[] {
    return this.store.listCurated().filter((entry) => entry.category === "do-not-repeat");
  }

  compressionRatio(): number {
    const rawChars = this.store.listRaw().reduce((sum, entry) => sum + entry.payload.length, 0);
    const curatedChars = this.store
      .listCurated()
      .reduce((sum, entry) => sum + entry.body.length + entry.title.length, 0);
    if (rawChars <= 0) {
      return 1;
    }
    return curatedChars / rawChars;
  }

  // Curated context injected into agent prompts, capped by a hard token budget.
  curatedContext(options: CuratedContextOptions = {}): string {
    const budget = options.tokenBudget ?? 800;
    const entries = this.store
      .listCurated()
      .sort(byCategoryPriority)
      .slice();

    const lines: string[] = [];
    let used = 0;
    for (const entry of entries) {
      if (used + entry.tokenEstimate > budget) {
        continue;
      }
      lines.push(`- [${entry.category}] ${entry.title}: ${entry.body}`);
      used += entry.tokenEstimate;
    }
    return lines.join("\n");
  }
}

function byCategoryPriority(a: CuratedEntry, b: CuratedEntry): number {
  const order: Record<CuratedCategory, number> = {
    "do-not-repeat": 0,
    strategy: 1,
    protocol: 2,
    lesson: 3
  };
  return order[a.category] - order[b.category];
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
