# Agent instructions

**Full project handoff:** read [`CLAUDE.md`](./CLAUDE.md) first. It has architecture, env setup, Slack app IDs, known issues, and current provider map.

## Commands

```bash
bun install && bun run dev    # start all Slack bots
bun run test                  # vitest
bun run check-providers       # verify LLM keys
```

## Hard rules

- Never commit `.env` or `data/agent-company.db`
- Branch: `cursor/living-company-multi-provider` → base `main`
- Agent config: `config/agents.yaml` (budget limit **200**, not 45)
- Architect uses **openrouter**, not Gemini (quota exhaustion)
