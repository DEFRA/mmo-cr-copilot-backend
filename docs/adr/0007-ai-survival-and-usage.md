# 0007. AI code survival records and usage in the payload contract

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The churn and durability metrics (ADR 0005, D10) need to know what happened to AI-written lines
after a pull request merged. The VS Code attribution extension records which lines were AI-written;
only a scheduled job with the full git history can measure how many survived N days later. The
extension also records Copilot model and token usage per commit, which the dashboard shows.

## Decision

**Survival.** A scheduled GitHub workflow measures each merged pull request at 21 days and posts one
record per pull request and window to `POST /api/survival` (through the dashboard BFF). The record
holds counts only, no identities. `src/schemas/survival.js` is the contract: `kind: ai-survival`,
`schemaVersion: 1`, repository, `prNumber`, merge and measurement commits, `windowDays` (7, 14, 21
or 30), AI and human lines merged and surviving, the same by origin, up to 200 per-file counts, the
metadata schemas seen and `calculatedAt`. `surviving` can never exceed `merged`.

- Stored in `ai_survival`, upserted on the unique `(repository, prNumber, windowDays)` index, and
  replaced only by a record with a strictly newer `measuredAt`, so retries and late deliveries are
  safe. `projectSlug` is set from the repository mapping at ingest, like payloads.
- The route uses the same ingest token as `POST /api/payloads` and a 256 KB limit.
- `computeCodeChurn` returns CCR = `100 × (merged − surviving) / merged` over a project's records,
  per origin as well, with the discount `1 − CCR` when CCR is above 25 (rounded to one decimal).
  With no measured pull request it is unavailable and no discount applies.
  `codeDurability` in the AI-Native leverage response is derived from the same records.

**Usage.** `commitBreakdown[].attribution` accepts an optional `usage` object, only for
`source: extension`: up to 20 models with request and token counts, `sessions` and
`commitsWithUsage`. Counts only; unknown keys are stripped.

## Consequences

- The churn endpoint keeps its response field names and now returns real values.
- Lines moved to another file after merge count as not surviving (git blame is within a file).
- Usage covers only developers who opted in; consumers must show coverage beside it.
- No per-contributor aggregation of usage is offered.

## Alternatives considered

- **Compute survival in the extension** — needs every developer's machine and a network path.
- **Store per-line data in the backend** — more data than needed; the counts answer the question.
- **Append every measurement** — the latest measurement per window is the meaningful one.

## References

- [ADR 0001](0001-payload-contract-v2.md), [ADR 0005](0005-shift-left-dora-metric-model.md).
- `src/schemas/survival.js`, `src/services/survival.js`, `src/services/complexity.js`.
