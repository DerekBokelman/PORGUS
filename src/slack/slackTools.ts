/**
 * Slack workspace tools the agents can drive themselves. Agents emit a
 * `[SLACK] action=... key=value` tag in their message; the runtime parses it
 * here and executes it against the Slack Web API using the acting agent's own
 * bot token. This lets the company shape its own workspace: create channels,
 * set topics, invite teammates, pin/bookmark knowledge, react, and post.
 */

export interface SlackToolCall {
  action: string;
  args: Record<string, string>;
}

/** Passed through a single agent turn so follow-up tools reuse the right channel. */
export interface SlackToolContext {
  defaultChannelId?: string;
  /** Set after create_channel / name_taken resolve; preferred fallback for bare channel ops. */
  activeChannelId?: string;
}

/** Minimal structural view of the Slack WebClient methods we use (App.client). */
export interface SlackClientLike {
  conversations: {
    create(args: Record<string, unknown>): Promise<SlackApiResult>;
    rename(args: Record<string, unknown>): Promise<SlackApiResult>;
    setTopic(args: Record<string, unknown>): Promise<SlackApiResult>;
    setPurpose(args: Record<string, unknown>): Promise<SlackApiResult>;
    invite(args: Record<string, unknown>): Promise<SlackApiResult>;
    join(args: Record<string, unknown>): Promise<SlackApiResult>;
    archive(args: Record<string, unknown>): Promise<SlackApiResult>;
    list(args?: Record<string, unknown>): Promise<SlackApiResult>;
  };
  chat: { postMessage(args: Record<string, unknown>): Promise<SlackApiResult> };
  reactions: { add(args: Record<string, unknown>): Promise<SlackApiResult> };
  pins: { add(args: Record<string, unknown>): Promise<SlackApiResult> };
  bookmarks: { add(args: Record<string, unknown>): Promise<SlackApiResult> };
}

export interface SlackApiResult {
  ok?: boolean;
  error?: string;
  channel?: { id?: string; name?: string } | string;
  channels?: Array<{ id?: string; name?: string }>;
  [key: string]: unknown;
}

const TAG = /\[SLACK\]\s*([^\[]*)/gi;

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    fields[match[1]] = match[3] ?? match[4] ?? match[5] ?? "";
  }
  return fields;
}

/** Extract every `[SLACK] action=... k=v` tool call from an agent's message. */
export function parseSlackToolCalls(text: string): SlackToolCall[] {
  const calls: SlackToolCall[] = [];
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG.exec(text)) !== null) {
    const fields = parseFields(match[1].trim());
    const { action, ...args } = fields;
    if (action) {
      calls.push({ action: action.toLowerCase(), args });
    }
  }
  return calls;
}

/** Human-readable names of every supported action, for prompts and errors. */
export const SLACK_TOOL_ACTIONS = [
  "create_channel",
  "rename_channel",
  "set_topic",
  "set_purpose",
  "invite",
  "archive_channel",
  "post",
  "react",
  "pin",
  "bookmark",
  "list_channels",
  "request_capability"
] as const;

function channelId(result: SlackApiResult): string | undefined {
  if (typeof result.channel === "object" && result.channel) {
    return result.channel.id;
  }
  if (typeof result.channel === "string") {
    return result.channel;
  }
  return undefined;
}

async function listChannels(client: SlackClientLike): Promise<Array<{ id?: string; name?: string }>> {
  const res = await client.conversations.list({
    limit: 200,
    exclude_archived: true,
    types: "public_channel,private_channel"
  });
  if (!res.ok) {
    return [];
  }
  return (res.channels as Array<{ id?: string; name?: string }> | undefined) ?? [];
}

async function findChannelIdByName(client: SlackClientLike, name: string): Promise<string | undefined> {
  const normalized = normalizeChannelName(name);
  const channels = await listChannels(client);
  return channels.find((c) => c.name === normalized)?.id;
}

/** Resolve C-id, #name, or bare name to a Slack channel id. */
async function resolveChannelId(
  client: SlackClientLike,
  channelRef: string,
  context: SlackToolContext
): Promise<string> {
  const ref = channelRef.trim();
  if (!ref) {
    return context.activeChannelId || context.defaultChannelId || "";
  }
  if (/^C[A-Z0-9]+$/i.test(ref)) {
    return ref;
  }
  const byName = await findChannelIdByName(client, ref.replace(/^#/, ""));
  return byName || ref;
}

async function joinChannel(client: SlackClientLike, id: string): Promise<void> {
  const res = await client.conversations.join({ channel: id });
  if (!res.ok && res.error !== "already_in_channel") {
    // Non-fatal — caller surfaces only if a later op fails.
  }
}

function rememberChannel(context: SlackToolContext, id: string): void {
  context.activeChannelId = id;
}

/**
 * Execute a single Slack tool call. Returns a short human-readable status line.
 * Never throws for Slack-level failures — those come back as readable text so a
 * bad call can't crash the agent's turn.
 */
export async function executeSlackTool(
  client: SlackClientLike,
  call: SlackToolCall,
  context: SlackToolContext = {}
): Promise<string> {
  const a = call.args;

  try {
    switch (call.action) {
      case "create_channel": {
        const name = normalizeChannelName(a.name || a.channel || "");
        if (!name) return "create_channel skipped: missing name";

        let res = await client.conversations.create({
          name,
          is_private: a.private === "true"
        });

        if (!res.ok && res.error === "name_taken") {
          const existingId = await findChannelIdByName(client, name);
          if (!existingId) {
            return `create_channel failed: name_taken (#${name} exists but could not resolve id — run list_channels)`;
          }
          await joinChannel(client, existingId);
          rememberChannel(context, existingId);
          if (a.topic) await client.conversations.setTopic({ channel: existingId, topic: a.topic });
          if (a.purpose) await client.conversations.setPurpose({ channel: existingId, purpose: a.purpose });
          return `Channel #${name} already exists (${existingId}) — joined; use channel=${existingId} for follow-ups`;
        }

        if (!res.ok) return `create_channel failed: ${res.error}`;
        const id = channelId(res);
        if (id) {
          await joinChannel(client, id);
          rememberChannel(context, id);
          if (a.topic) await client.conversations.setTopic({ channel: id, topic: a.topic });
          if (a.purpose) await client.conversations.setPurpose({ channel: id, purpose: a.purpose });
          return `Created channel #${name} (${id}) — use channel=${id} for set_topic/invite/pin`;
        }
        return `Created channel #${name}`;
      }
      case "rename_channel": {
        const channel = await resolveChannelId(client, a.channel || a.channel_id || "", context);
        if (!channel) return "rename_channel skipped: missing channel (use channel=C… id from create_channel)";
        const name = normalizeChannelName(a.name || "");
        const res = await client.conversations.rename({ channel, name });
        return res.ok ? `Renamed channel to #${name}` : `rename_channel failed: ${res.error}`;
      }
      case "set_topic": {
        const channel = await resolveChannelId(client, a.channel || a.channel_id || "", context);
        if (!channel) {
          return "set_topic skipped: missing channel (omit channel to use last created, or pass channel=C… id)";
        }
        await joinChannel(client, channel);
        const res = await client.conversations.setTopic({ channel, topic: a.topic || a.text || "" });
        return res.ok ? `Updated topic on ${channel}` : `set_topic failed: ${res.error}`;
      }
      case "set_purpose": {
        const channel = await resolveChannelId(client, a.channel || a.channel_id || "", context);
        if (!channel) {
          return "set_purpose skipped: missing channel (omit channel to use last created, or pass channel=C… id)";
        }
        await joinChannel(client, channel);
        const res = await client.conversations.setPurpose({
          channel,
          purpose: a.purpose || a.text || ""
        });
        return res.ok ? `Updated purpose on ${channel}` : `set_purpose failed: ${res.error}`;
      }
      case "invite": {
        const channel = await resolveChannelId(client, a.channel || a.channel_id || "", context);
        if (!channel) return "invite skipped: missing channel";
        await joinChannel(client, channel);
        const users = (a.users || a.user || "").replace(/[@\s]/g, "");
        if (!users) return "invite skipped: missing users (need Slack user ids like U123ABC, not @names)";
        const res = await client.conversations.invite({ channel, users });
        return res.ok ? `Invited ${users} to ${channel}` : `invite failed: ${res.error}`;
      }
      case "archive_channel": {
        const channel = await resolveChannelId(client, a.channel || a.channel_id || "", context);
        if (!channel) return "archive_channel skipped: missing channel";
        const res = await client.conversations.archive({ channel });
        return res.ok ? "Archived channel" : `archive_channel failed: ${res.error}`;
      }
      case "post": {
        const channel = await resolveChannelId(client, a.channel || a.channel_id || "", context);
        if (!channel) return "post skipped: missing channel";
        const res = await client.chat.postMessage({ channel, text: a.text || a.message || "" });
        return res.ok ? "Posted message" : `post failed: ${res.error}`;
      }
      case "react": {
        const channel = await resolveChannelId(client, a.channel || a.channel_id || "", context);
        if (!channel || !a.timestamp) return "react skipped: missing channel/timestamp";
        const res = await client.reactions.add({
          channel,
          timestamp: a.timestamp,
          name: (a.emoji || a.name || "thumbsup").replace(/:/g, "")
        });
        return res.ok ? "Added reaction" : `react failed: ${res.error}`;
      }
      case "pin": {
        const channel = await resolveChannelId(client, a.channel || a.channel_id || "", context);
        if (!channel || !a.timestamp) return "pin skipped: missing channel/timestamp";
        await joinChannel(client, channel);
        const res = await client.pins.add({ channel, timestamp: a.timestamp });
        return res.ok ? "Pinned message" : `pin failed: ${res.error}`;
      }
      case "bookmark": {
        const channel = await resolveChannelId(client, a.channel || a.channel_id || "", context);
        if (!channel) return "bookmark skipped: missing channel";
        const res = await client.bookmarks.add({
          channel_id: channel,
          title: a.title || "Bookmark",
          type: "link",
          link: a.link || a.url || ""
        });
        return res.ok ? `Added bookmark "${a.title || "Bookmark"}"` : `bookmark failed: ${res.error}`;
      }
      case "list_channels": {
        const channels = await listChannels(client);
        if (channels.length === 0) {
          return "list_channels: none visible (or list failed)";
        }
        return `Channels: ${channels.map((c) => `#${c.name} (${c.id})`).join(", ")}`;
      }
      case "request_capability": {
        const name = a.name || a.tool || a.capability || "unnamed";
        const reason = a.reason || a.why || "no reason given";
        return `Requested new capability "${name}": ${reason}`;
      }
      default:
        return `Unknown Slack action "${call.action}". Available: ${SLACK_TOOL_ACTIONS.join(", ")}`;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    return `${call.action} errored: ${reason}`;
  }
}

/** Slack channel names: lowercase, no spaces, max 80 chars. */
function normalizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
