import type { AgentDefinition, ChannelMessage } from "../types.js";
import type { CompositeAgentRegistry } from "../agents/compositeRegistry.js";
import { estimateCallCostUsd } from "./costEstimate.js";
import type { HeadcountManager } from "./headcount.js";
import type { LivingCompany } from "./livingCompany.js";
import { parseProtocol, stripProtocol } from "./protocol.js";
import { ROLES, type Role } from "./types.js";

export interface AgentTurnResult {
  responseText: string;
  sideEffects: string[];
}

export interface LivingCompanyRuntimeOptions {
  company: LivingCompany;
  headcount: HeadcountManager;
  registry: CompositeAgentRegistry;
}

const HUMAN_APPROVE = /approve\s+headcount(?:\s+(P-[a-z0-9]+))?/i;

/**
 * Runs the Living Company on every Slack message: protocol actions, task flow,
 * ledger costs, knowledge updates, headcount growth, and agent context injection.
 */
export class LivingCompanyRuntime {
  private readonly claimedTaskByAgent = new Map<string, string>();

  constructor(private readonly options: LivingCompanyRuntimeOptions) {
    options.headcount.initialize();
  }

  assertRunnable(): void {
    this.options.company.hardRules.killSwitch.assertRunnable();
  }

  /** True when the task queue has any open work waiting to be claimed. */
  hasOpenWork(): boolean {
    return this.options.company.listOpenTasks().length > 0;
  }

  /**
   * Guarantee the company always has something concrete to work on. When the
   * queue is empty, open a low-priority self-improvement task for the Architect
   * so the heartbeat produces real claim/execute/score cycles instead of chatter.
   */
  ensureSeedWork(): string | undefined {
    if (this.hasOpenWork()) {
      return undefined;
    }
    const cap = Math.min(0.1, this.options.company.ledger.remainingCeilingUsd() || 0);
    if (cap <= 0) {
      return undefined;
    }
    const task = this.options.company.queue.create({
      createdBy: "heartbeat",
      roleRequired: "architect",
      title: "Advance the company: next highest-leverage improvement",
      spec:
        "No open work in the queue. Identify the single most valuable next step for the " +
        "company's mission and either do it or break it into a concrete task for the right role.",
      budgetCapUsd: cap,
      priority: 5
    });
    return task.taskId;
  }

  /**
   * Short brief for the autonomous heartbeat: current mode, open tasks, and a
   * plain-language instruction (no protocol tags, so it is never parsed as one).
   */
  heartbeatBrief(): string {
    const { company } = this.options;
    const mode = company.ledger.mode();
    const open = this.openTasksSummary();
    if (open) {
      return [
        "Autonomous work cycle.",
        `Company mode: ${mode}.`,
        "Open tasks in the queue:",
        open,
        "If one matches your role it is auto-claimed for you — do the work now and report the result.",
        "Otherwise advance the company: review recent work, score it, reconcile the budget, or record a lesson."
      ].join("\n");
    }
    return [
      "Autonomous work cycle.",
      `Company mode: ${mode}. The task queue is empty.`,
      "Architect: define the single highest-leverage next task for the company's current goal and open it.",
      "Everyone else: review recent work, score outstanding results, reconcile the budget, or propose an improvement."
    ].join("\n");
  }

  /** Claim the oldest open task matching this agent's role before it responds. */
  prepareAgentTurn(agent: AgentDefinition): string | undefined {
    const role = this.actorRole(agent.id);
    if (!role) {
      return undefined;
    }
    const open = this.options.company.listOpenTasks().find((t) => t.roleRequired === role);
    if (!open) {
      return undefined;
    }
    try {
      const task = this.options.company.queue.claim(open.taskId, agent.id, role);
      this.claimedTaskByAgent.set(agent.id, task.taskId);
      return task.taskId;
    } catch {
      return undefined;
    }
  }

  /** Process an incoming human or agent message for protocol tags and commands. */
  handleIncomingMessage(message: ChannelMessage): string[] {
    this.assertRunnable();
    const effects: string[] = [];

    if (message.authorType === "human") {
      effects.push(...this.handleHumanCommands(message.text));
      const task = this.autoRouteHumanGoal(message);
      if (task) {
        effects.push(`Auto-task ${task.taskId} → ${task.roleRequired}`);
      }
    }

    effects.push(...this.executeProtocol(message.text, message.authorAgentId ?? message.authorId));
    return effects;
  }

  /** Build Living Company context injected into each agent's system prompt. */
  buildAgentContext(agent: AgentDefinition): string {
    const { company, headcount } = this.options;
    const state = headcount.state();
    const mode = company.ledger.mode();
    const openTasks = this.options.company.listOpenTasks()
      .slice(0, 8)
      .map((t) => `${t.taskId} [${t.roleRequired}] ${t.title} cap=$${t.budgetCapUsd}`)
      .join("\n");
    const curated = company.knowledge.curatedContext({ tokenBudget: 400 });
    const scoreboard = company.auditor
      .scoreboard()
      .slice(0, 5)
      .map((row) => `${row.agentId}: score/$=${row.avgScorePerDollar.toFixed(2)} n=${row.samples}`)
      .join("\n");
    const pending = headcount
      .listPendingProposals()
      .map((p) => `${p.proposalId} ${p.kind} +${p.requestedSlots} ${p.reason}`)
      .join("\n");

    return [
      "--- Company status (for your awareness) ---",
      `Budget mode: ${mode} | Spend ceiling remaining: $${company.ledger.remainingCeilingUsd().toFixed(2)}`,
      `Team size: ${headcount.activeAgentCount()}/${state.activeSlotLimit} (human max ${state.humanMaxSlots})`,
      `Open tasks:\n${openTasks || "none"}`,
      curated ? `Team knowledge:\n${curated}` : "",
      scoreboard ? `Performance scoreboard:\n${scoreboard}` : "",
      pending ? `Pending proposals:\n${pending}` : "",
      "",
      "Optional structured actions: you may end your message with ONE of these tags only when you",
      "genuinely want that action taken. Otherwise omit them entirely — never invent IDs or copy examples.",
      "  [TASK] role=<role> cap=<usd> title=<short> spec=<details>   (propose new work for a role)",
      "  [PROPOSAL] kind=headcount slots=1 reason=<why>              (ask to grow the team)",
      "  [REVENUE] source=<name> amount=<usd>                        (log real income)",
      "Do NOT emit [CLAIM], [RESULT], [SCORE], or [VETO] — the system handles those automatically.",
      "Write your actual message in plain language first; a tag is optional and comes last."
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** After an LLM call: record cost, parse protocol, auto-complete claimed tasks. */
  afterAgentTurn(
    agent: AgentDefinition,
    message: ChannelMessage,
    response: string,
    latencyMs: number
  ): AgentTurnResult {
    this.assertRunnable();
    const effects: string[] = [];
    const cost = estimateCallCostUsd(agent);

    try {
      this.options.company.ledger.recordCost({
        agentId: agent.id,
        amountUsd: cost,
        shadow: false
      });
      effects.push(`Ledger +$${cost.toFixed(3)} (${agent.provider})`);
    } catch (error) {
      effects.push(`Ledger blocked: ${error instanceof Error ? error.message : "unknown"}`);
    }

    effects.push(...this.executeProtocol(response, agent.id));

    const claimedId = this.claimedTaskByAgent.get(agent.id);
    if (claimedId && !response.includes("[RESULT]")) {
      try {
        this.options.company.queue.complete(claimedId, {
          agentId: agent.id,
          result: stripProtocol(response),
          costActualUsd: cost
        });
        this.claimedTaskByAgent.delete(agent.id);
        effects.push(`Auto-completed ${claimedId}`);
        this.autoScoreIfAuditor(agent, claimedId);
      } catch {
        // Task may already be completed via explicit [RESULT] tag.
      }
    }

    if (agent.id === "chronicler") {
      effects.push(...this.chroniclerDistill(message, response));
    }

    if (agent.id === "operator") {
      effects.push(...this.operatorReconcile());
    }

    if (agent.id === "auditor") {
      effects.push(...this.auditorScorePending());
    }

    if (agent.id === "breeder") {
      effects.push(...this.breederAutoProposeHeadcount());
    }

    void latencyMs;
    const responseText =
      stripProtocol(response) ||
      (claimedId ? `Done. ${claimedId} complete.` : response.slice(0, 280).trim());
    return { responseText, sideEffects: effects };
  }

  private handleHumanCommands(text: string): string[] {
    const effects: string[] = [];
    const approveMatch = text.match(HUMAN_APPROVE);
    if (approveMatch) {
      const pending = this.options.headcount.listPendingProposals();
      const target =
        pending.find((p) => p.proposalId === approveMatch[1]) ??
        pending.find((p) => p.kind === "headcount");
      if (target) {
        try {
          this.options.headcount.approveProposal(target.proposalId, "human", {
            humanApproved: true
          });
          effects.push(`Human approved ${target.proposalId}: +${target.requestedSlots} slot(s)`);
        } catch (error) {
          effects.push(`Approve failed: ${error instanceof Error ? error.message : "unknown"}`);
        }
      }
    }
    if (/approve\s+agent\s+(P-[a-z0-9]+)/i.test(text)) {
      const id = text.match(/approve\s+agent\s+(P-[a-z0-9]+)/i)?.[1];
      if (id) {
        try {
          const proposal = this.options.headcount.approveProposal(id, "human", {
            humanApproved: true
          });
          effects.push(`Human approved agent proposal ${proposal.proposalId}`);
        } catch (error) {
          effects.push(`Agent approve failed: ${error instanceof Error ? error.message : "unknown"}`);
        }
      }
    }
    return effects;
  }

  private executeProtocol(text: string, actor: string): string[] {
    const effects: string[] = [];
    const actions = parseProtocol(text);

    for (const action of actions) {
      try {
        switch (action.type) {
          case "TASK": {
            const task = this.options.company.queue.create({
              createdBy: actor,
              roleRequired: action.role,
              title: action.title,
              spec: action.spec,
              budgetCapUsd: action.cap,
              priority: action.priority
            });
            effects.push(`Created ${task.taskId}`);
            break;
          }
          case "CLAIM": {
            if (action.taskId === "T-EXAMPLE") {
              break;
            }
            const role = this.actorRole(actor);
            if (!role) {
              break;
            }
            const task = this.options.company.queue.claim(action.taskId, actor, role);
            this.claimedTaskByAgent.set(actor, task.taskId);
            effects.push(`Claimed ${task.taskId}`);
            break;
          }
          case "RESULT": {
            this.options.company.queue.complete(action.taskId, {
              agentId: actor,
              result: action.body,
              costActualUsd: action.cost
            });
            this.claimedTaskByAgent.delete(actor);
            effects.push(`Completed ${action.taskId}`);
            break;
          }
          case "SCORE": {
            const task = this.options.company.getTask(action.taskId);
            if (task) {
              this.options.company.auditor.score(task, {
                agentId: task.claimedBy ?? actor,
                success: action.overall >= 5,
                scoreOverall: action.overall,
                costEfficiency: action.costEff,
                latencyMs: 100,
                errorRate: action.overall >= 5 ? 0 : 0.5,
                rationale: action.rationale
              });
              effects.push(`Scored ${action.taskId}`);
            }
            break;
          }
          case "PROPOSAL": {
            if (action.kind === "headcount") {
              const proposal = this.options.headcount.proposeHeadcount({
                requestedSlots: action.slots ?? 1,
                reason: action.reason,
                createdBy: actor
              });
              effects.push(`Proposed headcount ${proposal.proposalId}`);
              if (this.options.company.ledger.mode() === "surplus") {
                try {
                  this.options.headcount.approveProposal(proposal.proposalId, "operator");
                  effects.push(`Auto-approved ${proposal.proposalId} (surplus mode)`);
                } catch {
                  effects.push(`Awaiting approval for ${proposal.proposalId}`);
                }
              }
            } else if (action.agentId && action.displayName && action.roleDescription) {
              const proposal = this.options.headcount.proposeAgent({
                id: action.agentId,
                displayName: action.displayName,
                roleDescription: action.roleDescription,
                personality: action.personality ?? "Helpful specialist",
                createdBy: actor
              });
              effects.push(`Proposed agent ${proposal.proposalId}`);
            }
            break;
          }
          case "VETO": {
            if (action.ref.startsWith("P-")) {
              this.options.headcount.vetoProposal(action.ref, actor, action.reason);
              effects.push(`Vetoed proposal ${action.ref}`);
            } else {
              this.options.company.queue.veto(action.ref, actor, action.reason);
              effects.push(`Vetoed task ${action.ref}`);
            }
            break;
          }
          case "REVENUE": {
            this.options.company.ledger.recordRevenue(action.source, action.amount);
            effects.push(`Revenue +$${action.amount} from ${action.source}`);
            break;
          }
        }
      } catch (error) {
        effects.push(
          `${action.type} failed: ${error instanceof Error ? error.message : "unknown"}`
        );
      }
    }
    return effects;
  }

  private autoRouteHumanGoal(message: ChannelMessage) {
    const text = message.text.toLowerCase();
    const role = inferRoleFromText(text);
    const cap = Math.min(0.5, this.options.company.ledger.remainingCeilingUsd() || 0.25);
    if (cap <= 0) {
      return undefined;
    }
    return this.options.company.queue.create({
      createdBy: message.authorId,
      roleRequired: role,
      title: message.text.slice(0, 80),
      spec: message.text,
      budgetCapUsd: cap,
      priority: 2
    });
  }

  private autoScoreIfAuditor(agent: AgentDefinition, taskId: string): void {
    if (agent.id !== "auditor") {
      return;
    }
    const task = this.options.company.getTask(taskId);
    if (!task) {
      return;
    }
    this.options.company.auditor.score(task, {
      agentId: task.claimedBy ?? agent.id,
      success: true,
      scoreOverall: 6,
      costEfficiency: 5,
      latencyMs: 100,
      errorRate: 0,
      rationale: "auto-score on complete"
    });
  }

  private chroniclerDistill(message: ChannelMessage, response: string): string[] {
    if (message.authorType === "human") {
      this.options.company.knowledge.upsertCurated({
        key: "strategy:current",
        category: "strategy",
        title: "Current human goal",
        body: message.text.slice(0, 500)
      });
    }
    if (/fail|mistake|don't repeat|do not repeat/i.test(response)) {
      this.options.company.knowledge.addDoNotRepeat(
        message.text.slice(0, 200),
        response.slice(0, 300)
      );
      return ["Added do-not-repeat entry"];
    }
    return [];
  }

  private operatorReconcile(): string[] {
    const mode = this.options.company.ledger.mode();
    this.options.company.knowledge.upsertCurated({
      key: "protocol:mode",
      category: "protocol",
      title: "Operator mode",
      body: `Current mode: ${mode}. Coverage: ${(this.options.company.ledger.coverageRatio() * 100).toFixed(0)}%`
    });
    return [`Mode: ${mode}`];
  }

  private auditorScorePending(): string[] {
    const effects: string[] = [];
    const done = this.options.company.queue.listDoneUnscored();
    for (const task of done) {
      this.options.company.auditor.score(task, {
        agentId: task.claimedBy ?? "unknown",
        success: true,
        scoreOverall: 6,
        costEfficiency: Math.min(10, 10 / Math.max(task.costActualUsd ?? 0.01, 0.01)),
        latencyMs: 100,
        errorRate: 0,
        rationale: "pending batch score"
      });
      effects.push(`Scored ${task.taskId}`);
    }
    return effects;
  }

  private breederAutoProposeHeadcount(): string[] {
    const state = this.options.headcount.state();
    if (this.options.headcount.availableSlots() > 0) {
      return [];
    }
    if (this.options.headcount.listPendingProposals().some((p) => p.kind === "headcount")) {
      return [];
    }
    const weakest = this.options.company.auditor.weakestAgent();
    const reason = weakest
      ? `Capability gap: ${weakest.agentId} score/$=${weakest.avgScorePerDollar.toFixed(2)}`
      : "Workload exceeds current headcount";
    if (state.activeSlotLimit >= state.humanMaxSlots) {
      return ["At human max headcount — human must raise LIVING_MAX_HEADCOUNT"];
    }
    const proposal = this.options.headcount.proposeHeadcount({
      requestedSlots: 1,
      reason,
      createdBy: "breeder"
    });
    return [`Breeder proposed headcount ${proposal.proposalId}`];
  }

  private openTasksSummary(): string {
    return this.options.company
      .listOpenTasks()
      .slice(0, 8)
      .map((t) => `${t.taskId} [${t.roleRequired}] ${t.title} cap=$${t.budgetCapUsd}`)
      .join("\n");
  }

  private actorRole(actor: string): Role | null {
    if ((ROLES as string[]).includes(actor)) {
      return actor as Role;
    }
    const agent = this.options.registry.list().find((a) => a.id === actor);
    if (agent && (ROLES as string[]).includes(agent.id)) {
      return agent.id as Role;
    }
    return null;
  }
}

export function inferRoleFromText(text: string): Role {
  for (const role of ROLES) {
    if (new RegExp(`\\b${role}\\s*:`, "i").test(text)) {
      return role;
    }
  }
  if (/audit|benchmark/.test(text) || /\bscore metrics\b/.test(text)) {
    return "auditor";
  }
  if (/revenue|budget mode|burn|roi|monetize/.test(text)) {
    return "operator";
  }
  if (/mutate|variant idea|breed|experiment/.test(text)) {
    return "breeder";
  }
  if (/log lesson|chronicler|institutional memory|summarize/.test(text)) {
    return "chronicler";
  }
  if (/build|architecture|infrastructure|framework|simplest next/.test(text)) {
    return "architect";
  }
  return "architect";
}
