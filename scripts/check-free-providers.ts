#!/usr/bin/env bun
/**
 * Smoke-test each free provider configured in config/agents.yaml.
 * Usage: bun scripts/check-free-providers.ts
 */
import { resolve } from "node:path";
import "dotenv/config";
import { AgentRegistry } from "../src/agents/agentRegistry.js";
import { ProviderFactory } from "../src/providers/providerFactory.js";

const registry = AgentRegistry.fromYamlFile(resolve("config/agents.yaml"));
const factory = new ProviderFactory({ fallbackToMock: false });

console.log("Checking free-tier providers for each agent...\n");

for (const agent of registry.list()) {
  process.stdout.write(`${agent.displayName} (${agent.provider}/${agent.model})... `);
  try {
    const provider = factory.createForAgent(agent);
    const reply = await provider.complete({
      agent,
      messages: [{ role: "user", content: "Reply with one word: ok" }],
      temperature: agent.temperature
    });
    console.log(reply.slice(0, 60).replace(/\n/g, " ") || "(empty)");
  } catch (error) {
    console.log("FAIL");
    console.error(`  ${error instanceof Error ? error.message : error}`);
  }
}

console.log("\nDone.");
