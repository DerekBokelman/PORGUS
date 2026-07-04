import type { AgentDefinition, LlmProvider, ProviderName } from "../types.js";
import { GeminiProvider } from "./geminiProvider.js";
import { MockProvider } from "./mockProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";
import { RateLimitedProvider } from "./rateLimitedProvider.js";

export interface ProviderFactoryOptions {
  env?: NodeJS.ProcessEnv;
  minIntervalMs?: number;
  fallbackToMock?: boolean;
}

/** Minimum ms between calls per provider (matches free-tier RPM limits). */
const PROVIDER_MIN_INTERVAL_MS: Record<ProviderName, number> = {
  mock: 0,
  gemini: 13000,
  groq: 600,
  openrouter: 400,
  ollama: 50
};

const PROVIDER_KEY_ENV: Partial<Record<ProviderName, string>> = {
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
};

export class ProviderFactory {
  private readonly env: NodeJS.ProcessEnv;
  private readonly envMinIntervalMs: number;
  private readonly fallbackToMock: boolean;
  private readonly cache = new Map<string, LlmProvider>();
  private readonly warned = new Set<string>();

  constructor(options: ProviderFactoryOptions = {}) {
    this.env = options.env ?? process.env;
    this.envMinIntervalMs = options.minIntervalMs ?? Number(this.env.LLM_MIN_INTERVAL_MS ?? 13000);
    this.fallbackToMock = options.fallbackToMock ?? this.env.FALLBACK_TO_MOCK === "true";
  }

  createForAgent(agent: AgentDefinition): LlmProvider {
    const intervalMs = rateLimitMs(agent.provider, this.envMinIntervalMs);
    const cacheKey = `${agent.provider}:${agent.model}:${intervalMs}:${this.fallbackToMock}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let provider: LlmProvider;
    try {
      provider = this.create(agent.provider, agent.model);
    } catch (error) {
      if (!this.fallbackToMock || agent.provider === "mock") {
        throw error;
      }
      this.warnOnce(
        agent.provider,
        `${agent.displayName}: missing ${PROVIDER_KEY_ENV[agent.provider] ?? "config"} — using mock.`
      );
      provider = new MockProvider();
    }

    if (agent.provider !== "mock" && intervalMs > 0) {
      provider = new RateLimitedProvider(provider, intervalMs);
    }

    this.cache.set(cacheKey, provider);
    return provider;
  }

  private create(provider: ProviderName, model: string): LlmProvider {
    switch (provider) {
      case "mock":
        return new MockProvider();
      case "gemini":
        return new GeminiProvider({
          apiKey: requiredEnv(this.env, "GEMINI_API_KEY"),
          model
        });
      case "groq":
        return new OpenAiCompatibleProvider({
          apiKey: requiredEnv(this.env, "GROQ_API_KEY"),
          baseUrl: this.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
          model,
          title: "Agent Company Groq"
        });
      case "openrouter":
        return new OpenAiCompatibleProvider({
          apiKey: requiredEnv(this.env, "OPENROUTER_API_KEY"),
          baseUrl: this.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
          model,
          title: "Agent Company OpenRouter",
          referer: this.env.OPENROUTER_REFERER ?? "https://github.com/agent-company",
          appName: "Agent Company"
        });
      case "ollama":
        return new OllamaProvider({
          baseUrl: this.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
          model
        });
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    console.warn(`[providers] ${message}`);
  }
}

function rateLimitMs(provider: ProviderName, envDefault: number): number {
  const floor = PROVIDER_MIN_INTERVAL_MS[provider];
  if (provider === "gemini") {
    return Math.max(envDefault, floor);
  }
  return floor;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value) {
    throw new Error(`${key} is required for this agent provider.`);
  }

  return value;
}
