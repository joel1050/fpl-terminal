# Tier C: Beam-search utility discounts

**Decision:** keep production unchanged. Shipped utility gained 1.326 actual points per gameweek over raw xP across the two held-out splits, but the paired 95% interval includes zero and the season results disagree; the fitted λ=0.5 arm also did not beat shipped utility reliably.

## Design and parity gate

Run at HEAD `74ceff274962102b5d774043b29783b22be13d75`. The shipped arm used `optimizeFullSquad` with horizon 5, BALANCED risk, £100.0m, three players per club, candidate limit 20, and beam width 120. The raw arm changed the beam value scalar to horizon xP; the shipped arm used `utilityValue`; λ=0.5 geometrically interpolated between those scalars. The λ=1 experiment clone matched the shipped optimizer's selected IDs and score on every successful fit and held-out decision.

Before the experiment, `validate.ts` passed on all four prepared corpora with zero total and component gaps: 9,872 rows in 2022/23, 9,905 in 2023/24, 10,030 in 2024/25, and 9,972 in 2025/26. The 2022/23 and 2023/24 seasons were excluded from utility fitting and scoring because 2022/23 xG is incomplete and both seasons are Elo burn-in.

The fit used 2024/25 GWs 6–20 (15 gameweek clusters). Mean realized points selected λ=0.5 from the grid:

| λ | 0 | 0.25 | 0.5 | 0.75 | 1 (shipped) |
|---:|---:|---:|---:|---:|---:|
| Training points/GW | 65.733 | 65.333 | 66.400 | 66.333 | 65.467 |

Held-out scoring used later 2024/25 GWs 21–34 and 2025/26 GWs 6–34. Each decision built legal 15-player squads (2/5/5/3, prior-week prices, £100.0m budget, maximum three per club), then scored the chosen XI, captain, and autosubs against actual FPL match points. The candidate pools ranged from 711 to 829 players. All 43 paired decisions passed squad legality checks.

## Held-out results

The intervals are 10,000-resample paired gameweek-cluster bootstrap intervals. Pooled resampling keeps the sample count for each season fixed.

| Held-out split | GWs | Raw xP points/GW | Shipped points/GW | λ=0.5 points/GW | Shipped − raw, 95% CI | λ=0.5 − shipped, 95% CI | λ=0.5 − raw, 95% CI |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2024/25, GWs 21–34 | 14 | 55.500 | 55.071 | 54.929 | −0.429 [−3.143, 2.143] | −0.143 [−2.143, 2.286] | −0.571 [−2.857, 1.643] |
| 2025/26, GWs 6–34 | 29 | 53.483 | 55.655 | 54.483 | +2.172 [+0.172, 4.622] | −1.172 [−2.621, 0.034] | +1.000 [−0.483, 2.655] |
| Pooled | 43 | 54.140 | 55.465 | 54.628 | +1.326 [−0.326, 3.163] | −0.837 [−2.047, 0.302] | +0.488 [−0.744, 1.860] |

The shipped squad differed from raw xP in 40 of 43 decisions. It outscored raw xP in 5/14 gameweeks in 2024/25 and 10/29 in 2025/26; the 2025/26 mean is concentrated in a few weeks, including +22 points in GW33 and +20 in GW20. The pooled interval and inconsistent split results do not support a production change.

At HEAD, `findReplacements` sorts by projected xP delta, adjusted for cash release and a SAFE-only minutes bonus. `utilityValue` only appears in slot-suggestion display text, so the utility comparison covers the full-squad beam where it changes candidate ranking.

## Inputs and limitations

The shared prepared corpus was read only. Historical prices came from Vaastav `merged_gw.csv`; the script checked every prepared player-fixture row against that source before using it. SHA-256 values were `5bbbcba6353b4c72ad273adcc8e3aa451946a826564679788f45b1cb3325b84e` for 2024/25 and `0d09f1f1cb1b5520ec8e2f25238aa652efe2a263d8ca7cb2b6538b27bf86727d` for 2025/26. The 2025/26 source and prepared corpus each had 10 identical duplicate rows; the harness deduplicated them in memory and rejected conflicting duplicates. No shared data was changed.

Historical form and team-strength inputs followed the shipped walk-forward loaders: prior-season player match rows were remapped through prepared anchors; player xG/xA history included opponent and venue context; double-gameweek teams were excluded from team xG; selection history used completed pre-deadline appearances. A harness fix removed a prior version's use of target-gameweek rows to infer a player's club, which would have leaked post-kickoff information.

The archive has no historical RotoWire, official availability, or as-of FDR snapshots. The experiment therefore used reconstructed minutes evidence, `status="a"`, no chance-of-playing estimate, and neutral FDR 3. It assigned each player to the latest club observed before the deadline and used prior-week market prices; transfers after the player's last appearance can be misassigned. Fixture pairings and gameweek placements came from the final historical schedule, so later rescheduling may differ from the schedule known at a decision deadline. These gaps mean the projections omit historical availability, FDR, official roster timing, actual manager squad choices, and manager-specific budgets.

## Rerun

Run from the worktree root. The parity gate and experiment logs are under `output/tier-c/`.
The `*-context` logs and current JSON files are final; the unqualified `fit.log` and `eval-*.log` files are preliminary runs from before the no-target-week-leakage fix.

```sh
for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/$season TIER_C_SEASON=$season \
    npx tsx scripts/backtest/validate.ts > output/tier-c/validate-$season.log 2>&1 || exit
done

BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2024-25 TIER_C_SEASON=2024-25 \
  TIER_C_START_GW=6 TIER_C_END_GW=20 \
  npx tsx scripts/backtest/tier-c-utility.ts fit > output/tier-c/fit-context.log 2>&1

BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2024-25 TIER_C_SEASON=2024-25 \
  TIER_C_START_GW=21 TIER_C_END_GW=34 \
  npx tsx scripts/backtest/tier-c-utility.ts evaluate > output/tier-c/eval-context-2024-25.log 2>&1

BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2025-26 TIER_C_SEASON=2025-26 \
  TIER_C_START_GW=6 TIER_C_END_GW=34 \
  npx tsx scripts/backtest/tier-c-utility.ts evaluate > output/tier-c/eval-context-2025-26.log 2>&1

npx tsx scripts/backtest/tier-c-utility.ts summarize > output/tier-c/summarize-context.log 2>&1
npx tsc --noEmit --pretty false > output/tier-c/typecheck-final.log 2>&1
npx eslint scripts/backtest/tier-c-utility.ts > output/tier-c/eslint-final.log 2>&1
```

The harness fixes were: production-style walk-forward form and selection reconstruction; removal of target-week team leakage; exact historical-price/source row checks; in-memory deduplication of identical rows; per-week λ=1 optimizer parity assertions; and explicit logging of any optimizer failure. Both final held-out runs had zero optimizer failures. TypeScript, focused ESLint, and all four parity gates passed. No production files or canonical backtest documentation were changed, and no commit was created.
