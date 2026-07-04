import { resolve } from "node:path";
import { AgentRegistry } from "./agents/agentRegistry.js";
import { CompositeAgentRegistry } from "./agents/compositeRegistry.js";
import { loadConfig } from "./config/env.js";
import { ConversationCoordinator } from "./coordinator/conversationCoordinator.js";
import { bootstrapLivingCompany } from "./living/bootstrap.js";
import { HeadcountManager } from "./living/headcount.js";
import { LivingCompanyRuntime } from "./living/runtime.js";
import { SqliteLivingStore } from "./living/sqliteLivingStore.js";
import { BudgetGuard } from "./memory/budgetGuard.js";
import { SqliteMemoryStore } from "./memory/sqliteMemoryStore.js";
import { ProviderFactory } from "./providers/providerFactory.js";
import { startMultiBotRuntime } from "./slack/botRuntime.js";

async function main() {
  const config = loadConfig();
  const baseRegistry = AgentRegistry.fromYamlFile(resolve("config/agents.yaml"));
  const memory = new SqliteMemoryStore(config.databasePath);
  const livingStore = new SqliteLivingStore(config.databasePath);
  const registry = new CompositeAgentRegistry(baseRegistry, livingStore);

  const company = bootstrapLivingCompany({
    registry: baseRegistry,
    store: livingStore,
    spendCeilingUsd: config.livingSpendCeilingUsd
  });

  const headcount = new HeadcountManager(livingStore, company.ledger, {
    humanMaxSlots: config.livingMaxHeadcount,
    coreAgentCount: baseRegistry.list().length
  });

  const livingRuntime = new LivingCompanyRuntime({
    company,
    headcount,
    registry
  });

  const budgetGuard = new BudgetGuard(memory, registry.getBudget().dailyRealCallLimit);
  const providerFactory = new ProviderFactory({
    fallbackToMock: process.env.FALLBACK_TO_MOCK === "true"
  });
  const coordinator = new ConversationCoordinator({
    registry,
    memory,
    budgetGuard,
    providerResolver: providerFactory,
    livingRuntime
  });

  const halt = (signal: string) => {
    company.hardRules.killSwitch.halt();
    console.log(`\nKill switch engaged (${signal}). Halting agent execution.`);
    process.exit(0);
  };
  process.on("SIGINT", () => halt("SIGINT"));
  process.on("SIGTERM", () => halt("SIGTERM"));

  await startMultiBotRuntime({
    registry,
    memory,
    coordinator
  });

  const hc = headcount.state();
  console.log("Agent providers (free tier):");
  for (const agent of registry.list()) {
    console.log(`  ${agent.displayName}: ${agent.provider}/${agent.model} [caveman]`);
  }
  console.log(
    `Agent Company running. Mode: ${company.ledger.mode()} | ` +
      `Spend ceiling $${config.livingSpendCeilingUsd} | ` +
      `Headcount ${headcount.activeAgentCount()}/${hc.activeSlotLimit} (max ${hc.humanMaxSlots})`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
