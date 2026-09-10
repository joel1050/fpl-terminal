<!-- codex-workflow-bootstrap-template -->
# Project Progress

Deployment `backtest_remeasurement_20260909` completed on 2026-09-09.

## Goal

Remeasure the projection backtest suite after the harness parity fixes, add
synthetic component-level regression coverage, and replace stale README
verdicts with results from prepared 2022/23–2025/26 corpora.

## Overall Progress

- Added component parity coverage for every position plus fixture-sensitive
  bonus behavior.
- Corrected priority backtest callers to pass production team-strength context
  and corrected stale shipped-arm labels.
- Validated exact production parity on the legacy corpus and all four prepared
  seasons, then remeasured the requested team, conversion, xP, form, evidence,
  forward, bias, and player analyses.
- Updated `scripts/backtest/README.md` with the 2026-09-09 authoritative result
  matrix, flipped verdicts, corpus limits, and an explicit unverified marker for
  scripts not rerun.
- Production projection constants were not changed because no candidate met the
  cross-season direction and confidence requirements.

## Next Milestone

If further calibration work is requested, pre-register and rerun the isolated
Elo-at-shipped-scale arm and the reliability role model on independent seasons;
do not select constants from the exploratory sweep minima reported here.

## Current Position

## Next Milestone
