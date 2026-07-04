import type { AgentRegistry } from "../agents/agentRegistry.js";
import type { RosterEntry } from "./evolution.js";
import type { HardRuleConfig } from "./hardRules.js";
import { LivingCompany } from "./livingCompany.js";
import type { LivingStore } from "./store.js";
import { ROLES, type Role } from "./types.js";

export interface BootstrapOptions {
  registry: AgentRegistry;
  store: LivingStore;
  spendCeilingUsd: number;
  rollbackWindowCycles?: number;
}

function isRole(id: string): id is Role {
  return (ROLES as string[]).includes(id);
}

export function rosterFromRegistry(registry: AgentRegistry): Map<Role, RosterEntry> {
  const roster = new Map<Role, RosterEntry>();
  for (const agent of registry.list()) {
    if (!isRole(agent.id)) {
      continue;
    }
    roster.set(agent.id, {
      agentId: `${agent.id}-v1`,
      model: agent.model,
      config: JSON.stringify({ id: agent.id, model: agent.model, provider: agent.provider })
    });
  }
  return roster;
}

export function bootstrapLivingCompany(options: BootstrapOptions): LivingCompany {
  const roster = rosterFromRegistry(options.registry);
  const auditorModel = roster.get("auditor")?.model ?? "";
  const breederModel = roster.get("breeder")?.model ?? "";

  const hardRules: HardRuleConfig = {
    humanSpendCeilingUsd: options.spendCeilingUsd,
    swapRollbackWindowCycles: options.rollbackWindowCycles ?? 3,
    auditorModel,
    breederModel
  };

  return new LivingCompany({ store: options.store, roster, hardRules });
}
