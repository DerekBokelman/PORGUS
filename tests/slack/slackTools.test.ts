import { describe, expect, it, vi } from "vitest";
import {
  executeSlackTool,
  parseSlackToolCalls,
  type SlackClientLike
} from "../../src/slack/slackTools.js";

describe("parseSlackToolCalls", () => {
  it("extracts multiple actions with quoted args", () => {
    const text = [
      "Let's organize our work.",
      '[SLACK] action=create_channel name="Growth Experiments" topic="Test ideas here"',
      "[SLACK] action=set_topic topic=Focus"
    ].join("\n");

    const calls = parseSlackToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      action: "create_channel",
      args: { name: "Growth Experiments", topic: "Test ideas here" }
    });
    expect(calls[1]).toEqual({ action: "set_topic", args: { topic: "Focus" } });
  });

  it("returns nothing when there are no tags", () => {
    expect(parseSlackToolCalls("just a normal message")).toEqual([]);
  });
});

describe("executeSlackTool", () => {
  function fakeClient(overrides: Partial<SlackClientLike> = {}): SlackClientLike {
    return {
      conversations: {
        create: vi.fn(async () => ({ ok: true, channel: { id: "C999", name: "growth" } })),
        rename: vi.fn(async () => ({ ok: true })),
        setTopic: vi.fn(async () => ({ ok: true })),
        setPurpose: vi.fn(async () => ({ ok: true })),
        invite: vi.fn(async () => ({ ok: true })),
        archive: vi.fn(async () => ({ ok: true })),
        list: vi.fn(async () => ({ ok: true, channels: [{ name: "general" }, { name: "random" }] }))
      },
      chat: { postMessage: vi.fn(async () => ({ ok: true, ts: "1.1" })) },
      reactions: { add: vi.fn(async () => ({ ok: true })) },
      pins: { add: vi.fn(async () => ({ ok: true })) },
      bookmarks: { add: vi.fn(async () => ({ ok: true })) },
      ...overrides
    } as SlackClientLike;
  }

  it("creates a channel and normalizes the name", async () => {
    const client = fakeClient();
    const result = await executeSlackTool(
      client,
      { action: "create_channel", args: { name: "Growth Experiments" } },
      {}
    );
    expect(client.conversations.create).toHaveBeenCalledWith({
      name: "growth-experiments",
      is_private: false
    });
    expect(result).toContain("Created channel #growth-experiments");
  });

  it("falls back to the source channel for set_topic", async () => {
    const client = fakeClient();
    const result = await executeSlackTool(
      client,
      { action: "set_topic", args: { topic: "Ship it" } },
      { defaultChannelId: "C-SOURCE" }
    );
    expect(client.conversations.setTopic).toHaveBeenCalledWith({
      channel: "C-SOURCE",
      topic: "Ship it"
    });
    expect(result).toBe("Updated channel topic");
  });

  it("returns a readable error instead of throwing when Slack rejects the call", async () => {
    const client = fakeClient({
      conversations: {
        ...fakeClient().conversations,
        invite: vi.fn(async () => ({ ok: false, error: "not_in_channel" }))
      }
    });
    const result = await executeSlackTool(
      client,
      { action: "invite", args: { channel: "C1", users: "U123" } },
      {}
    );
    expect(result).toBe("invite failed: not_in_channel");
  });

  it("acknowledges capability requests", async () => {
    const result = await executeSlackTool(
      fakeClient(),
      { action: "request_capability", args: { name: "web_search", reason: "research market" } },
      {}
    );
    expect(result).toBe('Requested new capability "web_search": research market');
  });

  it("reports unknown actions with the available list", async () => {
    const result = await executeSlackTool(fakeClient(), { action: "delete_workspace", args: {} }, {});
    expect(result).toContain('Unknown Slack action "delete_workspace"');
  });
});
