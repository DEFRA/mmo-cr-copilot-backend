# 0006. Local SonarCloud snapshot fallback

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

The dashboard shows SonarCloud quality per repository and, for a past period, as it stood at the
end of that period. Locally there is usually no SonarCloud connection, so the Sonar panels are
hidden and the "frozen per sprint" behaviour cannot be shown or tested by hand. The seed script
already writes Sonar snapshots per sprint end to the `sonar-snapshots` and `sonar-pr-snapshots`
collections.

## Decision

Add a convict flag `sonar.snapshotFallback` (env `SONAR_SNAPSHOT_FALLBACK`, default `false`). When
it is on, the `sonar` plugin serves the stored
snapshots through `createSonarSnapshotReader` with the same shape as the live client:

- the overview, repository and PR reads return the newest snapshot with `asOf` at or before the
  requested cut-off;
- `asOf` is echoed only for a past period, so the live view looks like a live read;
- only repositories that have a `sonarProjectKey` are reported as linked.

The flag is allowed only when `cdpEnvironment` is `local`; config validation throws otherwise. The
`npm run dev` script turns it on. The plugin logs that the fallback is on at startup.

## Consequences

- The seeded Sonar history (pass, warning and fail by sprint) is visible locally without a token.
- A deployed service cannot serve stored data as if it were live SonarCloud data.
- Code that reads Sonar data must keep to the shared client shape, now with two implementations.

## Alternatives considered

- **Mock SonarCloud HTTP server** — more moving parts and a second copy of the data shape.
- **Dashboard-side fixtures** — would bypass the backend and the `asOf` logic being demonstrated.
- **Turning it on through `.env`** — `.env` is not committed, so every developer would need to
  set it; the dev script is explicit and reviewable.

## References

- [ADR 0003](0003-jira-cloud-integration.md) and [ADR 0005](0005-shift-left-dora-metric-model.md)
  for the quality-at-sprint-end metrics this data feeds.
- `src/config.js` (`sonar.snapshotFallback` and the non-local guard) and
  `src/services/sonar-snapshots.js`.
