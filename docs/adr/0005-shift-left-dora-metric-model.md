# 0005. Shift-Left DORA metric model and Delivery Quadrant

- **Status:** Accepted
- **Date:** 2026-10-15 (accepted 2026-10-19)

## Context

The adoption of generative AI coding assistants (such as GitHub Copilot) accelerates code synthesis
and pull request authoring. However, raw volume is not delivery value. Measuring engineering
productivity using raw lines of code (LOC) is fundamentally flawed:

- **Goodhart's Law:** "When a measure becomes a target, it ceases to be a good measure." Rewarding
  raw line counts incentivises bloated code generation, massive diffs, and prompt dumping.
- **Dijkstra's principle:** "Measuring programming progress by lines of code is like measuring
  aircraft building progress by weight." Value lies in concise, maintainable abstractions, not code
  mass.
- **GitClear empirical findings:** GitClear's 2024 longitudinal study ("Coding on Copilot") reveals
  that generative AI code generation drives downward pressure on code maintainability, causing a
  surge in code duplication, copy-pasting, churn, and rapid line replacements within 2 to 3 weeks of
  merging.

Furthermore, traditional operational DORA metrics (Deployment Frequency, Lead Time for Changes,
Change Failure Rate, and Time to Restore Service) are lagging indicators measured downstream in
production pipelines. In platform and enterprise environments, production deployments are frequently
gated by Change Advisory Boards (CABs), platform maintenance windows, security audits, and release
train cadences that are decoupled from daily engineering velocity.

Engineering teams require **Shift-Left DORA leading indicators** evaluated at the pull request and
user story boundary, grounded in ACM SPACE (Activity $\times$ Performance) and Sonar Clean as You
Code (CaYC).

## Decision

**Adopt the Shift-Left DORA 4-Metric Delivery Quadrant** to evaluate delivery speed, efficiency,
code integrity, and stability at the Jira story and PR boundary.

### 1. Shift-Left DORA Translation Matrix

| Lagging Operational DORA Metric    | Shift-Left DORA Leading Indicator                         | Rationale & Scope                                                                                                                                               |
| :--------------------------------- | :-------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deployment Frequency (DF)**      | **Standard Deployable Units (SDUs)**                      | Count of user stories reaching Done with a passing SonarCloud Quality Gate, representing release-ready increments independent of production release scheduling. |
| **Lead Time for Changes (LTTC)**   | **Ticket Lead Time & PR Cycle Time**                      | Developer-controlled elapsed time from first commit on linked PRs to ticket Done, removing downstream staging and deployment queue latency.                     |
| **Change Failure Rate (CFR)**      | **First-Scan Pass Rate & 21-Day Code Churn ($CCR_{21}$)** | Evaluates pre-merge quality regressions and rapid post-merge code churn within team agency prior to production deployment.                                      |
| **Time to Restore Service (TTRS)** | **Defect Recovery Time**                                  | Elapsed time from bug creation to Done for regressions identified against delivered work.                                                                       |

### 2. The 4-Metric Delivery Quadrant

The quadrant balances delivery velocity with rigorous quality gating and durability guards:

```text
               Speed                               Efficiency
    +---------------------------+       +---------------------------+
    |           QANT            |       |    V_SP  &  QANT_comp     |
    | (Quality-Adjusted Net     |       | (Dual Efficiency          |
    |  Throughput in eLOC/day)  |       |  Normalisation)           |
    +---------------------------+       +---------------------------+
                  ^                                   ^
                  |                                   |
    +---------------------------+       +---------------------------+
    |         Q_Sonar           |       |          CCR_21           |
    | (SonarCloud Quality       |       | (21-Day AI Code Churn     |
    |  Multiplier & First-Scan) |       |  Rate & Churn Penalty)    |
    +---------------------------+       +---------------------------+
           Code Integrity                      Rework / Stability
```

#### Axis 1: Speed — Quality-Adjusted Net Throughput (QANT)

Measures effective high-quality delivery speed in quality-adjusted equivalent lines of code per day:

$$QANT = \frac{\sum_{s \in S} (NLOC_s \times Q_{Sonar,s})}{\sum_{s \in S} CycleTime_s} \quad [\text{Quality eLOC / Day}]$$

Where:

- $S$: Set of stories reaching status category Done in the analysis window.
- $CycleTime_s$: Ticket cycle time in days (first In Progress transition to Done).
- $NLOC_s$: Net Lines of Code per story:
  $$NLOC_s = \max(0, \text{linesAdded}_s - \text{linesDeleted}_s)$$
  - PR line splitting: When a PR links to $k$ stories, lines are allocated proportionally ($1/k$ by
    default). When a story links to $m$ PRs, lines are summed across linked PRs.
  - Refactoring guard: Cleanup and refactoring stories with net negative lines are clamped to 0 for
    volume calculations and tracked separately as technical debt reduction.
  - Diff exclusions: Excludes test files, generated code, lockfiles, vendored code, and snapshots
    (Section 2.9 of metrics definition).

#### Axis 2: Efficiency — Dual Efficiency Normalisation ($V_{SP}$ and $QANT_{comp}$)

Story points alone suffer from estimation drift and subjectivity across teams. Dual normalisation
evaluates efficiency across both human estimation and algorithmic diff complexity:

1. **Story Point Normalized Velocity ($V_{SP}$):**
   $$V_{SP} = \frac{\sum_{s \in S} (NLOC_s \times Q_{Sonar,s})}{\sum_{s \in S} StoryPoints_s} \quad [\text{Quality eLOC / Story Point}]$$
   Story points are ingested from a project-configurable Jira custom field ID (e.g.
   `jira.storyPointsField = "customfield_10016"`).
2. **Complexity-Normalised QANT ($QANT_{comp}$):**
   $$QANT_{comp} = \frac{\sum_{s \in S} \left( \frac{NLOC_s \times Q_{Sonar,s}}{\text{complexityScore}_s} \right)}{\sum_{s \in S} CycleTime_s}$$
   Uses the objective PR complexity score (1–100, ADR 0004) based on diff size, file spread, and
   module distribution to benchmark velocity against technical difficulty.

#### Axis 3: Code Integrity — SonarCloud Quality Multiplier ($Q_{Sonar,s}$)

Evaluates clean code standards on new code at merge time. $Q_{Sonar,s}$ acts as a composite
discount factor:

$$Q_{Sonar,s} = QG_s \times (1 - TDR_s) \times \left(1 - \frac{D_s}{100}\right) \times \left(1 - \min\left(1.0, \frac{\text{Blocker+High}_s}{KLOC_s \times 5}\right)\right)$$

Where:

- $QG_s$: Quality Gate status on new code. $1.0$ if Passed (`OK`), $0.2$ if Failed (`ERROR`).
  Failing code is heavily discounted by 80% rather than zeroed, preserving volume diagnostics while
  severely penalising broken code.
- $TDR_s$: Technical Debt Ratio on new code (`new_sqale_debt_ratio`), clamped to $[0, 1.0]$.
- $D_s$: Duplicated lines density percentage on new code (`new_duplicated_lines_density`).
- $\text{Blocker+High}_s$: Count of severe Clean as You Code issues:
  `new_software_quality_blocker_issues` + `new_software_quality_high_issues`.
- $KLOC_s$: Non-test lines added in thousands ($\text{linesAdded}_s / 1000$).
- Defect density cap: $\frac{\text{Blocker+High}_s}{KLOC_s \times 5}$ is clamped to $[0, 1.0]$ via
  $\min(1.0, \dots)$, preventing negative multipliers when defect density exceeds 5 issues per KLOC.
- **Zero lines guard:** If $KLOC_s = 0$ (e.g. documentation, metadata, or pure deletion tickets), the
  defect density term evaluates to $1.0$ (no division-by-zero penalty).
- **Missing SonarCloud data guard:** If SonarCloud data is missing, unconfigured, or unscanned for a
  story's PRs, the story is flagged as unverified and excluded from QANT.
- **Pre-Merge First-Scan Quality Pass Rate:**
  $$\text{First-Scan Pass Rate} = \frac{\text{Stories passing Sonar Quality Gate on 1st scan}}{\text{Total stories shipped}} \times 100$$
  Leading indicator for Change Failure Rate, verifying that developers resolve quality issues locally
  before opening PRs.

#### Axis 4: Rework & Stability — 21-Day AI Code Churn Rate ($CCR_{21}$)

Tracks whether code delivered into the main branch remains durable or undergoes rapid rewriting:

$$CCR_N = \frac{\text{Lines rewritten or deleted within } N \text{ days of commit}}{\text{Total lines added}} \times 100$$

- Observation window $N = 21$ days (configurable per project; covers 1.5 standard sprints).
- **Churn penalty rule:** When $CCR_{21} > 25\%$, the story's delivered volume is discounted by the
  churn factor:
  $$\text{Effective } NLOC_s = NLOC_s \times (1 - CCR_{21})$$
  Ensures that hallucinated, thrown-away, or ill-fitting AI code is not counted as productive
  output.

### 3. Data Ingestion & Storage Requirements

To support the Delivery Quadrant, the backend requires:

1. **SonarCloud Snapshot Store (`sonar-snapshots` collection, E4):**
   Stores point-in-time metrics captured at PR merge and sprint cut-off:
   `alert_status`, `new_sqale_debt_ratio`, `new_duplicated_lines_density`,
   `new_software_quality_blocker_issues`, `new_software_quality_high_issues`, and first-scan gate
   history.
2. **Jira Story Points Config (E5):**
   Configurable `jira.storyPointsField` in project configuration (e.g. `customfield_10016`).
3. **Many-to-Many PR-to-Story Linking (E5):**
   Bidirectional link mapping between Jira ticket keys and merged PRs, with proportional diff line
   attribution.

### 4. AI-Native projects (decisions D15, D16)

- **Metrics not shown for AI-Native projects:** Copilot adoption, adopter count, commit and
  line assist rates; the assist-rate donut, assist trend and contributor × repository assist
  heatmap; the persona adoption radar and adoption gauge; commit classification and
  re-classification; and Copilot Leverage v2. Adoption is close to 100% by design, so these
  carry no signal. Every other metric in the catalogue applies.
- **AI-Native Delivery Leverage is shown as four components side by side** — own-baseline
  trend, complexity-weighted throughput, delivery quality and AI code durability — never
  combined into one number, so a weak component cannot be hidden by a strong one.
- **AI line share is still collected** for AI-Native projects. It is never shown as an
  adoption metric; it feeds only AI code durability.

## Consequences

- Prevents artificial volume inflation from generative AI tools by discounting low-quality or
  high-churn deliverables.
- Provides teams with immediate, actionable leading delivery metrics without waiting for downstream
  production releases.
- Requires project onboarding to configure Jira story point field IDs and SonarCloud project keys.
- Requires snapshotting SonarCloud PR analyses before SonarCloud purges inactive branches.

## Alternatives considered

- **Raw Lines of Code:** Rejected due to Goodhart's law and susceptibility to AI boilerplate dumping.
- **Lagging Production DORA alone:** Rejected because deployment cadences, CAB gates, and staging
  queues mask true software development speed and provide sluggish feedback.
- **Unweighted Story Point Velocity:** Rejected because story point scales vary between teams, drift
  over time, and ignore code quality and defect injection.

## References

- DORA — [DORA Research & State of DevOps Reports](https://dora.dev/research/)
- Forsgren, N. et al. — [The SPACE of Developer Productivity (ACM Queue 2021)](https://queue.acm.org/detail.cfm?id=3454124)
- GitClear — [Coding on Copilot: 2024 Data Shows Downward Pressure on Code Quality](https://www.gitclear.com/coding_on_copilot_data_shows_downward_pressure_on_code_quality)
- SonarSource — [Clean as You Code Methodology](https://docs.sonarsource.com/sonarqube-server/latest/user-guide/clean-as-you-code/)
- Dijkstra, E. W. — [The Humble Programmer (EWD340)](https://www.cs.utexas.edu/~EWD/transcriptions/EWD03xx/EWD340.html)
