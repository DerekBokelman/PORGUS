import type { LivingStore, TaskFilter } from "./store.js";
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

export class InMemoryLivingStore implements LivingStore {
  private readonly tasks = new Map<string, Task>();
  private readonly raw: RawLogEntry[] = [];
  private readonly curated = new Map<string, CuratedEntry>();
  private readonly costs: CostEntry[] = [];
  private readonly revenue: RevenueEntry[] = [];
  private readonly scores: ScoreEntry[] = [];
  private readonly archive = new Map<string, ArchivedAgent>();
  private headcountState: HeadcountState | undefined;
  private readonly proposals = new Map<string, HeadcountProposal>();
  private readonly dynamicAgents = new Map<string, DynamicAgentRecord>();

  insertTask(task: Task): Task {
    this.tasks.set(task.taskId, { ...task });
    return task;
  }

  getTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  listTasks(filter: TaskFilter = {}): Task[] {
    return Array.from(this.tasks.values())
      .filter((task) => (filter.status ? task.status === filter.status : true))
      .filter((task) => (filter.role ? task.roleRequired === filter.role : true))
      .filter((task) => (filter.shadow === undefined ? true : task.shadow === filter.shadow))
      .map((task) => ({ ...task }));
  }

  replaceTask(task: Task): void {
    this.tasks.set(task.taskId, { ...task });
  }

  countTasks(): number {
    return this.tasks.size;
  }

  appendRaw(entry: RawLogEntry): RawLogEntry {
    this.raw.push({ ...entry });
    return entry;
  }

  listRaw(limit?: number): RawLogEntry[] {
    const copy = this.raw.map((entry) => ({ ...entry }));
    return limit ? copy.slice(-limit) : copy;
  }

  countRaw(): number {
    return this.raw.length;
  }

  upsertCurated(entry: CuratedEntry): void {
    this.curated.set(entry.key, { ...entry });
  }

  getCurated(key: string): CuratedEntry | undefined {
    const entry = this.curated.get(key);
    return entry ? { ...entry } : undefined;
  }

  listCurated(): CuratedEntry[] {
    return Array.from(this.curated.values()).map((entry) => ({ ...entry }));
  }

  insertCost(entry: CostEntry): void {
    this.costs.push({ ...entry });
  }

  insertRevenue(entry: RevenueEntry): void {
    this.revenue.push({ ...entry });
  }

  listCostsSince(iso: string): CostEntry[] {
    return this.costs.filter((entry) => entry.createdAt >= iso).map((entry) => ({ ...entry }));
  }

  listRevenueSince(iso: string): RevenueEntry[] {
    return this.revenue.filter((entry) => entry.createdAt >= iso).map((entry) => ({ ...entry }));
  }

  totalSpend(): number {
    return this.costs.reduce((sum, entry) => sum + entry.amountUsd, 0);
  }

  insertScore(entry: ScoreEntry): void {
    this.scores.push({ ...entry });
  }

  listScores(): ScoreEntry[] {
    return this.scores.map((entry) => ({ ...entry }));
  }

  listScoresForAgent(agentId: string): ScoreEntry[] {
    return this.scores.filter((entry) => entry.agentId === agentId).map((entry) => ({ ...entry }));
  }

  archiveAgent(record: ArchivedAgent): void {
    this.archive.set(record.agentId, { ...record });
  }

  getArchived(agentId: string): ArchivedAgent | undefined {
    const record = this.archive.get(agentId);
    return record ? { ...record } : undefined;
  }

  listArchived(): ArchivedAgent[] {
    return Array.from(this.archive.values()).map((record) => ({ ...record }));
  }

  getHeadcountState(): HeadcountState | undefined {
    return this.headcountState ? { ...this.headcountState } : undefined;
  }

  setHeadcountState(state: HeadcountState): void {
    this.headcountState = { ...state };
  }

  insertProposal(proposal: HeadcountProposal): void {
    this.proposals.set(proposal.proposalId, { ...proposal });
  }

  getProposal(proposalId: string): HeadcountProposal | undefined {
    const proposal = this.proposals.get(proposalId);
    return proposal ? { ...proposal } : undefined;
  }

  listProposals(status?: HeadcountProposal["status"]): HeadcountProposal[] {
    return Array.from(this.proposals.values())
      .filter((p) => (status ? p.status === status : true))
      .map((p) => ({ ...p }));
  }

  replaceProposal(proposal: HeadcountProposal): void {
    this.proposals.set(proposal.proposalId, { ...proposal });
  }

  insertDynamicAgent(agent: DynamicAgentRecord): void {
    this.dynamicAgents.set(agent.id, { ...agent });
  }

  getDynamicAgent(id: string): DynamicAgentRecord | undefined {
    const agent = this.dynamicAgents.get(id);
    return agent ? { ...agent } : undefined;
  }

  listDynamicAgents(status?: DynamicAgentRecord["status"]): DynamicAgentRecord[] {
    return Array.from(this.dynamicAgents.values())
      .filter((a) => (status ? a.status === status : true))
      .map((a) => ({ ...a }));
  }

  replaceDynamicAgent(agent: DynamicAgentRecord): void {
    this.dynamicAgents.set(agent.id, { ...agent });
  }
}
