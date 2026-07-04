import type {
  AgentDefinition,
  CompressionStyle,
  ProviderName,
  RespondsWhen
} from "../types.js";
import type { AgentRegistry } from "./agentRegistry.js";
import type { LivingStore } from "../living/store.js";
import type { DynamicAgentRecord } from "../living/types.js";

function envKeyForAgent(id: string, suffix: string): string {
  return `SLACK_${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

export function dynamicRecordToAgent(record: DynamicAgentRecord): AgentDefinition {
  return {
    id: record.id,
    displayName: record.displayName,
    role: record.roleDescription,
    personality: record.personality,
    provider: record.provider as ProviderName,
    model: record.model,
    temperature: record.temperature,
    compressionStyle: record.compressionStyle as CompressionStyle,
    respondsWhen: record.respondsWhen as RespondsWhen,
    cooldownMs: record.cooldownMs,
    slack: {
      botTokenEnv: envKeyForAgent(record.id, "BOT_TOKEN"),
      appTokenEnv: envKeyForAgent(record.id, "APP_TOKEN"),
      signingSecretEnv: envKeyForAgent(record.id, "SIGNING_SECRET")
    },
    relevanceKeywords: record.relevanceKeywords
  };
}

export function agentHasSlackTokens(agent: AgentDefinition, env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[agent.slack.botTokenEnv] && env[agent.slack.appTokenEnv]);
}

/**
 * Merges static YAML agents with dynamically bred agents from the Living Company store.
 */
export class CompositeAgentRegistry {
  constructor(
    private readonly base: AgentRegistry,
    private readonly store: LivingStore,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  list(): AgentDefinition[] {
    const dynamic = this.store
      .listDynamicAgents("active")
      .map(dynamicRecordToAgent);
    return [...this.base.list(), ...dynamic];
  }

  getBudget() {
    return this.base.getBudget();
  }

  getCoordination() {
    return this.base.getCoordination();
  }

  getConfig() {
    return this.base.getConfig();
  }

  getRequired(id: string): AgentDefinition {
    const agent = this.list().find((item) => item.id === id);
    if (!agent) {
      throw new Error(`Unknown agent: ${id}`);
    }
    return agent;
  }

  /** Agents that can post directly to Slack (have tokens). Others use proxy. */
  listSlackReady(): AgentDefinition[] {
    return this.list().filter((agent) => agentHasSlackTokens(agent, this.env));
  }

  /** All agents including those that post via Chronicler proxy. */
  listAllParticipating(): AgentDefinition[] {
    return this.list();
  }

  resolveSlackPoster(agent: AgentDefinition): { agentId: string; proxy: boolean } {
    if (agentHasSlackTokens(agent, this.env)) {
      return { agentId: agent.id, proxy: false };
    }
    return { agentId: "chronicler", proxy: true };
  }
}
