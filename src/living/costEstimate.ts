import type { AgentDefinition, ProviderName } from "../types.js";

const COST_PER_CALL_USD: Record<ProviderName, number> = {
  mock: 0.001,
  gemini: 0.0005,
  groq: 0.001,
  openrouter: 0.001,
  ollama: 0
};

export function estimateCallCostUsd(agent: AgentDefinition): number {
  if (agent.provider === "gemini" && agent.model.includes("lite")) {
    return 0.0005;
  }
  return COST_PER_CALL_USD[agent.provider] ?? 0.01;
}
