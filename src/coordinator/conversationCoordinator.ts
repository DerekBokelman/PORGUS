import type { AgentRegistry } from "../agents/agentRegistry.js";
import type { CompositeAgentRegistry } from "../agents/compositeRegistry.js";
import type { BudgetGuard } from "../memory/budgetGuard.js";
import type { MemoryStore } from "../memory/memoryStore.js";
import type { LivingCompanyRuntime } from "../living/runtime.js";
import type { AgentDefinition, ChannelMessage, ChatMessage, LlmProvider } from "../types.js";

export interface ProviderResolver {
  createForAgent(agent: AgentDefinition): LlmProvider;
}

export interface AgentPostResult {
  ts: string;
}

export interface AgentResponder {
  postAgentMessage(
    agent: AgentDefinition,
    text: string,
    sourceMessage: ChannelMessage
  ): Promise<AgentPostResult>;
  resolvePoster?(agent: AgentDefinition): { agentId: string; proxy: boolean };
  /**
   * Execute any Slack workspace tool calls the agent embedded in its raw reply.
   * Returns human-readable status lines (empty if the agent used no tools).
   */
  runAgentTools?(
    agent: AgentDefinition,
    rawText: string,
    sourceMessage: ChannelMessage
  ): Promise<string[]>;
}

export interface AgentToolRunnerLike {
  run(agent: AgentDefinition, rawText: string): Promise<string[]>;
}

export interface ConversationCoordinatorOptions {
  registry: AgentRegistry | CompositeAgentRegistry;
  memory: MemoryStore;
  budgetGuard: BudgetGuard;
  providerResolver: ProviderResolver;
  livingRuntime?: LivingCompanyRuntime;
  toolRunner?: AgentToolRunnerLike;
}

export class ConversationCoordinator {
  private readonly lastResponseAtByAgent = new Map<string, number>();
  private queue = Promise.resolve();
  private consecutiveAgentTurns = 0;

  constructor(private readonly options: ConversationCoordinatorOptions) {}

  async handleMessage(message: ChannelMessage, responder: AgentResponder): Promise<void> {
    const run = this.queue.then(() => this.processMessage(message, responder));

    this.queue = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  /**
   * Autonomous heartbeat: without any human input, inject a synthetic company
   * "work cycle" message so agents advance the task queue on their own. Runs on
   * the same serialized queue as inbound Slack messages so the two never race.
   * Resolves with the number of agent turns produced this cycle (0 means the
   * agents were idle — e.g. budget/rate-limited — so callers can back off).
   */
  async runHeartbeat(channelId: string, responder: AgentResponder): Promise<number> {
    const run = this.queue.then(() => this.processHeartbeat(channelId, responder));

    this.queue = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  private async processHeartbeat(channelId: string, responder: AgentResponder): Promise<number> {
    if (!this.options.livingRuntime) {
      return 0;
    }
    this.options.livingRuntime.assertRunnable();

    const seeded = this.options.livingRuntime.ensureSeedWork();
    if (seeded) {
      console.log(`[living] Heartbeat seeded ${seeded}`);
    }

    const synthetic: ChannelMessage = {
      id: `heartbeat-${Date.now()}`,
      channelId,
      ts: "",
      threadTs: undefined,
      authorType: "agent",
      authorId: "heartbeat",
      authorName: "Heartbeat",
      authorAgentId: "heartbeat",
      text: this.options.livingRuntime.heartbeatBrief(),
      createdAt: new Date().toISOString()
    };

    // Each heartbeat is a fresh cycle; let the chain run up to the configured cap.
    this.consecutiveAgentTurns = 0;
    await this.processMessage(synthetic, responder);
    return this.consecutiveAgentTurns;
  }

  private async processMessage(message: ChannelMessage, responder: AgentResponder): Promise<void> {
    this.options.livingRuntime?.assertRunnable();

    if (this.options.livingRuntime) {
      const effects = this.options.livingRuntime.handleIncomingMessage(message);
      for (const effect of effects) {
        console.log(`[living] ${effect}`);
      }
    }

    if (message.authorType === "human") {
      this.consecutiveAgentTurns = 0;
    } else if (this.consecutiveAgentTurns >= this.options.registry.getCoordination().maxConsecutiveAgentTurns) {
      return;
    }

    // Full ordered list — a failing/skipped agent does not consume a response
    // slot, so one down provider can't stall the whole cycle on the first agent.
    const candidates = this.selectCandidateAgents(message);
    const maxResponses = this.options.registry.getCoordination().maxResponsesPerMessage;
    let responses = 0;

    for (const agent of candidates) {
      if (responses >= maxResponses) {
        break;
      }
      if (!this.cooldownAllows(agent)) {
        continue;
      }

      if (!(await this.options.budgetGuard.canUseRealCall(agent))) {
        continue;
      }

      await delay(this.options.registry.getCoordination().responseDelayMs);

      const claimedTask = this.options.livingRuntime?.prepareAgentTurn(agent);
      if (claimedTask) {
        console.log(`[living] Auto-claimed ${claimedTask} for ${agent.id}`);
      }

      let text: string;
      let post: AgentPostResult;
      try {
        const startedAt = Date.now();
        const provider = this.options.providerResolver.createForAgent(agent);
        const rawText = await provider.complete({
          agent,
          messages: await this.buildPrompt(agent, message),
          temperature: agent.temperature
        });

        await this.options.budgetGuard.recordRealCall(agent);

        text = rawText.trim();
        if (this.options.livingRuntime) {
          const turn = this.options.livingRuntime.afterAgentTurn(
            agent,
            message,
            rawText,
            Date.now() - startedAt
          );
          for (const effect of turn.sideEffects) {
            console.log(`[living] ${effect}`);
          }
          text = turn.responseText.trim();
        }

        const toolNotes: string[] = [];
        if (responder.runAgentTools) {
          toolNotes.push(...(await responder.runAgentTools(agent, rawText, message)));
        }
        if (this.options.toolRunner) {
          toolNotes.push(...(await this.options.toolRunner.run(agent, rawText)));
        }
        for (const note of toolNotes) {
          console.log(`[tools] ${agent.id}: ${note}`);
        }

        if (toolNotes.length > 0) {
          const actions = toolNotes.map((note) => `\u2022 ${note}`).join("\n");
          text = text ? `${text}\n\n_Actions:_\n${actions}` : `_Actions:_\n${actions}`;
        }

        if (!text) {
          continue;
        }

        post = await responder.postAgentMessage(agent, text, message);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown";
        console.warn(`[coordinator] ${agent.displayName} turn skipped: ${reason}`);
        continue;
      }

      this.lastResponseAtByAgent.set(agent.id, Date.now());
      this.consecutiveAgentTurns += 1;
      responses += 1;

      const recorded = await this.options.memory.recordChannelMessage({
        channelId: message.channelId,
        ts: post.ts,
        threadTs: message.threadTs ?? message.ts,
        authorType: "agent",
        authorId: agent.id,
        authorName: agent.displayName,
        authorAgentId: agent.id,
        text
      });

      if (recorded) {
        await this.processMessage(recorded, responder);
      }
    }
  }

  private selectCandidateAgents(message: ChannelMessage): AgentDefinition[] {
    const agents = this.orderedAgentsAfter(message.authorAgentId);

    return agents.filter((agent) => this.shouldAgentRespond(agent, message));
  }

  private orderedAgentsAfter(authorAgentId?: string): AgentDefinition[] {
    const agents = this.options.registry.list();
    if (!authorAgentId) {
      return agents;
    }

    const authorIndex = agents.findIndex((agent) => agent.id === authorAgentId);
    if (authorIndex < 0) {
      return agents;
    }

    return [...agents.slice(authorIndex + 1), ...agents.slice(0, authorIndex)];
  }

  private shouldAgentRespond(agent: AgentDefinition, message: ChannelMessage): boolean {
    if (message.authorAgentId === agent.id) {
      return false;
    }

    if (message.authorType === "agent" && agent.respondsWhen !== "mentioned") {
      return true;
    }

    if (agent.respondsWhen === "always") {
      return true;
    }

    const text = message.text.toLowerCase();
    const aliases = AGENT_ALIASES[agent.id] ?? [];
    const mentioned =
      text.includes(`@${agent.id.toLowerCase()}`) ||
      text.includes(`@${agent.displayName.toLowerCase()}`) ||
      text.includes(agent.displayName.toLowerCase()) ||
      aliases.some((alias) => text.includes(alias));

    if (agent.respondsWhen === "mentioned") {
      return mentioned;
    }

    return mentioned || agent.relevanceKeywords.some((keyword) => text.includes(keyword.toLowerCase()));
  }

  private cooldownAllows(agent: AgentDefinition): boolean {
    const lastResponseAt = this.lastResponseAtByAgent.get(agent.id);
    if (!lastResponseAt) {
      return true;
    }

    return Date.now() - lastResponseAt >= agent.cooldownMs;
  }

  private async buildPrompt(agent: AgentDefinition, message: ChannelMessage): Promise<ChatMessage[]> {
    const recent = await this.options.memory.listRecentChannelMessages(
      message.channelId,
      this.options.registry.getCoordination().recentMessageLimit
    );
    const transcript = recent
      .map((item) => `${item.authorName}: ${item.text}`)
      .join("\n");

    return [
      {
        role: "system",
        content: [
          `You are ${agent.displayName}, a member of a small self-improving startup that collaborates in a Slack channel.`,
          `Your role: ${agent.role}`,
          `Your personality: ${agent.personality}`,
          "",
          "How to talk:",
          talkStyle(agent),
          "- Actually do the work: give real analysis, decisions, numbers, or next steps — not vague chatter.",
          "- Build on what teammates just said. Reply as yourself, in your own voice.",
          compressionInstruction(agent),
          "",
          "How work gets done:",
          "- The system automatically assigns you a task from the queue and marks it done when you finish — you do not need to manage that.",
          "- Just focus on producing the actual work product for the task in your reply.",
          "",
          "You can shape the Slack workspace yourself. When you genuinely want to take an action,",
          "add a [SLACK] tag on its own line at the END of your message. Use only when it helps; never spam them.",
          "  [SLACK] action=create_channel name=growth-experiments topic=\"Where we test ideas\"",
          "  [SLACK] action=set_topic channel=<id> topic=<text>   (defaults to this channel if omitted)",
          "  [SLACK] action=set_purpose channel=<id> purpose=<text>",
          "  [SLACK] action=rename_channel channel=<id> name=<new-name>",
          "  [SLACK] action=invite channel=<id> users=<U123,U456>",
          "  [SLACK] action=post channel=<id> text=<message>",
          "  [SLACK] action=pin channel=<id> timestamp=<ts>",
          "  [SLACK] action=react channel=<id> timestamp=<ts> emoji=rocket",
          "  [SLACK] action=bookmark channel=<id> title=<t> link=<url>",
          "  [SLACK] action=list_channels",
          "- Need a capability or tool you don't have yet? Ask for it with: [SLACK] action=request_capability name=<tool> reason=<why>",
          "",
          "You also have research and memory tools. Add a [TOOL] tag on its own line when useful:",
          "  [TOOL] name=web_search query=<what to look up>",
          "  [TOOL] name=http_fetch url=<https url>",
          "  [TOOL] name=remember title=<t> body=<fact to keep> category=lesson|strategy|protocol",
          "  [TOOL] name=recall query=<topic>",
          "  [TOOL] name=calc expr=<arithmetic>",
          "- Keep your written message in your own voice; tags are executed and summarized automatically.",
          this.options.livingRuntime?.buildAgentContext(agent) ?? ""
        ]
          .filter(Boolean)
          .join("\n")
      },
      {
        role: "user",
        content: [
          "Recent Slack conversation:",
          transcript || `${message.authorName}: ${message.text}`,
          "",
          "Write your next Slack message in your style. Do the work — don't just describe it."
        ].join("\n")
      }
    ];
  }
}

function talkStyle(agent: AgentDefinition): string {
  if (agent.compressionStyle === "caveman") {
    return "- Talk like a smart caveman: terse, fast, no fluff. Fragments fine. Get to the point immediately.";
  }
  return "- Write like a real human teammate in Slack: clear, natural, complete sentences. No robotic filler.";
}

function compressionInstruction(agent: AgentDefinition): string {
  if (agent.compressionStyle !== "caveman") {
    return "- Use normal, professional, conversational English — the way a smart colleague writes in Slack.";
  }

  return [
    "Caveman compression, ALWAYS on:",
    "- Drop articles (a/the), filler (just/really/basically), greetings, sign-offs.",
    "- Short fragments. Pattern: [thing] [action] [reason]. [next step].",
    "- Keep all substance: decisions, numbers, risks, next steps.",
    "- Preserve code, commands, URLs, exact errors byte-for-byte.",
    "- Never announce the style or add a normal-language recap."
  ].join("\n");
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Legacy Slack bot usernames still used in workspace tokens. */
const AGENT_ALIASES: Record<string, string[]> = {
  architect: ["ceo"],
  auditor: ["researcher"],
  operator: ["engineer"],
  breeder: ["marketer"],
  chronicler: ["critic"]
};
