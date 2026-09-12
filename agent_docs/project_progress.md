# Project Progress

Deployment `fdr_sensitivity_20260910` is complete.

## Goal and Scope

Continuous and integer ClubElo FDR now both use divisor 150. Other model
changes remain hypothetical. Compare fixed GW4 projections for Fernandes,
Mbeumo, Tavernier, Rogers, and Palmer, ranking desired-direction counts first
and net signed xP movement second.

## Current Position

The production change passes focused and full unit tests, typechecking, build,
and focused lint. The experiment evaluates 24 isolated variants with exact
baseline component parity for the five targets. Independent verification reproduced the baseline, checked all ranked deltas,
and matched the 19 recorded input hashes.

## Next Milestone

Review the ranked report in `scripts/experiments/fdr-sensitivity-gw4.md`.
Team prior weight 12→24 was the only 5/5 directional match; it remains
hypothetical. No further model change is authorized for production.

## Calibration Evidence

`scripts/backtest/README.md` retains the 2026-09-09 cross-season remeasurement.
The sensitivity report cannot establish predictive accuracy. Saved GW1–2 team
xG rows lack opponent/venue fields; the current joint fit uses GW3 only, which
limits interpretation of team-form variants.
