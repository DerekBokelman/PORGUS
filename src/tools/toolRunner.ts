import type { AgentDefinition } from "../types.js";
import type { CuratedCategory } from "../living/types.js";

/** Non-Slack tools agents drive via `[TOOL] name=... k=v` tags. */
export interface ToolCall {
  name: string;
  args: Record<string, string>;
}

/** Minimal memory surface the tool runner needs (backed by the KnowledgeBase). */
export interface ToolMemory {
  remember(input: { key: string; category: CuratedCategory; title: string; body: string }): void;
  recall(query?: string): string;
}

const TAG = /\[TOOL\]\s*([^\[]*)/gi;

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    fields[match[1]] = match[3] ?? match[4] ?? match[5] ?? "";
  }
  return fields;
}

export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG.exec(text)) !== null) {
    const fields = parseFields(match[1].trim());
    const { name, ...args } = fields;
    if (name) {
      calls.push({ name: name.toLowerCase(), args });
    }
  }
  return calls;
}

export const TOOL_NAMES = ["web_search", "http_fetch", "remember", "recall", "calc"] as const;

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Executes non-Slack tools that expand what agents can do: search the web,
 * fetch pages, and read/write the company's long-term memory. Failures come
 * back as readable strings so a bad call never crashes an agent's turn.
 */
export class AgentToolRunner {
  constructor(private readonly memory?: ToolMemory) {}

  async run(agent: AgentDefinition, rawText: string): Promise<string[]> {
    const calls = parseToolCalls(rawText);
    const notes: string[] = [];
    for (const call of calls) {
      notes.push(await this.execute(agent, call));
    }
    return notes;
  }

  private async execute(agent: AgentDefinition, call: ToolCall): Promise<string> {
    try {
      switch (call.name) {
        case "web_search":
          return await this.webSearch(call.args.query || call.args.q || "");
        case "http_fetch":
          return await this.httpFetch(call.args.url || call.args.link || "");
        case "remember":
          return this.remember(agent, call.args);
        case "recall":
          return this.recall(call.args.query || call.args.q);
        case "calc":
          return this.calc(call.args.expr || call.args.expression || "");
        default:
          return `Unknown tool "${call.name}". Available: ${TOOL_NAMES.join(", ")}`;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      return `${call.name} errored: ${reason}`;
    }
  }

  private async webSearch(query: string): Promise<string> {
    if (!query) return "web_search skipped: missing query";
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&t=agent-company`;
    const res = await fetchWithTimeout(url, 8000);
    if (!res.ok) return `web_search failed: HTTP ${res.status}`;
    const data = (await res.json()) as {
      AbstractText?: string;
      Answer?: string;
      RelatedTopics?: Array<{ Text?: string }>;
    };
    const abstract = data.AbstractText || data.Answer;
    if (abstract) return `web_search "${query}": ${truncate(abstract, 400)}`;
    const related = (data.RelatedTopics ?? [])
      .map((t) => t.Text)
      .filter(Boolean)
      .slice(0, 3)
      .join(" | ");
    return related
      ? `web_search "${query}": ${truncate(related, 400)}`
      : `web_search "${query}": no direct answer`;
  }

  private async httpFetch(rawUrl: string): Promise<string> {
    if (!/^https?:\/\//i.test(rawUrl)) return "http_fetch skipped: need http(s) url";
    const res = await fetchWithTimeout(rawUrl, 8000);
    if (!res.ok) return `http_fetch ${rawUrl}: HTTP ${res.status}`;
    const body = await res.text();
    const text = stripHtml(body);
    return `http_fetch ${rawUrl}: ${truncate(text, 600)}`;
  }

  private remember(agent: AgentDefinition, args: Record<string, string>): string {
    if (!this.memory) return "remember unavailable";
    const body = args.body || args.text || args.value || "";
    if (!body) return "remember skipped: missing body";
    const title = args.title || truncate(body, 60);
    const key = args.key || `mem:${agent.id}:${simpleHash(title)}`;
    const category = normalizeCategory(args.category);
    this.memory.remember({ key, category, title, body });
    return `Remembered "${title}"`;
  }

  private recall(query?: string): string {
    if (!this.memory) return "recall unavailable";
    const out = this.memory.recall(query);
    return out ? `Recall: ${truncate(out, 600)}` : "Recall: nothing stored yet";
  }

  private calc(expr: string): string {
    if (!expr) return "calc skipped: missing expr";
    if (!/^[-+*/(). 0-9%]+$/.test(expr)) return "calc rejected: only numbers and + - * / ( ) % allowed";
    try {
      // Safe: input restricted to arithmetic characters above.
      const value = Function(`"use strict"; return (${expr});`)() as number;
      return Number.isFinite(value) ? `calc ${expr} = ${value}` : "calc: non-finite result";
    } catch {
      return "calc: invalid expression";
    }
  }
}

function normalizeCategory(value?: string): CuratedCategory {
  const allowed: CuratedCategory[] = ["lesson", "strategy", "protocol", "do-not-repeat"];
  return allowed.includes(value as CuratedCategory) ? (value as CuratedCategory) : "lesson";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
