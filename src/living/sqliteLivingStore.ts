import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
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
  Role,
  ScoreEntry,
  Task,
  TaskStatus
} from "./types.js";

interface TaskRow {
  task_id: string;
  created_by: string;
  role_required: string;
  priority: number;
  title: string;
  spec: string;
  budget_cap_usd: number;
  status: string;
  claimed_by: string | null;
  result: string | null;
  cost_actual_usd: number | null;
  auditor_score: number | null;
  shadow: number;
  created_at: string;
  updated_at: string;
}

interface RawRow {
  id: string;
  type: string;
  actor: string;
  ref_id: string | null;
  payload: string;
  created_at: string;
}

interface CuratedRow {
  key: string;
  category: string;
  title: string;
  body: string;
  token_estimate: number;
  updated_at: string;
}

interface CostRow {
  id: string;
  task_id: string | null;
  agent_id: string;
  amount_usd: number;
  shadow: number;
  created_at: string;
}

interface RevenueRow {
  id: string;
  source: string;
  amount_usd: number;
  created_at: string;
}

interface ScoreRow {
  id: string;
  task_id: string;
  agent_id: string;
  success: number;
  score_overall: number;
  cost_efficiency: number;
  latency_ms: number;
  error_rate: number;
  score_per_dollar: number;
  rationale: string;
  shadow: number;
  realized_outcome: number | null;
  created_at: string;
}

interface ArchiveRow {
  agent_id: string;
  role: string;
  config: string;
  historical_avg_score_per_dollar: number;
  reason: string;
  archived_at: string;
  archived_at_cycle: number;
}

interface HeadcountStateRow {
  human_max_slots: number;
  active_slot_limit: number;
}

interface ProposalRow {
  proposal_id: string;
  kind: string;
  requested_slots: number;
  reason: string;
  payload: string;
  status: string;
  created_by: string;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

interface DynamicAgentRow {
  id: string;
  display_name: string;
  role_description: string;
  personality: string;
  provider: string;
  model: string;
  temperature: number;
  compression_style: string;
  responds_when: string;
  cooldown_ms: number;
  relevance_keywords: string;
  status: string;
  created_by: string;
  created_at: string;
}

export class SqliteLivingStore implements LivingStore {
  private readonly db: Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        role_required TEXT NOT NULL,
        priority INTEGER NOT NULL,
        title TEXT NOT NULL,
        spec TEXT NOT NULL,
        budget_cap_usd REAL NOT NULL,
        status TEXT NOT NULL,
        claimed_by TEXT,
        result TEXT,
        cost_actual_usd REAL,
        auditor_score REAL,
        shadow INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS raw_log (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        ref_id TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        seq INTEGER
      );

      CREATE TABLE IF NOT EXISTS curated (
        key TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ledger_cost (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        agent_id TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        shadow INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ledger_revenue (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scores (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        success INTEGER NOT NULL,
        score_overall REAL NOT NULL,
        cost_efficiency REAL NOT NULL,
        latency_ms INTEGER NOT NULL,
        error_rate REAL NOT NULL,
        score_per_dollar REAL NOT NULL,
        rationale TEXT NOT NULL,
        shadow INTEGER NOT NULL DEFAULT 0,
        realized_outcome REAL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS archive (
        agent_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        config TEXT NOT NULL,
        historical_avg_score_per_dollar REAL NOT NULL,
        reason TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        archived_at_cycle INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS headcount_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        human_max_slots INTEGER NOT NULL,
        active_slot_limit INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proposals (
        proposal_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        requested_slots INTEGER NOT NULL,
        reason TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_by TEXT,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS dynamic_agents (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role_description TEXT NOT NULL,
        personality TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        temperature REAL NOT NULL,
        compression_style TEXT NOT NULL,
        responds_when TEXT NOT NULL,
        cooldown_ms INTEGER NOT NULL,
        relevance_keywords TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  insertTask(task: Task): Task {
    this.db
      .query(
        `INSERT INTO tasks
          (task_id, created_by, role_required, priority, title, spec, budget_cap_usd,
           status, claimed_by, result, cost_actual_usd, auditor_score, shadow, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.taskId,
        task.createdBy,
        task.roleRequired,
        task.priority,
        task.title,
        task.spec,
        task.budgetCapUsd,
        task.status,
        task.claimedBy,
        task.result,
        task.costActualUsd,
        task.auditorScore,
        task.shadow ? 1 : 0,
        task.createdAt,
        task.updatedAt
      );
    return task;
  }

  getTask(taskId: string): Task | undefined {
    const row = this.db.query("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as TaskRow | null;
    return row ? toTask(row) : undefined;
  }

  listTasks(filter: TaskFilter = {}): Task[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.role) {
      clauses.push("role_required = ?");
      params.push(filter.role);
    }
    if (filter.shadow !== undefined) {
      clauses.push("shadow = ?");
      params.push(filter.shadow ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM tasks ${where} ORDER BY created_at ASC`)
      .all(...params) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  replaceTask(task: Task): void {
    this.db
      .query(
        `UPDATE tasks SET
          created_by = ?, role_required = ?, priority = ?, title = ?, spec = ?, budget_cap_usd = ?,
          status = ?, claimed_by = ?, result = ?, cost_actual_usd = ?, auditor_score = ?,
          shadow = ?, created_at = ?, updated_at = ?
         WHERE task_id = ?`
      )
      .run(
        task.createdBy,
        task.roleRequired,
        task.priority,
        task.title,
        task.spec,
        task.budgetCapUsd,
        task.status,
        task.claimedBy,
        task.result,
        task.costActualUsd,
        task.auditorScore,
        task.shadow ? 1 : 0,
        task.createdAt,
        task.updatedAt,
        task.taskId
      );
  }

  countTasks(): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
    return row.n;
  }

  appendRaw(entry: RawLogEntry): RawLogEntry {
    this.db
      .query(
        `INSERT INTO raw_log (id, type, actor, ref_id, payload, created_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM raw_log))`
      )
      .run(entry.id, entry.type, entry.actor, entry.refId, entry.payload, entry.createdAt);
    return entry;
  }

  listRaw(limit?: number): RawLogEntry[] {
    if (limit) {
      const rows = this.db
        .query("SELECT * FROM raw_log ORDER BY seq DESC LIMIT ?")
        .all(limit) as unknown as RawRow[];
      return rows.reverse().map(toRaw);
    }
    const rows = this.db.query("SELECT * FROM raw_log ORDER BY seq ASC").all() as unknown as RawRow[];
    return rows.map(toRaw);
  }

  countRaw(): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM raw_log").get() as { n: number };
    return row.n;
  }

  upsertCurated(entry: CuratedEntry): void {
    this.db
      .query(
        `INSERT INTO curated (key, category, title, body, token_estimate, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           category = excluded.category,
           title = excluded.title,
           body = excluded.body,
           token_estimate = excluded.token_estimate,
           updated_at = excluded.updated_at`
      )
      .run(entry.key, entry.category, entry.title, entry.body, entry.tokenEstimate, entry.updatedAt);
  }

  getCurated(key: string): CuratedEntry | undefined {
    const row = this.db.query("SELECT * FROM curated WHERE key = ?").get(key) as CuratedRow | null;
    return row ? toCurated(row) : undefined;
  }

  listCurated(): CuratedEntry[] {
    const rows = this.db.query("SELECT * FROM curated ORDER BY updated_at ASC").all() as unknown as CuratedRow[];
    return rows.map(toCurated);
  }

  insertCost(entry: CostEntry): void {
    this.db
      .query(
        `INSERT INTO ledger_cost (id, task_id, agent_id, amount_usd, shadow, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(entry.id, entry.taskId, entry.agentId, entry.amountUsd, entry.shadow ? 1 : 0, entry.createdAt);
  }

  insertRevenue(entry: RevenueEntry): void {
    this.db
      .query(
        `INSERT INTO ledger_revenue (id, source, amount_usd, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(entry.id, entry.source, entry.amountUsd, entry.createdAt);
  }

  listCostsSince(iso: string): CostEntry[] {
    const rows = this.db
      .query("SELECT * FROM ledger_cost WHERE created_at >= ? ORDER BY created_at ASC")
      .all(iso) as unknown as CostRow[];
    return rows.map(toCost);
  }

  listRevenueSince(iso: string): RevenueEntry[] {
    const rows = this.db
      .query("SELECT * FROM ledger_revenue WHERE created_at >= ? ORDER BY created_at ASC")
      .all(iso) as unknown as RevenueRow[];
    return rows.map(toRevenue);
  }

  totalSpend(): number {
    const row = this.db.query("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM ledger_cost").get() as {
      total: number;
    };
    return row.total;
  }

  insertScore(entry: ScoreEntry): void {
    this.db
      .query(
        `INSERT INTO scores
          (id, task_id, agent_id, success, score_overall, cost_efficiency, latency_ms,
           error_rate, score_per_dollar, rationale, shadow, realized_outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.id,
        entry.taskId,
        entry.agentId,
        entry.success ? 1 : 0,
        entry.scoreOverall,
        entry.costEfficiency,
        entry.latencyMs,
        entry.errorRate,
        entry.scorePerDollar,
        entry.rationale,
        entry.shadow ? 1 : 0,
        entry.realizedOutcome,
        entry.createdAt
      );
  }

  listScores(): ScoreEntry[] {
    const rows = this.db.query("SELECT * FROM scores ORDER BY created_at ASC").all() as unknown as ScoreRow[];
    return rows.map(toScore);
  }

  listScoresForAgent(agentId: string): ScoreEntry[] {
    const rows = this.db
      .query("SELECT * FROM scores WHERE agent_id = ? ORDER BY created_at ASC")
      .all(agentId) as unknown as ScoreRow[];
    return rows.map(toScore);
  }

  archiveAgent(record: ArchivedAgent): void {
    this.db
      .query(
        `INSERT INTO archive
          (agent_id, role, config, historical_avg_score_per_dollar, reason, archived_at, archived_at_cycle)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           role = excluded.role,
           config = excluded.config,
           historical_avg_score_per_dollar = excluded.historical_avg_score_per_dollar,
           reason = excluded.reason,
           archived_at = excluded.archived_at,
           archived_at_cycle = excluded.archived_at_cycle`
      )
      .run(
        record.agentId,
        record.role,
        record.config,
        record.historicalAvgScorePerDollar,
        record.reason,
        record.archivedAt,
        record.archivedAtCycle
      );
  }

  getArchived(agentId: string): ArchivedAgent | undefined {
    const row = this.db.query("SELECT * FROM archive WHERE agent_id = ?").get(agentId) as ArchiveRow | null;
    return row ? toArchive(row) : undefined;
  }

  listArchived(): ArchivedAgent[] {
    const rows = this.db.query("SELECT * FROM archive ORDER BY archived_at ASC").all() as unknown as ArchiveRow[];
    return rows.map(toArchive);
  }

  getHeadcountState(): HeadcountState | undefined {
    const row = this.db.query("SELECT * FROM headcount_state WHERE id = 1").get() as HeadcountStateRow | null;
    return row ? toHeadcountState(row) : undefined;
  }

  setHeadcountState(state: HeadcountState): void {
    this.db
      .query(
        `INSERT INTO headcount_state (id, human_max_slots, active_slot_limit)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           human_max_slots = excluded.human_max_slots,
           active_slot_limit = excluded.active_slot_limit`
      )
      .run(state.humanMaxSlots, state.activeSlotLimit);
  }

  insertProposal(proposal: HeadcountProposal): void {
    this.db
      .query(
        `INSERT INTO proposals
          (proposal_id, kind, requested_slots, reason, payload, status, created_by, created_at, resolved_by, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        proposal.proposalId,
        proposal.kind,
        proposal.requestedSlots,
        proposal.reason,
        proposal.payload,
        proposal.status,
        proposal.createdBy,
        proposal.createdAt,
        proposal.resolvedBy,
        proposal.resolvedAt
      );
  }

  getProposal(proposalId: string): HeadcountProposal | undefined {
    const row = this.db.query("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId) as ProposalRow | null;
    return row ? toProposal(row) : undefined;
  }

  listProposals(status?: HeadcountProposal["status"]): HeadcountProposal[] {
    if (status) {
      const rows = this.db
        .query("SELECT * FROM proposals WHERE status = ? ORDER BY created_at ASC")
        .all(status) as unknown as ProposalRow[];
      return rows.map(toProposal);
    }
    const rows = this.db.query("SELECT * FROM proposals ORDER BY created_at ASC").all() as unknown as ProposalRow[];
    return rows.map(toProposal);
  }

  replaceProposal(proposal: HeadcountProposal): void {
    this.db
      .query(
        `UPDATE proposals SET
          kind = ?, requested_slots = ?, reason = ?, payload = ?, status = ?,
          created_by = ?, created_at = ?, resolved_by = ?, resolved_at = ?
         WHERE proposal_id = ?`
      )
      .run(
        proposal.kind,
        proposal.requestedSlots,
        proposal.reason,
        proposal.payload,
        proposal.status,
        proposal.createdBy,
        proposal.createdAt,
        proposal.resolvedBy,
        proposal.resolvedAt,
        proposal.proposalId
      );
  }

  insertDynamicAgent(agent: DynamicAgentRecord): void {
    this.db
      .query(
        `INSERT INTO dynamic_agents
          (id, display_name, role_description, personality, provider, model, temperature,
           compression_style, responds_when, cooldown_ms, relevance_keywords, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        agent.id,
        agent.displayName,
        agent.roleDescription,
        agent.personality,
        agent.provider,
        agent.model,
        agent.temperature,
        agent.compressionStyle,
        agent.respondsWhen,
        agent.cooldownMs,
        JSON.stringify(agent.relevanceKeywords),
        agent.status,
        agent.createdBy,
        agent.createdAt
      );
  }

  getDynamicAgent(id: string): DynamicAgentRecord | undefined {
    const row = this.db.query("SELECT * FROM dynamic_agents WHERE id = ?").get(id) as DynamicAgentRow | null;
    return row ? toDynamicAgent(row) : undefined;
  }

  listDynamicAgents(status?: DynamicAgentRecord["status"]): DynamicAgentRecord[] {
    if (status) {
      const rows = this.db
        .query("SELECT * FROM dynamic_agents WHERE status = ? ORDER BY created_at ASC")
        .all(status) as unknown as DynamicAgentRow[];
      return rows.map(toDynamicAgent);
    }
    const rows = this.db.query("SELECT * FROM dynamic_agents ORDER BY created_at ASC").all() as unknown as DynamicAgentRow[];
    return rows.map(toDynamicAgent);
  }

  replaceDynamicAgent(agent: DynamicAgentRecord): void {
    this.db
      .query(
        `UPDATE dynamic_agents SET
          display_name = ?, role_description = ?, personality = ?, provider = ?, model = ?,
          temperature = ?, compression_style = ?, responds_when = ?, cooldown_ms = ?,
          relevance_keywords = ?, status = ?, created_by = ?, created_at = ?
         WHERE id = ?`
      )
      .run(
        agent.displayName,
        agent.roleDescription,
        agent.personality,
        agent.provider,
        agent.model,
        agent.temperature,
        agent.compressionStyle,
        agent.respondsWhen,
        agent.cooldownMs,
        JSON.stringify(agent.relevanceKeywords),
        agent.status,
        agent.createdBy,
        agent.createdAt,
        agent.id
      );
  }
}

function toTask(row: TaskRow): Task {
  return {
    taskId: row.task_id,
    createdBy: row.created_by,
    roleRequired: row.role_required as Role,
    priority: row.priority,
    title: row.title,
    spec: row.spec,
    budgetCapUsd: row.budget_cap_usd,
    status: row.status as TaskStatus,
    claimedBy: row.claimed_by,
    result: row.result,
    costActualUsd: row.cost_actual_usd,
    auditorScore: row.auditor_score,
    shadow: row.shadow === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toRaw(row: RawRow): RawLogEntry {
  return {
    id: row.id,
    type: row.type as RawLogEntry["type"],
    actor: row.actor,
    refId: row.ref_id,
    payload: row.payload,
    createdAt: row.created_at
  };
}

function toCurated(row: CuratedRow): CuratedEntry {
  return {
    key: row.key,
    category: row.category as CuratedEntry["category"],
    title: row.title,
    body: row.body,
    tokenEstimate: row.token_estimate,
    updatedAt: row.updated_at
  };
}

function toCost(row: CostRow): CostEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    amountUsd: row.amount_usd,
    shadow: row.shadow === 1,
    createdAt: row.created_at
  };
}

function toRevenue(row: RevenueRow): RevenueEntry {
  return {
    id: row.id,
    source: row.source,
    amountUsd: row.amount_usd,
    createdAt: row.created_at
  };
}

function toScore(row: ScoreRow): ScoreEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    success: row.success === 1,
    scoreOverall: row.score_overall,
    costEfficiency: row.cost_efficiency,
    latencyMs: row.latency_ms,
    errorRate: row.error_rate,
    scorePerDollar: row.score_per_dollar,
    rationale: row.rationale,
    shadow: row.shadow === 1,
    realizedOutcome: row.realized_outcome,
    createdAt: row.created_at
  };
}

function toArchive(row: ArchiveRow): ArchivedAgent {
  return {
    agentId: row.agent_id,
    role: row.role as Role,
    config: row.config,
    historicalAvgScorePerDollar: row.historical_avg_score_per_dollar,
    reason: row.reason,
    archivedAt: row.archived_at,
    archivedAtCycle: row.archived_at_cycle
  };
}

function toHeadcountState(row: HeadcountStateRow): HeadcountState {
  return {
    humanMaxSlots: row.human_max_slots,
    activeSlotLimit: row.active_slot_limit
  };
}

function toProposal(row: ProposalRow): HeadcountProposal {
  return {
    proposalId: row.proposal_id,
    kind: row.kind as HeadcountProposal["kind"],
    requestedSlots: row.requested_slots,
    reason: row.reason,
    payload: row.payload,
    status: row.status as HeadcountProposal["status"],
    createdBy: row.created_by,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at
  };
}

function toDynamicAgent(row: DynamicAgentRow): DynamicAgentRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    roleDescription: row.role_description,
    personality: row.personality,
    provider: row.provider,
    model: row.model,
    temperature: row.temperature,
    compressionStyle: row.compression_style,
    respondsWhen: row.responds_when,
    cooldownMs: row.cooldown_ms,
    relevanceKeywords: JSON.parse(row.relevance_keywords) as string[],
    status: row.status as DynamicAgentRecord["status"],
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}
