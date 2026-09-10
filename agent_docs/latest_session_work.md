<!-- codex-workflow-bootstrap-template -->
# Latest Session Work

Deployment `backtest_remeasurement_20260909` completed on 2026-09-09.

## Detailed Current State

The backtest harness reproduces `projectPlayer()` to 0.0e+0 on the legacy
2025/26 corpus and the prepared 2022/23, 2023/24, 2024/25, and 2025/26 corpora.
The new synthetic suite covers four position/evidence combinations and an easy
versus hard fixture bonus assertion. Negative controls proved that reverting the
historical xG fix breaks DEF/MID goal parity and reverting bonus fixture scaling
breaks parity and bonus direction.

The authoritative numerical conclusions and corpus labels are in
`scripts/backtest/README.md`. No production constants changed. The main flips are
that forward fixture swing is too steep, not too flat, in all three full seasons;
defensive-contribution dispersion has no stable cross-season optimum; and Elo is
unresolved when tested at shipped scale even though Elo plus a widened strength
level is rejected.

## Session Changes

- Added `tests/core/backtest-parity.test.ts`.
- Updated seven priority backtest scripts to supply team strengths to
  `playerRates`, corrected the `run.ts` old-clamp comparison, and made shipped
  labels match current constants and behavior.
- Rewrote the top of `scripts/backtest/README.md` as the authoritative
  remeasurement report while retaining older findings as explicitly unverified
  history.

## Verification

- `npm test`: 74 files, 600 tests passed.
- `npm run typecheck`: passed.
- Focused ESLint on every changed TypeScript file: passed.
- `npm run lint`: blocked by 812 errors in pre-existing generated files under
  `.claude/worktrees/**/.next`; no deployment file appears in the failure set.
- `git diff --check`: passed.

## Verification

## Pending Work and Blockers

## Next Entry Point
