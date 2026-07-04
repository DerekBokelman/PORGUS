import { describe, expect, it, vi } from "vitest";
import { AgentToolRunner, parseToolCalls, type ToolMemory } from "../../src/tools/toolRunner.js";
import type { AgentDefinition } from "../../src/types.js";

const agent = { id: "architect", displayName: "Architect" } as AgentDefinition;

describe("parseToolCalls", () => {
  it("parses multiple tool tags with quotes", () => {
    const text = [
      "Plan:",
      '[TOOL] name=web_search query="market size ai agents"',
      "[TOOL] name=calc expr=2*21"
    ].join("\n");
    const calls = parseToolCalls(text);
    expect(calls).toEqual([
      { name: "web_search", args: { query: "market size ai agents" } },
      { name: "calc", args: { expr: "2*21" } }
    ]);
  });
});

describe("AgentToolRunner", () => {
  it("evaluates safe arithmetic and rejects code", async () => {
    const runner = new AgentToolRunner();
    expect(await runner.run(agent, "[TOOL] name=calc expr=2*(3+4)")).toEqual(["calc 2*(3+4) = 14"]);
    const bad = await runner.run(agent, "[TOOL] name=calc expr=process.exit(1)");
    expect(bad[0]).toContain("calc rejected");
  });

  it("remembers and recalls via the memory surface", async () => {
    const store: Array<{ title: string; body: string }> = [];
    const memory: ToolMemory = {
      remember: vi.fn((input) => store.push({ title: input.title, body: input.body })),
      recall: vi.fn((query?: string) =>
        store
          .map((e) => `${e.title}: ${e.body}`)
          .filter((l) => !query || l.includes(query))
          .join("\n")
      )
    };
    const runner = new AgentToolRunner(memory);

    const remembered = await runner.run(
      agent,
      "[TOOL] name=remember title=Pricing body=charge-per-seat category=strategy"
    );
    expect(remembered[0]).toBe('Remembered "Pricing"');
    expect(memory.remember).toHaveBeenCalled();

    const recalled = await runner.run(agent, "[TOOL] name=recall query=Pricing");
    expect(recalled[0]).toContain("charge-per-seat");
  });

  it("fetches the web via injected fetch and truncates", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ AbstractText: "AI agents automate tasks." }), { status: 200 })
    ) as unknown as typeof fetch;
    try {
      const runner = new AgentToolRunner();
      const out = await runner.run(agent, "[TOOL] name=web_search query=ai agents");
      expect(out[0]).toContain("AI agents automate tasks.");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports unknown tools", async () => {
    const runner = new AgentToolRunner();
    const out = await runner.run(agent, "[TOOL] name=launch_rocket");
    expect(out[0]).toContain('Unknown tool "launch_rocket"');
  });
});
