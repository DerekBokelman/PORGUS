import type { AgentDefinition, LlmUsage, ProviderName } from "../types.js";

interface TokenPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Nominal $/1M-token rates for the ledger's burn-rate simulation. Every provider
 * here runs on a free tier or local compute, so no real invoice exists — these
 * rates approximate each model's published paid-tier list price so the cost and
 * score-per-dollar mechanics stay meaningful, scaled by actual usage instead of
 * a flat per-call guess.
 */
const PRICING: Record<ProviderName, TokenPricing> = {
  mock: { inputPerMTok: 0, outputPerMTok: 0 },
  gemini: { inputPerMTok: 0.075, outputPerMTok: 0.3 },
  groq: { inputPerMTok: 0.59, outputPerMTok: 0.79 },
  openrouter: { inputPerMTok: 0.1, outputPerMTok: 0.3 },
  ollama: { inputPerMTok: 0, outputPerMTok: 0 }
};

/** Fallback for a completed call whose provider didn't report token usage. */
const FLAT_FALLBACK_USD: Record<ProviderName, number> = {
  mock: 0.001,
  gemini: 0.0005,
  groq: 0.001,
  openrouter: 0.001,
  ollama: 0
};

export function estimateCallCostUsd(agent: AgentDefinition, usage?: LlmUsage): number {
  if (usage) {
    const pricing = PRICING[agent.provider];
    return (
      (usage.inputTokens * pricing.inputPerMTok) / 1_000_000 +
      (usage.outputTokens * pricing.outputPerMTok) / 1_000_000
    );
  }
  return FLAT_FALLBACK_USD[agent.provider] ?? 0.01;
}
