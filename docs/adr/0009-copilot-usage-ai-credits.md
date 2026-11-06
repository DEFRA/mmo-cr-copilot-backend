# 0009. Copilot usage in AI credits

- **Status:** Accepted
- **Date:** 2026-11-05

## Context

GitHub bills Copilot in AI credits, priced per model and per token type (uncached input, cached
input, cache writes and output). Token totals cannot be compared across models, so the dashboard
shows credits only. From version 0.5.0 the VS Code attribution extension records credits per model
in each commit's summary, priced from Copilot's own per-model prices. It also splits a Copilot
request that edited several repositories equally between them, so a commit can carry a share of a
request. ADR 0007 accepted only whole-number request counts and no credits.

## Decision

`commitBreakdown[].attribution.usage.models[]` (payload contract v2, `source: extension` only)
changes additively:

- `credits` — optional number, 0 to 1,000,000,000, up to 4 decimals: the GitHub AI credits the
  extension recorded for that model in the commit. Absent means not recorded (an earlier extension,
  or a model without a known price). It is never derived from tokens here or in the dashboard.
- `requests` — any number from 0, up to 2 decimals, because a shared request counts as a share.
- Token counts are unchanged and still stored, but are not shown.

The producer (`mmo-cr-devops-common`) carries `credits` through, summed per model, and leaves it out
for a model with any unpriced usage. The dashboard reads credits from the payload feed.

## Consequences

- Payloads stored before this change have no credits; the dashboard reports them as not recorded
  and shows how many pull requests carry credits.
- Credits are list-price credits as the extension saw them. Plan discounts are not applied, and no
  currency value is derived.
- A producer that still sends whole-number requests and no credits remains valid.

## Alternatives considered

- **Price tokens in the backend** — needs a dated price table to be maintained here and would
  disagree with what the developer's machine recorded; rejected.
- **Drop token fields from the contract** — loses data the extension already provides; kept for
  future use.

## References

- [ADR 0007](0007-ai-survival-and-usage.md).
- [Models and pricing for GitHub Copilot](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).
- `src/schemas/payload.js`.
