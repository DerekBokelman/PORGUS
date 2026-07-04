import type { Role } from "./types.js";

export type ProtocolAction =
  | { type: "TASK"; role: Role; cap: number; title: string; spec: string; priority?: number }
  | { type: "CLAIM"; taskId: string }
  | { type: "RESULT"; taskId: string; cost: number; body: string }
  | { type: "SCORE"; taskId: string; overall: number; costEff: number; rationale: string }
  | {
      type: "PROPOSAL";
      kind: "headcount" | "agent";
      slots?: number;
      reason: string;
      agentId?: string;
      displayName?: string;
      roleDescription?: string;
      personality?: string;
      proposalId?: string;
    }
  | { type: "VETO"; ref: string; reason: string }
  | { type: "REVENUE"; source: string; amount: number }
  | { type: "LESSON"; trigger: string; body: string }
  | { type: "APPROVE"; ref: string };

const TAG = /\[([A-Z]+)\]\s*([^\[]*)/g;

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    fields[match[1]] = match[3] ?? match[4] ?? match[5] ?? "";
  }
  return fields;
}

function parseRole(value: string | undefined): Role | null {
  const roles: Role[] = ["architect", "auditor", "operator", "breeder", "chronicler"];
  return roles.includes(value as Role) ? (value as Role) : null;
}

/** Parse a numeric field, tolerating junk like "0.25usd"; falls back when unusable. */
function safeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const match = value.match(/-?\d+(\.\d+)?/);
  const parsed = match ? Number(match[0]) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseProtocol(text: string): ProtocolAction[] {
  const actions: ProtocolAction[] = [];
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG.exec(text)) !== null) {
    const tag = match[1];
    const body = match[2].trim();
    const f = parseFields(body);

    switch (tag) {
      case "TASK": {
        const role = parseRole(f.role);
        if (!role) {
          break;
        }
        const cap = safeNumber(f.cap ?? f.budget, 0.25);
        actions.push({
          type: "TASK",
          role,
          cap: cap > 0 ? cap : 0.25,
          title: f.title ?? "Untitled task",
          spec: f.spec ?? f.body ?? body,
          priority: f.priority ? safeNumber(f.priority, 3) : undefined
        });
        break;
      }
      case "CLAIM":
        if (f.task) {
          actions.push({ type: "CLAIM", taskId: f.task });
        }
        break;
      case "RESULT":
        if (f.task) {
          actions.push({
            type: "RESULT",
            taskId: f.task,
            cost: safeNumber(f.cost, 0.01),
            body: f.body ?? body
          });
        }
        break;
      case "SCORE":
        if (f.task) {
          actions.push({
            type: "SCORE",
            taskId: f.task,
            overall: safeNumber(f.overall ?? f.score, 5),
            costEff: safeNumber(f.cost_eff ?? f.costEff, 5),
            rationale: f.rationale ?? f.reason ?? "scored"
          });
        }
        break;
      case "PROPOSAL": {
        const kind = f.kind === "agent" ? "agent" : "headcount";
        actions.push({
          type: "PROPOSAL",
          kind,
          slots: f.slots ? safeNumber(f.slots, 1) : 1,
          reason: f.reason ?? body,
          agentId: f.id ?? f.agentId,
          displayName: f.display ?? f.displayName,
          roleDescription: f.role ?? f.roleDescription,
          personality: f.personality,
          proposalId: f.ref ?? f.proposalId
        });
        break;
      }
      case "VETO":
        if (f.ref) {
          actions.push({ type: "VETO", ref: f.ref, reason: f.reason ?? body });
        }
        break;
      case "REVENUE":
        if (f.source && f.amount) {
          actions.push({
            type: "REVENUE",
            source: f.source,
            amount: safeNumber(f.amount, 0)
          });
        }
        break;
      case "LESSON":
        actions.push({
          type: "LESSON",
          trigger: f.trigger ?? f.condition ?? body,
          body: f.body ?? f.lesson ?? body
        });
        break;
      case "APPROVE":
        if (f.ref) {
          actions.push({ type: "APPROVE", ref: f.ref });
        }
        break;
    }
  }
  return actions;
}

export function stripProtocol(text: string): string {
  return text.replace(TAG, "").replace(/\n{3,}/g, "\n\n").trim();
}
