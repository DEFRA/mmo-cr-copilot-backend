# 0004. PR complexity model and Leverage methods

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

The current Copilot Leverage index compares pull requests against any manually-led PR in history,
with no adoption date and no allowance for size. A sprint of small PRs can therefore look like a
productivity gain. DORA warns against comparing work of very different size or context.

Two project types need different answers:

- **AI-Adopted** projects have a pre-Copilot history. A 6-month backfill gives a baseline, but
  current PRs must only be compared with equivalent historic PRs.
- **AI-Native** projects have no pre-AI history, and adoption is close to 100% by design, so a
  before-and-after comparison is meaningless.

Size evidence: Google's engineering practices treat about 100 changed lines as reasonable and about
1,000 as usually too large, and note that spread across many files adds to size. SmartBear's Cisco
study found review effectiveness drops beyond 200–400 lines.

## Decision

Accepted. The v1 caps below are the defaults; each project may override them (E6-S7), and every
change creates a new model version.

**Complexity score (model v1, versioned and configurable per project):**

- Inputs, excluding generated files, lockfiles, vendored code and snapshots: `L` non-test lines
  added plus deleted, `F` non-test files changed, `M` modules touched. Taken from the payload `files`
  block (ADR 0001).
- `s(x, cap) = min(1, ln(1 + x) / ln(1 + cap))`
- `score = round(1 + 99 × (0.5·s(L, 400) + 0.3·s(F, 25) + 0.2·s(M, 5)))`
- Hard cap: `L > 400` or `F > 50` gives 100.
- Bands: XS 1–20 · S 21–40 · M 41–60 · L 61–80 · XL 81–100.
- Test changes add no complexity; the test-change ratio is reported separately.
- The model version is stored on every score, so scores can be recomputed. Each change to caps or
  weights creates a new version.

**Copilot Leverage v2 (AI-Adopted only):**

- Baseline = PRs merged before the project's `adoptionStartDate`; adopted = after.
- Compare within each band on median PR cycle time, review wait, PR rework ratio and new SonarCloud
  issues per 100 lines; add ticket cycle time once Jira lands.
- Combine bands by **direct standardisation** on the current period's band mix.
- A band needs at least 5 PRs on each side; otherwise show "Not enough comparable pull requests".

**AI-Native Delivery Leverage:**

- Own-baseline trend: the project's first N completed sprints (default 3) form its baseline, compared
  with the same band standardisation.
- Complexity-weighted throughput: the sum of complexity scores of PRs linked to tickets delivered in
  the sprint.
- Delivery quality: change fail rate, delivery rework rate, reopen rate and new SonarCloud issues per
  100 lines, read together.
- AI code durability, once line-level attribution exists.

## Consequences

- Leverage becomes like-for-like and can no longer be gamed by small PRs.
- Scores must be computed server-side at ingest, with an admin-triggered recompute job.
- Backfilled history is required before Leverage v2 has a baseline.
- SOLID and DRY cannot be measured from diff statistics; the size and spread thresholds encode their
  intent only.

## Alternatives considered

- **Keep the current index** — not like-for-like and has no adoption date.
- **Lines changed alone** — ignores spread across files and modules.
- **Compare AI-Native projects with AI-Adopted baselines** — different applications; at most an
  indicative portfolio reference.

## Open points

Resolved:

- v1 caps accepted as the per-project defaults (`DEFAULT_COMPLEXITY_MODEL`).
- AI-Native Delivery Leverage is shown as 4 components side by side (ADR 0005 §4).
- AI-Native own baseline: the first 3 sprints of activity; 5 PRs needed on each side.
- The AI-Native method is recorded in ADR 0005 rather than a separate ADR.

Still open:

- Whether SonarCloud duplication and cognitive complexity on new code become v2 inputs.

## References

- DORA — software delivery metrics — https://dora.dev/guides/dora-metrics/
- SPACE framework — https://queue.acm.org/detail.cfm?id=3454124
- Google engineering practices, small CLs —
  https://google.github.io/eng-practices/review/developer/small-cls.html
- SmartBear, code review best practices —
  https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/
- SonarQube Cloud Web API — https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/web-api/
