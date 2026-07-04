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

/** Minimal structural view of the Slack WebClient methods we use (App.client). */
export interface SlackClientLike {
  conversations: {
    create(args: Record<string, unknown>): Promise<SlackApiResult>;
    rename(args: Record<string, unknown>): Promise<SlackApiResult>;
    setTopic(args: Record<string, unknown>): Promise<SlackApiResult>;
    setPurpose(args: Record<string, unknown>): Promise<SlackApiResult>;
    invite(args: Record<string, unknown>): Promise<SlackApiResult>;
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

/**
 * Execute a single Slack tool call. Returns a short human-readable status line.
 * Never throws for Slack-level failures — those come back as readable text so a
 * bad call can't crash the agent's turn.
 */
export async function executeSlackTool(
  client: SlackClientLike,
  call: SlackToolCall,
  context: { defaultChannelId?: string }
): Promise<string> {
  const a = call.args;
  const channel = a.channel || a.channel_id || context.defaultChannelId || "";

  try {
    switch (call.action) {
      case "create_channel": {
        const name = normalizeChannelName(a.name || a.channel || "");
        if (!name) return "create_channel skipped: missing name";
        const res = await client.conversations.create({
          name,
          is_private: a.private === "true"
        });
        if (!res.ok) return `create_channel failed: ${res.error}`;
        const id = channelId(res);
        if (id && a.topic) await client.conversations.setTopic({ channel: id, topic: a.topic });
        if (id && a.purpose) await client.conversations.setPurpose({ channel: id, purpose: a.purpose });
        return `Created channel #${name}${id ? ` (${id})` : ""}`;
      }
      case "rename_channel": {
        if (!channel) return "rename_channel skipped: missing channel";
        const name = normalizeChannelName(a.name || "");
        const res = await client.conversations.rename({ channel, name });
        return res.ok ? `Renamed channel to #${name}` : `rename_channel failed: ${res.error}`;
      }
      case "set_topic": {
        if (!channel) return "set_topic skipped: missing channel";
        const res = await client.conversations.setTopic({ channel, topic: a.topic || a.text || "" });
        return res.ok ? "Updated channel topic" : `set_topic failed: ${res.error}`;
      }
      case "set_purpose": {
        if (!channel) return "set_purpose skipped: missing channel";
        const res = await client.conversations.setPurpose({
          channel,
          purpose: a.purpose || a.text || ""
        });
        return res.ok ? "Updated channel purpose" : `set_purpose failed: ${res.error}`;
      }
      case "invite": {
        if (!channel) return "invite skipped: missing channel";
        const users = (a.users || a.user || "").replace(/[@\s]/g, "");
        if (!users) return "invite skipped: missing users";
        const res = await client.conversations.invite({ channel, users });
        return res.ok ? `Invited ${users} to channel` : `invite failed: ${res.error}`;
      }
      case "archive_channel": {
        if (!channel) return "archive_channel skipped: missing channel";
        const res = await client.conversations.archive({ channel });
        return res.ok ? "Archived channel" : `archive_channel failed: ${res.error}`;
      }
      case "post": {
        if (!channel) return "post skipped: missing channel";
        const res = await client.chat.postMessage({ channel, text: a.text || a.message || "" });
        return res.ok ? "Posted message" : `post failed: ${res.error}`;
      }
      case "react": {
        if (!channel || !a.timestamp) return "react skipped: missing channel/timestamp";
        const res = await client.reactions.add({
          channel,
          timestamp: a.timestamp,
          name: (a.emoji || a.name || "thumbsup").replace(/:/g, "")
        });
        return res.ok ? "Added reaction" : `react failed: ${res.error}`;
      }
      case "pin": {
        if (!channel || !a.timestamp) return "pin skipped: missing channel/timestamp";
        const res = await client.pins.add({ channel, timestamp: a.timestamp });
        return res.ok ? "Pinned message" : `pin failed: ${res.error}`;
      }
      case "bookmark": {
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
        const res = await client.conversations.list({ limit: 20, exclude_archived: true });
        if (!res.ok) return `list_channels failed: ${res.error}`;
        const channels = (res.channels as Array<{ name?: string }> | undefined) ?? [];
        return `Channels: ${channels.map((c) => `#${c.name}`).join(", ") || "none"}`;
      }
      case "request_capability": {
        const name = a.name || a.tool || a.capability || "unnamed";
        const reason = a.reason || a.why || "no reason given";
        // Logged and surfaced in-channel so the team/human can grant new tools or scopes.
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
