#!/usr/bin/env bun
/**
 * Verify all five agents: YAML config, Slack tokens, LLM providers, Ollama.
 * Usage: bun scripts/check-agents.ts
 */
import { resolve } from "node:path";
import "dotenv/config";
import { AgentRegistry } from "../src/agents/agentRegistry.js";
import { ensureSlackAgentsReady } from "../src/slack/slackSetup.js";
import { ProviderFactory } from "../src/providers/providerFactory.js";

const registry = AgentRegistry.fromYamlFile(resolve("config/agents.yaml"));
const factory = new ProviderFactory({ fallbackToMock: false });
const channelId = process.env.SLACK_CHANNEL_ID;

console.log("Agent Company setup check\n");

let failures = 0;

console.log("Config (config/agents.yaml):");
for (const agent of registry.list()) {
  console.log(`  ${agent.displayName.padEnd(12)} ${agent.provider}/${agent.model} [${agent.compressionStyle}]`);
}

console.log("\nSlack tokens:");
const slackRows = await ensureSlackAgentsReady(registry, process.env, channelId);
for (const row of slackRows) {
  if (!row.authOk) {
    failures++;
    console.log(`  FAIL ${row.displayName}: ${row.error}`);
    continue;
  }
  const alias =
    row.slackUser && row.slackUser !== row.agentId ? ` posts as @${row.slackUser}` : "";
  const join =
    channelId && row.joinOk === false ? ` | channel join: ${row.joinError}` : channelId ? " | in channel" : "";
  console.log(`  OK   ${row.displayName}${alias}${join}`);
}

console.log("\nLLM providers:");
for (const agent of registry.list()) {
  process.stdout.write(`  ${agent.displayName.padEnd(12)} `);
  try {
    const provider = factory.createForAgent(agent);
    const reply = await provider.complete({
      agent,
      messages: [{ role: "user", content: "Reply with one word: ok" }],
      temperature: agent.temperature
    });
    console.log(reply.slice(0, 40).replace(/\n/g, " ") || "(empty)");
  } catch (error) {
    failures++;
    console.log(`FAIL — ${error instanceof Error ? error.message : error}`);
  }
}

console.log(`\n${failures === 0 ? "All agents ready." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
