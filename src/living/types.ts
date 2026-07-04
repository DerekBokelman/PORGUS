export type Role = "architect" | "auditor" | "operator" | "breeder" | "chronicler";

export const ROLES: Role[] = ["architect", "auditor", "operator", "breeder", "chronicler"];

export type TaskStatus = "open" | "claimed" | "done" | "failed" | "vetoed";

export type MessageType = "TASK" | "RESULT" | "SCORE" | "PROPOSAL" | "VETO";

export type OperatorMode = "deficit" | "balance" | "surplus";

export type CuratedCategory = "lesson" | "strategy" | "protocol" | "do-not-repeat";

export interface Task {
  taskId: string;
  createdBy: string;
  roleRequired: Role;
  priority: number;
  title: string;
  spec: string;
  budgetCapUsd: number;
  status: TaskStatus;
  claimedBy: string | null;
  result: string | null;
  costActualUsd: number | null;
  auditorScore: number | null;
  shadow: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  createdBy: string;
  roleRequired: Role;
  title: string;
  spec: string;
  budgetCapUsd: number;
  priority?: number;
  shadow?: boolean;
}

export interface RawLogEntry {
  id: string;
  type: MessageType | "SYSTEM";
  actor: string;
  refId: string | null;
  payload: string;
  createdAt: string;
}

export interface CuratedEntry {
  key: string;
  category: CuratedCategory;
  title: string;
  body: string;
  tokenEstimate: number;
  updatedAt: string;
}

export interface CostEntry {
  id: string;
  taskId: string | null;
  agentId: string;
  amountUsd: number;
  shadow: boolean;
  createdAt: string;
}

export interface RevenueEntry {
  id: string;
  source: string;
  amountUsd: number;
  createdAt: string;
}

export interface ScoreEntry {
  id: string;
  taskId: string;
  agentId: string;
  success: boolean;
  scoreOverall: number;
  costEfficiency: number;
  latencyMs: number;
  errorRate: number;
  scorePerDollar: number;
  rationale: string;
  shadow: boolean;
  realizedOutcome: number | null;
  createdAt: string;
}

export interface ArchivedAgent {
  agentId: string;
  role: Role;
  config: string;
  historicalAvgScorePerDollar: number;
  reason: string;
  archivedAt: string;
  archivedAtCycle: number;
}

export interface Candidate {
  candidateId: string;
  role: Role;
  basePrompt: string;
  model: string;
  toolset: string[];
  hypothesis: string;
  createdBy: string;
  createdAt: string;
}

export interface AgentScoreSummary {
  agentId: string;
  samples: number;
  successRate: number;
  avgCostPerTask: number;
  avgScore: number;
  avgScorePerDollar: number;
}

export type ProposalKind = "headcount" | "agent";
export type ProposalStatus = "pending" | "approved" | "vetoed";

export interface HeadcountState {
  humanMaxSlots: number;
  activeSlotLimit: number;
}

export interface HeadcountProposal {
  proposalId: string;
  kind: ProposalKind;
  requestedSlots: number;
  reason: string;
  payload: string;
  status: ProposalStatus;
  createdBy: string;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

export interface DynamicAgentRecord {
  id: string;
  displayName: string;
  roleDescription: string;
  personality: string;
  provider: string;
  model: string;
  temperature: number;
  compressionStyle: string;
  respondsWhen: string;
  cooldownMs: number;
  relevanceKeywords: string[];
  status: "active" | "pending" | "archived";
  createdBy: string;
  createdAt: string;
}
