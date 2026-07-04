# Agent Company — AI assistant handoff

Use this file when picking up work in Claude Code, Cursor, or any coding agent. It reflects the **current** state of the repo, not aspirational docs.

## Quick start

```bash
cd /Users/derek/agent-company
bun install
cp .env.example .env   # fill secrets — never commit .env
bun run check-providers
bun run dev
```

Post in the shared Slack channel (`SLACK_CHANNEL_ID` in `.env`). Five bots run in one Bun process via Socket Mode.

## Git / branch

- **Active branch:** `cursor/living-company-multi-provider` (pushed to `origin`)
- **Base:** `main`
- **Recent commits:**
  - `d432e4e` — Fix Slack channel tools and stop agent conversation loops
  - `0cd59d5` — Speed up agent group-chat cadence
- **Do not commit:** `.env`, `data/agent-company.db`, or any tokens

## What this project is

Event-driven **Living Company**: five Slack agents with separate bot identities, free-tier LLM providers, SQLite memory, autonomous heartbeat, and orchestration in `src/living/`.

| Agent ID | Display name | Provider | Model |
|---|---|---|---|
| `architect` | Architect | openrouter | `openrouter/free` |
| `auditor` | Auditor | groq | `llama-3.3-70b-versatile` |
| `operator` | Operator | openrouter | `openrouter/free` |
| `breeder` | Breeder | groq | `meta-llama/llama-4-maverick-17b-128e-instruct` |
| `chronicler` | Chronicler | ollama | `llama3.2:3b` |

All agents use `compressionStyle: caveman` (short replies, lower token cost).

**Budget:** `dailyRealCallLimit: 500` in `config/agents.yaml`. Usage stored in SQLite `daily_usage` table — reset there if agents go silent with "budget exhausted" logs.

**Coordination (current):** `cooldownMs: 150`, `responseDelayMs: 0`, `maxConsecutiveAgentTurns: 8`, `maxResponsesPerMessage: 2`.

**Planner/executor model:** Architect is the sole planner — sets broad plans and assigns roles via multiple `[TASK]` tags per message. Other agents are executors: auto-claim, ship the deliverable in one message, move to the next open task. Heartbeat seed cooldown is 2 min.

## Architecture (read this before editing)

```
src/index.ts
  └─ src/slack/botRuntime.ts       five Bolt apps, shared SlackToolContext per turn
  └─ src/coordinator/              message routing, loop guards, budget skip
  └─ src/living/
       runtime.ts                   heartbeat + autonomous loop
       autonomousLoop.ts            adaptive cadence (fast while busy, idle backoff)
       taskQueue.ts, knowledgeBase.ts, budgetLedger.ts, auditor.ts, evolution.ts
  └─ src/providers/                mock, gemini, groq, openrouter, ollama
  └─ src/memory/                   SQLite context + daily call counters
```

**Data flow:** Human Slack message → ingress bot (`SLACK_INGRESS_AGENT_ID`, default `architect`) → coordinator picks responding agents → provider call → Slack post → living layer logs cost/tasks/knowledge.

**Autonomous mode:** `LIVING_HEARTBEAT=true` runs work cycles without human input. Cadence from `.env`:

- `LIVING_TICK_MIN_MS=750` — delay between cycles while agents are active
- `LIVING_TICK_MS=90000` — backoff when idle

**Env loading:** `src/config/env.ts` uses `dotenv.config({ override: true })` so `.env` wins over stale shell exports (important for tick timing).

## Key files to edit

| File | Purpose |
|---|---|
| `config/agents.yaml` | Personalities, providers, models, budget, coordination |
| `src/slack/slackTools.ts` | Channel create/join/post; resolves `#name` → channel ID |
| `src/coordinator/conversationCoordinator.ts` | Loop guards, prompts, budget enforcement |
| `src/living/runtime.ts` | Heartbeat seed, startup behavior |
| `src/living/autonomousLoop.ts` | Adaptive tick cadence |
| `src/providers/providerFactory.ts` | Per-provider min call spacing |
| `slack-app-manifest.yaml` | 33 bot scopes template for new/reinstall apps |
| `.env.example` | All env var names (no secrets) |

## Slack setup (PORGUS workspace)

Five **existing** apps (reinstalled with expanded scopes). Display names show as Architect/Auditor/etc. via `chat:write.customize`.

| Agent | Slack App ID |
|---|---|
| Architect | `A0BF1LJ0ZK8` |
| Auditor | `A0BFY1AUU3A` |
| Operator | `A0BF0CA5YA1` |
| Breeder | `A0BF7D5CGG4` |
| Chronicler | `A0BF1M7EUAJ` |

**Known Slack limitation:** workspace `@handles` are still legacy (`@ceo`, `@researcher`, `@engineer`, `@marketer`, `@critic`). Slack locks bot username at first install; reinstall does **not** change @mentions. Only creating **new** apps with correct usernames at creation fixes handles. Messages still post under correct display names.

**Manifest URL pattern (not api.slack.com):**

`https://app.slack.com/app-settings/T0BF5A50HG9/{APP_ID}/app-manifest`

**Reinstall:** App Home → Install App → reinstall to pick up scope changes. Tokens in `.env` stayed valid after last reinstall.

**Channel:** `SLACK_CHANNEL_ID=C0BEN1R3ZGF` — all five bots must be in this channel.

## Environment variables

Copy `.env.example` → `.env`. Required groups:

1. **15 Slack values** — bot token, app-level token (`connections:write`), signing secret × 5 agents
2. **Provider keys** — `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`
3. **Living** — `LIVING_HEARTBEAT`, `LIVING_TICK_MIN_MS`, `LIVING_TICK_MS`, `LIVING_SPEND_CEILING_USD`, `LIVING_MAX_HEADCOUNT`
4. **Optional** — `FALLBACK_TO_MOCK=true` for dev without all keys

## Commands

```bash
bun run dev              # watch mode, starts all bots + heartbeat
bun run test             # vitest
bun run typecheck
bun run check-providers  # verify API keys / Ollama
bun run check-agents     # config sanity
```

## Known issues / gotchas

1. **Agents silent** — check SQLite `daily_usage` vs `dailyRealCallLimit`; check provider quota (Gemini free tier exhausts fast — Architect moved to OpenRouter for this reason).
2. **Channel tool errors** — agents must pass `C…` IDs or resolvable names; `slackTools.ts` resolves and auto-joins. Same-turn context uses `activeChannelId` in `botRuntime.ts`.
3. **Conversation loops** — guarded by `maxConsecutiveAgentTurns`, heartbeat seed cooldown (~10 min), skip bare `"Done. T-000xx"` chain posts.
4. **`invite` tool** — needs Slack user IDs (`U…`), not `@names`.
5. **Shell env override** — if tick timing wrong, check `dotenv override` and restart dev server in clean shell.
6. **Browser OAuth** — Cursor IDE browser fails on Slack OAuth redirect; use Playwright MCP or manual reinstall for Slack app changes.
7. **Creating new Slack apps** — manifest UI on api.slack.com can 404; use app-settings URL above.

## Testing changes

After Slack or coordinator changes:

```bash
bun run test
bun run typecheck
# restart dev server and watch logs for "Autonomous loop enabled: 1.5s while busy..."
```

## Workspace conventions (Cursor)

- `.cursor/rules/caveman-self.mdc` — assistant replies in caveman compression unless user says "stop caveman"
- Commit only when user explicitly asks
- Use `gh` for GitHub PRs/issues
- Skills under `.agents/skills/` for caveman modes, commits, reviews

## Safe change patterns

- **Provider swap:** edit `config/agents.yaml` + update `.env` key; run `check-providers`. Hard rule 4: Breeder and Auditor must be on **different** models or the app throws at boot.
- **Speed/cadence:** `config/agents.yaml` coordination + `.env` tick vars + `providerFactory.ts` intervals
- **New Slack scope:** update `slack-app-manifest.yaml`, reinstall all 5 apps, verify tokens still work
- **Budget bump:** `config/agents.yaml` `budget.dailyRealCallLimit` and/or reset SQLite counter

## Out of scope unless user asks

- Committing or pushing
- Rotating or printing secrets in chat
- Force-push to `main`
- Creating five new Slack apps for @handle renames (large manual OAuth + `.env` migration)
