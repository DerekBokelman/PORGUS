import type { CompositeAgentRegistry } from "../agents/compositeRegistry.js";
import type { AgentRegistry } from "../agents/agentRegistry.js";
import type { AgentDefinition } from "../types.js";
import { agentHasSlackTokens } from "../agents/compositeRegistry.js";

export interface SlackSetupResult {
  agentId: string;
  displayName: string;
  authOk: boolean;
  slackUser?: string;
  handleMismatch?: boolean;
  joinOk?: boolean;
  joinError?: string;
  error?: string;
}

export async function ensureSlackAgentsReady(
  registry: AgentRegistry | CompositeAgentRegistry,
  env: NodeJS.ProcessEnv = process.env,
  channelId?: string
): Promise<SlackSetupResult[]> {
  const agents =
    "listSlackReady" in registry ? registry.listSlackReady() : registry.list();
  const results: SlackSetupResult[] = [];

  for (const agent of agents) {
    if (!agentHasSlackTokens(agent, env)) {
      results.push({
        agentId: agent.id,
        displayName: agent.displayName,
        authOk: false,
        error: `Missing ${agent.slack.botTokenEnv} or ${agent.slack.appTokenEnv}`
      });
      continue;
    }

    const auth = await slackAuthTest(agent, env);
    results.push(auth);

    if (channelId && auth.authOk) {
      const join = await joinChannel(agent, env, channelId);
      auth.joinOk = join.ok;
      auth.joinError = join.error;
    }
  }

  return results;
}

async function slackAuthTest(
  agent: AgentDefinition,
  env: NodeJS.ProcessEnv
): Promise<SlackSetupResult> {
  const token = requiredEnv(env, agent.slack.botTokenEnv);
  const response = await fetch("https://slack.com/api/auth.test", {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = (await response.json()) as {
    ok: boolean;
    user?: string;
    error?: string;
  };

  return {
    agentId: agent.id,
    displayName: agent.displayName,
    authOk: data.ok,
    slackUser: data.user,
    error: data.ok ? undefined : data.error,
    handleMismatch:
      data.ok && data.user
        ? expectedHandle(agent.id) !== data.user
        : undefined
  };
}

function expectedHandle(agentId: string): string {
  return agentId; // architect -> architect, auditor -> auditor, ...
}

async function joinChannel(
  agent: AgentDefinition,
  env: NodeJS.ProcessEnv,
  channelId: string
): Promise<{ ok: boolean; error?: string }> {
  const token = requiredEnv(env, agent.slack.botTokenEnv);
  const response = await fetch("https://slack.com/api/conversations.join", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ channel: channelId })
  });
  const data = (await response.json()) as { ok: boolean; error?: string };
  if (data.ok || data.error === "already_in_channel") {
    return { ok: true };
  }
  return { ok: false, error: data.error };
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}
