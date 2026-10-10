# Review and verification of the multiplier experiment

Keep production formulas unchanged. The selected combined curve does not establish an integrated xP gain, and its conceded-xG RMSE and player-xP MAE worsen. The gap-only raw-Elo diagnostic at regularization 0.1 resolves a small attacking-xG improvement, but no final arm resolves a total-xP RMSE improvement. An attack-only follow-up with defence held at production is worth testing; this experiment does not justify implementing it.

The final forecast-starter slice contains 7,519 player-GWs. Selected-model xP RMSE changes from 3.09352 to 3.09414, with a paired difference interval of [-0.00155, +0.00288], so the overall result is not explained solely by the many explicit DNPs.

## Additional replay limit

The historical team-strength replay includes every earlier fixture, including both fixtures of double gameweeks (`scripts/backtest/season.ts`, `strengthsBefore`). The live input loader excludes doubled teams because event-level xG cannot be split into fixtures (`lib/historical/loadInSeasonForm.ts`). All experimental arms share the historical inputs, and the copied projection pipeline matches production exactly on those inputs, but this does not establish parity with the live ingestion path. Historical availability and prices are also reconstructed, as the generated report explains.

## Post-run type maintenance

The original scored runner is archived at `output/attackdefensemult-testing/frozen-source/attackdefensemult-testing.ts.txt`. After scoring, four explicit `any` types in report formatting were replaced with report interfaces and erased casts. TypeScript transpilation verifies byte-for-byte identical emitted JavaScript; hashes are in `output/attackdefensemult-testing/post-run-type-maintenance.json`. The original frozen protocol and scored metrics remain intact. For a fresh run, execute the report's `freeze` command before `run`, preferably with a separate `ATTACKDEFENSEMULT_OUTPUT_DIR` to preserve the original artifacts.

## Checks

- Focused experiment tests: 7 passed.
- Full unit suite: 108 files and 884 tests passed.
- Focused experiment lint: passed with four unused-variable/import warnings.
- Full repository lint: failed because it traverses nested `.claude/worktrees` and their generated build files, plus unrelated explicit `any` types in `tier-b-price-priors.ts`; no experiment lint errors remain.
- Typecheck: an unrelated error remains in `tests/core/tier-b-milp-cash.test.ts:90` (`actual` is not a property of `HistoricalForecastRow`).
- Browser tests: the sandbox denied binding the dev server to port 3000 (`EPERM`).
- Production build: Google Fonts downloads failed for Geist and IBM Plex Mono.
- Production calculation files match the original five recorded SHA-256 hashes, and the production folders have no diff.
