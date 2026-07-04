# Agent Company

Agent Company is an event-driven Slack network of configurable agents. Each agent has its own Slack bot identity, personality, role, **free-tier LLM provider**, and model. All five core agents use **caveman** compression to save tokens.

## What It Does

- Starts five Slack bots in one Bun process: Architect, Auditor, Operator, Breeder, and Chronicler.
- Watches a shared Slack channel for human messages.
- Lets agents reply in a guarded chain so they can talk to each other without running forever.
- Stores recent channel context and daily real-model usage in SQLite.
- Supports per-agent providers: `mock`, `gemini`, `groq`, `openrouter`, and `ollama`.
- Supports per-agent response compression: `normal` or `caveman`.
- Enforces a daily real-call limit from `config/agents.yaml` (200/day across all providers).

## Free-tier model map (current)

Each agent uses a **different free provider** so quotas do not all hit one API:

| Agent | Provider | Model | Get a key |
|---|---|---|---|
| Architect | OpenRouter | `openrouter/free` | [OpenRouter](https://openrouter.ai/keys) |
| Auditor | Groq | `llama-3.3-70b-versatile` | [Groq Console](https://console.groq.com/keys) |
| Operator | OpenRouter | `openrouter/free` | same OpenRouter key |
| Breeder | Groq | `llama-3.1-8b-instant` | same Groq key |
| Chronicler | Ollama | `llama3.2:3b` | [Ollama](https://ollama.com/download) — run `ollama pull llama3.2:3b` |

Architect moved off Gemini after free-tier daily quota exhaustion. `GEMINI_API_KEY` remains in `.env.example` if you switch back in `config/agents.yaml`.

Verify all providers:

```bash
bun run check-providers
```

Set `FALLBACK_TO_MOCK=true` in `.env` to run without all keys (dev only).

## Requirements

- Bun 1.3 or newer.
- Five Slack apps, one per agent, created from `slack-app-manifest.yaml`.
- Five Slack apps and the free provider keys below (or `FALLBACK_TO_MOCK=true` for partial setup).

Install dependencies:

```bash
bun install
```

## Slack App Setup

Create one Slack app per agent using `slack-app-manifest.yaml`.
The manifest grants the bots enough Slack access to read shared channel context, join and manage public channels, post as their configured agent name, write files, add reactions, and read basic user info.

1. Go to <https://api.slack.com/apps>.
2. Choose **Create New App**.
3. Choose **From an app manifest**.
4. Pick your workspace.
5. Paste the contents of `slack-app-manifest.yaml`.
6. Name the app for the agent, such as `Agent Company Architect`.
7. Install the app to your workspace.
8. Copy the app's **Bot User OAuth Token**, **App-Level Token** with `connections:write`, and **Signing Secret** into `.env`.
9. Repeat for Architect, Auditor, Operator, Breeder, and Chronicler.
10. Invite all five bots to the same Slack channel.

## Environment

Copy the template:

```bash
cp .env.example .env
```

Fill in the Slack values for each agent:

- `SLACK_ARCHITECT_BOT_TOKEN`, `SLACK_ARCHITECT_APP_TOKEN`, `SLACK_ARCHITECT_SIGNING_SECRET`
- `SLACK_AUDITOR_BOT_TOKEN`, `SLACK_AUDITOR_APP_TOKEN`, `SLACK_AUDITOR_SIGNING_SECRET`
- `SLACK_OPERATOR_BOT_TOKEN`, `SLACK_OPERATOR_APP_TOKEN`, `SLACK_OPERATOR_SIGNING_SECRET`
- `SLACK_BREEDER_BOT_TOKEN`, `SLACK_BREEDER_APP_TOKEN`, `SLACK_BREEDER_SIGNING_SECRET`
- `SLACK_CHRONICLER_BOT_TOKEN`, `SLACK_CHRONICLER_APP_TOKEN`, `SLACK_CHRONICLER_SIGNING_SECRET`

Free provider keys (see table above):

- `OPENROUTER_API_KEY` — Architect + Operator
- `GROQ_API_KEY` — Auditor + Breeder
- `OLLAMA_BASE_URL` — Chronicler (default `http://localhost:11434`)
- `GEMINI_API_KEY` — optional if you set an agent back to Gemini

Rate limiting: `LLM_MIN_INTERVAL_MS=13000` protects Gemini's 5 RPM cap when used; Groq/OpenRouter/Ollama use faster per-provider limits in `src/providers/providerFactory.ts`.

Autonomous cadence (when `LIVING_HEARTBEAT=true`):

- `LIVING_TICK_MIN_MS=1500` — seconds-scale group chat while agents are active
- `LIVING_TICK_MS=90000` — backoff when idle

## Editing Agents

Edit `config/agents.yaml`.

Each agent has:

- `personality`: how the agent behaves.
- `role`: what the agent is responsible for.
- `provider`: `mock`, `gemini`, `groq`, `openrouter`, or `ollama`.
- `model`: the model name for that provider.
- `compressionStyle`: `caveman` for short token-saving replies, or `normal`.
- `respondsWhen`: `always`, `mentioned`, or `mentioned-or-relevant`.
- `cooldownMs`: minimum time before the same agent replies again.
- `relevanceKeywords`: cheap keyword triggers that do not use an API call.

All agents default to `compressionStyle: caveman`. Real models get shorter max output (350 tokens) automatically.

## Budget Controls

In `config/agents.yaml`:

- `budget.dailyRealCallLimit`: maximum real model calls per day across all agents (default 200).
- `coordination.maxConsecutiveAgentTurns`: stops agent-to-agent loops until a human speaks again (default 5).
- `coordination.maxResponsesPerMessage`: caps how many agents answer one message.
- `coordination.responseDelayMs`: delay between Slack replies (default 0 for fast cadence).
- `defaults.cooldownMs`: minimum time before the same agent replies again (default 400).

Spread agents across providers (see free-tier table) so one API's daily cap does not stop the whole company.

## The Living Company Framework

The five agents operate on top of a role-permanent orchestration layer in `src/living/`. Agents never depend on each other directly; everything flows through three shared structures so agents can be replaced without breaking the roster.

- **Task Queue** (`taskQueue.ts`): every unit of work is a `Task` with a mandatory budget cap. Nothing runs without a cap, and runaway costs are killed at the cap. Statuses: `open · claimed · done · failed · vetoed`.
- **Knowledge Base** (`knowledgeBase.ts`): an append-only raw log (never edited) plus a Chronicler-maintained curated layer (`strategy`, `protocol`, `lesson`, `do-not-repeat`) injected into agent context under a hard token budget.
- **Budget Ledger** (`budgetLedger.ts`): every cost and revenue event is recorded. Trailing-30-day coverage ratio drives the Operator's three modes — **deficit** (<70%), **balance** (70–110%), **surplus** (>110%). Deficit mode freezes experimentation and zeroes shadow budgets.

Evolution and measurement:

- **Auditor** (`auditor.ts`): scores every result (numbers first), publishes a rolling scoreboard, flags the weakest agent, and only clears a candidate that beats the incumbent by ≥15% score-per-dollar over ≥20 identical tasks. Includes calibration error.
- **EvolutionEngine** (`evolution.ts`): draft → shadow → verdict → swap with archival and automatic rollback if a new agent underperforms the archived incumbent within the rollback window (≥3 cycles).

Hard rules (`hardRules.ts`) live in code, outside any agent's reach:

1. Human spend ceiling (`LIVING_SPEND_CEILING_USD`) — only the human can raise it.
2. Kill switch — `Ctrl+C`/`SIGTERM` halts all agent execution.
3. Auditor replacement always requires human approval.
4. Breeder and Auditor must run on different base models (`mock` is exempt).
5. Append-only raw log.
6. Firing is archival, not deletion, with a rollback window.
7. Measurement and memory (Auditor, Chronicler) are never defunded.

Everything is persisted in the same SQLite database and covered by unit tests in `tests/living/`.

### Headcount growth (adding more bots)

The company starts with 5 core agents. It can grow when needed:

- **Human ceiling:** `LIVING_MAX_HEADCOUNT` in `.env` (default 10) — only you raise this.
- **Active slots:** start at 5; Breeder can propose `[PROPOSAL] kind=headcount slots=1 reason=...`
- **Auto-approve:** in **surplus mode**, +1 slot auto-approves if under the human max.
- **Human override:** post `approve headcount` or `approve headcount P-abc123` in Slack.
- **New agent:** after a slot opens, Breeder posts `[PROPOSAL] kind=agent id=researcher display=Researcher role="..." personality="..." reason=...`
- **Human confirms:** post `approve agent P-abc123`
- Dynamic agents without Slack tokens post via Chronicler proxy until you add `SLACK_RESEARCHER_BOT_TOKEN` etc.

### What actually runs on every Slack message

- Human goals → auto-task routed to the best role (or explicit `[TASK]` tags)
- Every agent reply → cost logged to ledger, protocol tags executed
- Claimed tasks → auto-completed when agent replies
- Auditor → scores done tasks
- Operator → updates mode in curated knowledge
- Chronicler → distills goals and do-not-repeat lessons
- Breeder → proposes headcount when slots are full

## Run

```bash
bun run dev
```

Then post in the shared Slack channel. The Architect starts by default, and the agents continue in a guarded chain. On startup the process prints the current Living Company mode, spend ceiling, and roster.

## Test

```bash
bun run test
```

## Hand off to another AI agent

For Claude Code, Cursor, or any coding agent picking up this repo:

1. Read **[`CLAUDE.md`](./CLAUDE.md)** — architecture, Slack app IDs, known issues, env vars, branch state.
2. Copy **[`.env.example`](./.env.example)** → `.env` and fill secrets (never commit `.env`).
3. Run `bun run check-providers` then `bun run dev`.
4. Work on branch **`cursor/living-company-multi-provider`** (or merge to `main` first).

**Slack note:** bot display names (Architect, Auditor, …) differ from legacy workspace `@handles` (`@ceo`, `@researcher`, …). Reinstall does not change @handles; see `CLAUDE.md` for details.

Cursor also loads **[`AGENTS.md`](./AGENTS.md)** and **`.cursor/rules/agent-company.mdc`** for short project context.

## Project Structure

- `config/agents.yaml`: agent personalities, providers, models, and guardrails.
- `src/agents/`: config loading and defaults.
- `src/coordinator/`: event-driven routing and loop control.
- `src/memory/`: SQLite memory and daily budget storage.
- `src/providers/`: mock, Gemini, Groq/OpenRouter, and Ollama provider adapters.
- `src/slack/`: multi-bot Slack runtime.
- `src/living/`: the Living Company framework — task queue, knowledge base, budget ledger, auditor, evolution engine, and hard rules.
- `tests/`: unit tests for config, providers, coordinator guardrails, and every Living Company module.
