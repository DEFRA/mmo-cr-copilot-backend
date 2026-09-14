# AGENTS.md — mmo-cr-copilot-backend

Backend for the Copilot analytics dashboard. Ingests pull request analytics payloads from GitHub
Actions (via the dashboard frontend), persists them to MongoDB, and serves them back alongside
SonarCloud code quality metrics. It is internal to the platform — no browser traffic, no public route.

## Setup

```bash
nvm use
npm install
docker compose up -d mongodb   # MongoDB on :27017
npm run dev                    # service on :3001
```

## Commands

| Command                  | Purpose                                         |
| :----------------------- | :---------------------------------------------- |
| `npm run dev`            | Run with watch mode                             |
| `npm test`               | vitest with coverage — must pass                |
| `npm run lint`           | eslint (neostandard) — must pass                |
| `npm run format:check`   | prettier — must pass                            |
| `npm run format`         | Fix formatting                                  |
| `npm run security-audit` | `npm audit --audit-level=critical` — runs in CI |

CI runs `npm ci && npm run format:check && npm run lint && npm test`, then builds the root
`Dockerfile` with `DEFRA/cdp-build-action`. Do not rename these scripts.

## Layout

| Path            | Contains                                                |
| :-------------- | :------------------------------------------------------ |
| `src/config.js` | convict schema — the only place `process.env` is read   |
| `src/plugins/`  | Hapi plugins (mongodb, sonar, router, logging, tracing) |
| `src/routes/`   | Route definitions — thin handlers                       |
| `src/services/` | Business logic and data access                          |
| `src/schemas/`  | joi schemas for external contracts                      |
| `src/common/`   | Cross-cutting helpers                                   |
| `test-helpers/` | Fixtures shared by tests, excluded from coverage        |

Import with `#/` (→ `src/`) and `#/test-helpers/` (→ `test-helpers/`).

## Conventions

- Node >= 24, ES modules only. No TypeScript.
- No semicolons, single quotes, no trailing commas (prettier).
- All configuration through convict; secrets marked `sensitive: true`, never committed.
- Structured logging through `request.logger` / `server.logger`; never `console.*`.
- joi validation on every route that accepts input; handlers assume valid input.
- Optional integrations (SonarCloud) degrade gracefully and never block startup.
- Outbound calls to third parties use `createProxyDispatcher()`; internal services are called direct.
- Payloads are append-only — history per pull request is retained.
- Tests live beside the code as `*.test.js`.

## Detailed guidance

`.github/copilot-instructions.md` is the entry point. It carries the DEFRA **standards precedence**,
the **mandatory DEFRA constraints**, and the **working framework** (§3) that every agent follows —
triage into Trivial / Standard / Complex, then Read → Research → Clarify → Plan → Approval →
Implement → Test → Iterate → Summarise. Code review is optional and on-request only.

It links the instruction files (`.github/instructions/`), the skills (`.github/skills/`), and the
agents (`.github/agents/`): **Backend Orchestrator** (coordinates, owns the approval gate),
**Backend Planner** (plans + the single research pass), **Backend Developer** (implements and
tests), and **Backend Code Reviewer** (optional read-only review).

## Related repositories

- [mmo-cr-copilot-dashboard](https://github.com/DEFRA/mmo-cr-copilot-dashboard) — the only client.
  Changing the payload contract or an API response shape requires a matching change there.
