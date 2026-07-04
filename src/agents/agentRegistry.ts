import { readFileSync } from "node:fs";
import * as z from "zod";
import YAML from "yaml";
import type {
  AgentDefinition,
  AgentNetworkConfig,
  BudgetConfig,
  CoordinationConfig
} from "../types.js";

const providerSchema = z.enum(["mock", "gemini", "groq", "openrouter", "ollama"]);
const respondsWhenSchema = z.enum(["always", "mentioned", "mentioned-or-relevant"]);
const compressionStyleSchema = z.enum(["normal", "caveman"]);

const agentSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  role: z.string().min(1),
  personality: z.string().min(1),
  provider: providerSchema.optional(),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  compressionStyle: compressionStyleSchema.optional(),
  respondsWhen: respondsWhenSchema.optional(),
  cooldownMs: z.number().int().nonnegative().optional(),
  slack: z.object({
    botTokenEnv: z.string().min(1),
    appTokenEnv: z.string().min(1),
    signingSecretEnv: z.string().min(1).optional()
  }),
  relevanceKeywords: z.array(z.string().min(1)).default([])
});

const configSchema = z.object({
  defaults: z.object({
    provider: providerSchema.default("mock"),
    model: z.string().min(1).default("mock"),
    temperature: z.number().min(0).max(2).default(0.6),
    compressionStyle: compressionStyleSchema.default("caveman"),
    respondsWhen: respondsWhenSchema.default("mentioned-or-relevant"),
    cooldownMs: z.number().int().nonnegative().default(20000)
  }),
  budget: z.object({
    dailyRealCallLimit: z.number().int().nonnegative().default(18)
  }),
  coordination: z.object({
    maxConsecutiveAgentTurns: z.number().int().positive().default(5),
    responseDelayMs: z.number().int().nonnegative().default(1500),
    maxResponsesPerMessage: z.number().int().positive().default(1),
    recentMessageLimit: z.number().int().positive().default(12)
  }),
  agents: z.array(agentSchema).min(1)
});

export class AgentRegistry {
  private readonly config: AgentNetworkConfig;
  private readonly agentsById: Map<string, AgentDefinition>;

  constructor(config: AgentNetworkConfig) {
    this.config = config;
    this.agentsById = new Map(config.agents.map((agent) => [agent.id, agent]));

    if (this.agentsById.size !== config.agents.length) {
      throw new Error("Agent configuration contains duplicate ids.");
    }
  }

  static fromYamlFile(path: string): AgentRegistry {
    const file = readFileSync(path, "utf8");
    const parsed = configSchema.parse(YAML.parse(file));
    const config: AgentNetworkConfig = {
      defaults: parsed.defaults,
      budget: parsed.budget,
      coordination: parsed.coordination,
      agents: parsed.agents.map((agent) => ({
        ...agent,
        provider: agent.provider ?? parsed.defaults.provider,
        model: agent.model ?? parsed.defaults.model,
        temperature: agent.temperature ?? parsed.defaults.temperature,
        compressionStyle: agent.compressionStyle ?? parsed.defaults.compressionStyle,
        respondsWhen: agent.respondsWhen ?? parsed.defaults.respondsWhen,
        cooldownMs: agent.cooldownMs ?? parsed.defaults.cooldownMs
      }))
    };

    return new AgentRegistry(config);
  }

  list(): AgentDefinition[] {
    return Array.from(this.agentsById.values());
  }

  getBudget(): BudgetConfig {
    return this.config.budget;
  }

  getCoordination(): CoordinationConfig {
    return this.config.coordination;
  }

  getConfig(): AgentNetworkConfig {
    return this.config;
  }

  getRequired(id: string): AgentDefinition {
    const agent = this.agentsById.get(id);

    if (!agent) {
      throw new Error(`Unknown agent: ${id}`);
    }

    return agent;
  }
}
