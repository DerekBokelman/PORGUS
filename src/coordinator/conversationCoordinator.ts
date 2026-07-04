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
}

export interface ConversationCoordinatorOptions {
  registry: AgentRegistry | CompositeAgentRegistry;
  memory: MemoryStore;
  budgetGuard: BudgetGuard;
  providerResolver: ProviderResolver;
  livingRuntime?: LivingCompanyRuntime;
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

    const candidates = this.selectCandidateAgents(message).slice(
      0,
      this.options.registry.getCoordination().maxResponsesPerMessage
    );

    for (const agent of candidates) {
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

      const startedAt = Date.now();
      const provider = this.options.providerResolver.createForAgent(agent);
      const rawText = await provider.complete({
        agent,
        messages: await this.buildPrompt(agent, message),
        temperature: agent.temperature
      });

      await this.options.budgetGuard.recordRealCall(agent);

      let text = rawText.trim();
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

      if (!text) {
        continue;
      }

      const post = await responder.postAgentMessage(agent, text, message);
      this.lastResponseAtByAgent.set(agent.id, Date.now());
      this.consecutiveAgentTurns += 1;

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
    const mentioned =
      text.includes(`@${agent.id.toLowerCase()}`) ||
      text.includes(`@${agent.displayName.toLowerCase()}`) ||
      text.includes(agent.displayName.toLowerCase());

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
          `You are ${agent.displayName}.`,
          `Role: ${agent.role}`,
          `Personality: ${agent.personality}`,
          compressionInstruction(agent),
          "You are one member of a self-improving agent company on Slack.",
          "All work flows through the task queue — claim tasks, execute, post RESULT.",
          "Reply as yourself, keep it concise, and move the company forward.",
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
          "Write your next Slack message."
        ].join("\n")
      }
    ];
  }
}

function compressionInstruction(agent: AgentDefinition): string {
  if (agent.compressionStyle !== "caveman") {
    return "Use normal concise business language.";
  }

  return [
    "Use Caveman compression:",
    "- Short fragments. No filler. No greetings. No sign-offs.",
    "- Keep substance, decisions, risks, and next steps.",
    "- Preserve code, commands, URLs, and exact errors byte-for-byte."
  ].join("\n");
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}
