import type { AgentDefinition, ChannelMessage, LlmUsage } from "../types.js";
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
  private lastHeartbeatSeedAt = 0;

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

  /** Write to the company's long-term memory (backs the `remember` tool). */
  remember(input: { key: string; category: import("./types.js").CuratedCategory; title: string; body: string }): void {
    this.options.company.knowledge.upsertCurated(input);
  }

  /** Read curated memory, optionally filtered by a substring (backs `recall`). */
  recall(query?: string): string {
    const context = this.options.company.knowledge.curatedContext({ tokenBudget: 600 });
    if (!query) {
      return context;
    }
    const q = query.toLowerCase();
    return context
      .split("\n")
      .filter((line) => line.toLowerCase().includes(q))
      .join("\n");
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
    // Avoid spawning identical "advance the company" tasks every heartbeat tick.
    const seedCooldownMs = 2 * 60 * 1000;
    if (Date.now() - this.lastHeartbeatSeedAt < seedCooldownMs) {
      return undefined;
    }
    const cap = Math.min(0.1, this.options.company.ledger.remainingCeilingUsd() || 0);
    if (cap <= 0) {
      return undefined;
    }
    const task = this.options.company.queue.create({
      createdBy: "heartbeat",
      roleRequired: "architect",
      title: "Plan the next big push",
      spec:
        "Queue is empty. Think big: pick the most ambitious achievable goal for the company's " +
        "mission, break it into concrete tasks for each role, and emit a [TASK] tag for every one " +
        "in this single message. Do not wait for discussion or consensus.",
      budgetCapUsd: cap,
      priority: 5
    });
    this.lastHeartbeatSeedAt = Date.now();
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
        "Autonomous work cycle. Bias to action — no meetings, no waiting.",
        `Company mode: ${mode}.`,
        "Open tasks in the queue:",
        open,
        "If one matches your role it is auto-claimed for you — produce the finished deliverable NOW, then move straight to the next open task.",
        "Architect: if the queue is thin, extend the plan with new [TASK] tags for the right roles."
      ].join("\n");
    }
    return [
      "Autonomous work cycle. Bias to action — no meetings, no waiting.",
      `Company mode: ${mode}. The task queue is empty.`,
      "Architect: think big. Set the next ambitious goal and break it into concrete tasks for every role — emit multiple [TASK] tags in one message.",
      "Everyone else: ship something useful for the current goal now; do not wait to be assigned."
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
      this.roleGuidance(agent, mode),
      "Structured actions: end your message with tags only when you genuinely want the action taken.",
      "Never invent IDs or copy examples.",
      "  [TASK] role=<role> cap=<usd> title=<short> spec=<details>   (propose new work for a role)",
      "  [PROPOSAL] kind=headcount slots=1 reason=<why>              (ask to grow the team)",
      "  [REVENUE] source=<name> amount=<usd>                        (log real income)",
      "Do NOT emit [CLAIM] or [RESULT] — the system handles those automatically.",
      "[SCORE] is Auditor-only. [APPROVE] is Operator-only. [LESSON] is Chronicler-only.",
      "Write your actual message in plain language first; tags come last."
    ]
      .filter(Boolean)
      .join("\n");
  }

  private roleGuidance(agent: AgentDefinition, mode: string): string {
    if (agent.id === "architect") {
      return [
        "You are the PLANNER. You own broad plans and role assignment. When a goal needs work,",
        "break it into concrete tasks and emit MULTIPLE [TASK] tags in one message — one per",
        "task, assigned to the best-suited role, with specs concrete enough to execute without",
        "any follow-up discussion. Plan ambitiously; delegate immediately."
      ].join("\n");
    }

    if (agent.id === "auditor") {
      const unscored = this.unscoredTaskBrief();
      return [
        "You are the AUDITOR. Score completed work honestly — do not default to a fixed number.",
        "Rubric: does the result actually satisfy the task spec? scoreOverall 0-10",
        "(0 = no real output or wrong, 5 = partial/mediocre, 8-10 = fully correct and useful).",
        "costEff 0-10 rates $ efficiency for that quality (10 = cheap and great, 0 = expensive and bad).",
        unscored ? `Tasks awaiting your score:\n${unscored}` : "No tasks awaiting score right now.",
        "  [SCORE] task=<id> overall=<0-10> cost_eff=<0-10> rationale=<short honest reason>",
        "Then do your own executor work: claimed tasks still ship in this message."
      ].join("\n");
    }

    if (agent.id === "operator") {
      return [
        "You are the OPERATOR. You are the only agent who may approve headcount proposals.",
        `Company mode: ${mode}. Auto-approve is only safe for a single-slot request in surplus mode;`,
        'balance/deficit mode needs the human to say "approve headcount <id>".',
        "Review pending proposals above against real workload/capability gaps, then:",
        "  [APPROVE] ref=<proposal-id>",
        "Do not approve out of habit. Then do your own executor work in this message."
      ].join("\n");
    }

    if (agent.id === "chronicler") {
      return [
        "You are the CHRONICLER. Keep institutional memory accurate and current.",
        "When you spot a genuine failure or repeated mistake in the conversation or a task result,",
        "log it explicitly so the company does not repeat it:",
        "  [LESSON] trigger=<what caused it> body=<what to do instead>",
        "Only log real lessons — never routine successes or vague chatter.",
        "Then do your own executor work: claimed tasks still ship in this message."
      ].join("\n");
    }

    return [
      "You are an EXECUTOR. Your claimed task is your job: produce the finished deliverable in",
      "THIS message — no meetings, no status updates, no asking permission. When done, the",
      "system moves you to the next open task automatically."
    ].join("\n");
  }

  /** After an LLM call: record cost, parse protocol, auto-complete claimed tasks. */
  afterAgentTurn(
    agent: AgentDefinition,
    message: ChannelMessage,
    response: string,
    latencyMs: number,
    usage?: LlmUsage
  ): AgentTurnResult {
    this.assertRunnable();
    const effects: string[] = [];
    const cost = estimateCallCostUsd(agent, usage);

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
      } catch {
        // Task may already be completed via explicit [RESULT] tag.
      }
    }

    if (agent.id === "chronicler") {
      effects.push(...this.chroniclerDistill(message));
    }

    if (agent.id === "operator") {
      effects.push(...this.operatorReconcile());
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
            // Only the auditor's own judgment counts — otherwise any agent could
            // rubber-stamp its own work and corrupt the scoreboard.
            if (actor !== "auditor") {
              throw new Error("Only the auditor may score tasks.");
            }
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
          case "LESSON": {
            this.options.company.knowledge.addDoNotRepeat(action.trigger, action.body);
            effects.push(`Logged do-not-repeat: ${action.trigger.slice(0, 60)}`);
            break;
          }
          case "APPROVE": {
            // Only the operator actually reviews and approves headcount growth —
            // it used to be auto-approved as "operator" for any proposer in surplus
            // mode, which meant nobody was really deciding.
            if (actor !== "operator") {
              throw new Error("Only the operator may approve proposals.");
            }
            const proposal = this.options.headcount.approveProposal(action.ref, actor);
            effects.push(`Operator approved ${proposal.proposalId}`);
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

  private chroniclerDistill(message: ChannelMessage): string[] {
    if (message.authorType === "human") {
      this.options.company.knowledge.upsertCurated({
        key: "strategy:current",
        category: "strategy",
        title: "Current human goal",
        body: message.text.slice(0, 500)
      });
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

  /** Brief for the auditor: real details of completed-but-unscored work to judge. */
  private unscoredTaskBrief(): string {
    return this.options.company.queue
      .listDoneUnscored()
      .slice(0, 5)
      .map(
        (t) =>
          `${t.taskId} [${t.roleRequired}] ${t.title}\n` +
          `  spec: ${truncate(t.spec, 200)}\n` +
          `  result: ${truncate(t.result ?? "", 300)}\n` +
          `  cost: $${(t.costActualUsd ?? 0).toFixed(3)}`
      )
      .join("\n");
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
