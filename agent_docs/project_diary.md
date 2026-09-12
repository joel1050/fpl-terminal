<!-- codex-workflow-bootstrap-template -->
# Project Diary

## 2026-09-09 — Backtest remeasurement

- A passing whole-corpus validator is not enough by itself. Keep small synthetic
  parity tests that cover historical and fallback priors, form and no-form paths,
  every position, and component-level output so a specific plumbing regression
  fails locally.
- Every `playerRates` backtest caller must pass the walk-forward strength snapshot.
  Omitting it silently exercises a different fallback-prior path from production
  for players without usable historical evidence.
- Backtest arm names must be derived from or checked against current production
  constants. The stale 0.9/24 form label and duplicate current-clamp arm made old
  measurements look like comparisons when they were not.
- Team-level Elo results answer two different questions. Elo combined with a
  widened strength level is rejected; Elo substituted at the shipped spread is
  unresolved. Preserve that distinction because the two scripts also construct
  their fixture base differently.
- FPL xG starts at gameweek 16 in 2022/23, so that season cannot choose form or
  conversion constants even when a later anchor produces rows.
- Selected minima from wide sweeps are exploratory. Require a consistent
  cross-season direction and a paired interval excluding zero before proposing
  a production constant.

During workflow deployments, the main agent updates this document directly.

Maintain a compact project-experience reference that prevents repeated mistakes.
Record only distinct decisions, discarded approaches, mistakes, and reusable
lessons that can affect future work. Consolidate repetition; preserve the
context, reason, outcome, and applicability of each lesson. Do not record
session chronology, releases, commits, routine maintenance, or raw logs.

## Decisions and Lessons

## 2026-09-10 — FDR sensitivity

- Integer and continuous ClubElo FDR both use divisor 150 by user choice; a
  more varied display or a preferred player ranking is not calibration evidence.
- For live-input experiments, verify the parameterized evaluator against actual
  production scoring components. Historical harness parity does not establish
  parity on the continuous FDR path.
- Inspect usable team-history coverage, not just file count: older GW1–2 xG
  snapshots lack opponent/venue fields, while GW3 has them. The presence of
  any complete fixture activates the joint fitter, so these inputs fit GW3
  only rather than falling back to an aggregate blend of all three rounds.
