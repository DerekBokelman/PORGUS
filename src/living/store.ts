import type {
  ArchivedAgent,
  CostEntry,
  CuratedEntry,
  DynamicAgentRecord,
  HeadcountProposal,
  HeadcountState,
  RawLogEntry,
  RevenueEntry,
  ScoreEntry,
  Task
} from "./types.js";

export interface TaskFilter {
  status?: Task["status"];
  role?: Task["roleRequired"];
  shadow?: boolean;
}

/**
 * LivingStore is the single persistence surface for the three shared structures:
 * task queue, knowledge base (raw log + curated layer), and budget ledger,
 * plus scores and the fired-agent archive.
 *
 * The raw log is append-only: implementations MUST NOT expose edit or delete.
 */
export interface LivingStore {
  // Task queue
  insertTask(task: Task): Task;
  getTask(taskId: string): Task | undefined;
  listTasks(filter?: TaskFilter): Task[];
  replaceTask(task: Task): void;
  countTasks(): number;

  // Knowledge base: raw log (append-only)
  appendRaw(entry: RawLogEntry): RawLogEntry;
  listRaw(limit?: number): RawLogEntry[];
  countRaw(): number;

  // Knowledge base: curated layer
  upsertCurated(entry: CuratedEntry): void;
  getCurated(key: string): CuratedEntry | undefined;
  listCurated(): CuratedEntry[];

  // Budget ledger
  insertCost(entry: CostEntry): void;
  insertRevenue(entry: RevenueEntry): void;
  listCostsSince(iso: string): CostEntry[];
  listRevenueSince(iso: string): RevenueEntry[];
  totalSpend(): number;

  // Scores
  insertScore(entry: ScoreEntry): void;
  listScores(): ScoreEntry[];
  listScoresForAgent(agentId: string): ScoreEntry[];

  // Archive
  archiveAgent(record: ArchivedAgent): void;
  getArchived(agentId: string): ArchivedAgent | undefined;
  listArchived(): ArchivedAgent[];

  // Headcount + dynamic agents
  getHeadcountState(): HeadcountState | undefined;
  setHeadcountState(state: HeadcountState): void;
  insertProposal(proposal: HeadcountProposal): void;
  getProposal(proposalId: string): HeadcountProposal | undefined;
  listProposals(status?: HeadcountProposal["status"]): HeadcountProposal[];
  replaceProposal(proposal: HeadcountProposal): void;
  insertDynamicAgent(agent: DynamicAgentRecord): void;
  getDynamicAgent(id: string): DynamicAgentRecord | undefined;
  listDynamicAgents(status?: DynamicAgentRecord["status"]): DynamicAgentRecord[];
  replaceDynamicAgent(agent: DynamicAgentRecord): void;
}
