import { App, type LogLevel } from "@slack/bolt";
import type { CompositeAgentRegistry } from "../agents/compositeRegistry.js";
import type { AgentRegistry } from "../agents/agentRegistry.js";
import type { AgentResponder, ConversationCoordinator } from "../coordinator/conversationCoordinator.js";
import type { MemoryStore } from "../memory/memoryStore.js";
import type { AgentDefinition, ChannelMessage } from "../types.js";
import { executeSlackTool, parseSlackToolCalls, type SlackClientLike } from "./slackTools.js";

export interface MultiBotRuntimeOptions {
  registry: AgentRegistry | CompositeAgentRegistry;
  memory: MemoryStore;
  coordinator: ConversationCoordinator;
  env?: NodeJS.ProcessEnv;
  logLevel?: LogLevel;
}

function resolvePoster(
  registry: AgentRegistry | CompositeAgentRegistry,
  agent: AgentDefinition
): { appAgentId: string; displayName: string; proxy: boolean } {
  if ("resolveSlackPoster" in registry) {
    const resolved = registry.resolveSlackPoster(agent);
    return { appAgentId: resolved.agentId, displayName: agent.displayName, proxy: resolved.proxy };
  }
  return { appAgentId: agent.id, displayName: agent.displayName, proxy: false };
}

export interface MultiBotRuntime {
  responder: AgentResponder;
}

export async function startMultiBotRuntime(options: MultiBotRuntimeOptions): Promise<MultiBotRuntime> {
  const env = options.env ?? process.env;
  const appsByAgentId = new Map<string, App>();

  const responder: AgentResponder = {
    postAgentMessage: async (agent: AgentDefinition, text: string, sourceMessage: ChannelMessage) => {
      const poster = resolvePoster(options.registry, agent);
      const app = appsByAgentId.get(poster.appAgentId);
      if (!app) {
        throw new Error(`No Slack app registered for agent: ${poster.appAgentId}`);
      }

      const prefix = poster.proxy ? `[${agent.displayName}] ` : "";
      // Autonomous heartbeat posts have no anchoring ts — post top-level, not threaded.
      const threadTs = sourceMessage.threadTs || sourceMessage.ts || undefined;
      const response = await app.client.chat.postMessage({
        channel: sourceMessage.channelId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        username: poster.displayName,
        text: `${prefix}${text}`
      });

      if (!response.ts) {
        throw new Error(`Slack did not return a timestamp for ${agent.id}.`);
      }

      return { ts: response.ts };
    },

    runAgentTools: async (agent: AgentDefinition, rawText: string, sourceMessage: ChannelMessage) => {
      const calls = parseSlackToolCalls(rawText);
      if (calls.length === 0) {
        return [];
      }
      const poster = resolvePoster(options.registry, agent);
      const app = appsByAgentId.get(poster.appAgentId);
      if (!app) {
        return [`Slack tools unavailable: no app for ${poster.appAgentId}`];
      }
      const client = app.client as unknown as SlackClientLike;
      const results: string[] = [];
      for (const call of calls) {
        results.push(
          await executeSlackTool(client, call, { defaultChannelId: sourceMessage.channelId })
        );
      }
      return results;
    }
  };

  const slackAgents =
    "listSlackReady" in options.registry
      ? (options.registry as CompositeAgentRegistry).listSlackReady()
      : options.registry.list();

  for (const agent of slackAgents) {
    if (appsByAgentId.has(agent.id)) {
      continue;
    }
    appsByAgentId.set(agent.id, createAgentApp(agent, env, options.logLevel));
  }

  // Chronicler proxy for dynamic agents without their own Slack app.
  if (!appsByAgentId.has("chronicler")) {
    const chronicler = options.registry.list().find((a) => a.id === "chronicler");
    if (chronicler) {
      appsByAgentId.set("chronicler", createAgentApp(chronicler, env, options.logLevel));
    }
  }

  const ingressAgentId = env.SLACK_INGRESS_AGENT_ID ?? "architect";
  const ingressAgent = slackAgents.find((agent) => agent.id === ingressAgentId) ?? slackAgents[0];

  if (!ingressAgent) {
    throw new Error("No Slack-ready agents found. Set bot tokens in .env for at least one agent.");
  }

  const ingressApp = appsByAgentId.get(ingressAgent.id);
  if (!ingressApp) {
    throw new Error(`No Slack app registered for ingress agent: ${ingressAgent.id}`);
  }

  ingressApp.event("message", async ({ event, logger }) => {
    const messageEvent = event as SlackMessageEvent;

    if (messageEvent.bot_id || messageEvent.subtype || !messageEvent.text || !messageEvent.channel || !messageEvent.ts) {
      return;
    }

    try {
      const recorded = await options.memory.recordChannelMessage({
        channelId: messageEvent.channel,
        ts: messageEvent.ts,
        threadTs: messageEvent.thread_ts,
        authorType: "human",
        authorId: messageEvent.user ?? "unknown",
        authorName: messageEvent.user ?? "Human",
        text: messageEvent.text
      });

      if (recorded) {
        await options.coordinator.handleMessage(recorded, responder);
      }
    } catch (error) {
      logger.error(error);
    }
  });

  for (const [agentId, app] of appsByAgentId) {
    await app.start();
    const role = agentId === ingressAgent.id ? " (ingress)" : "";
    console.log(`Started Slack bot for ${agentId}${role}.`);
  }

  return { responder };
}

function createAgentApp(agent: AgentDefinition, env: NodeJS.ProcessEnv, logLevel?: LogLevel): App {
  return new App({
    token: requiredEnv(env, agent.slack.botTokenEnv),
    appToken: requiredEnv(env, agent.slack.appTokenEnv),
    signingSecret: agent.slack.signingSecretEnv
      ? requiredEnv(env, agent.slack.signingSecretEnv)
      : "socket-mode-signing-secret",
    socketMode: true,
    logLevel
  });
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value) {
    throw new Error(`${key} is required to start the configured Slack bots.`);
  }

  return value;
}

interface SlackMessageEvent {
  type: "message";
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}
