# GW4 continuous-150 FDR sensitivity

Task ID: `fdr150_experiments`. The run reads the saved snapshot, generated, and manual inputs listed below and evaluates the five requested MID players on their GW4 fixture. It freezes those file contents at read time and records hashes and fetch times; a later rerun can differ if any saved input is refreshed. The baseline is the current production `projectPlayer` path with continuous ClubElo divisor 150; each arm changes one global parameter or assumption.

## Baseline

| Player | xP | Appearance | Goals | Assists | Clean sheets | Defensive contribution | Bonus | Cards |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Bruno Fernandes | 5.811 | 1.888000 | 1.803492 | 0.948406 | 0.214590 | 0.288446 | 0.841533 | -0.173825 |
| Bryan Mbeumo | 5.019 | 1.888000 | 1.931425 | 0.516338 | 0.214590 | 0.108946 | 0.533290 | -0.173987 |
| Marcus Tavernier | 5.577 | 1.888000 | 1.913512 | 0.536316 | 0.293102 | 0.410950 | 0.708237 | -0.173298 |
| Morgan Rogers | 5.549 | 1.888000 | 1.711975 | 0.998248 | 0.421749 | 0.145024 | 0.550478 | -0.166566 |
| Cole Palmer | 6.687 | 1.888000 | 2.822251 | 0.735603 | 0.421749 | 0.196643 | 0.792380 | -0.169876 |

The custom component evaluator matched production with a maximum component gap of 0.000e+0 and a maximum fixture-adjustment gap of 0.000e+0 across all five players, including the historical source-team strength passed into the xG/xA rate path. The baseline absolute xP values are production rounded values; arm values below are rounded to three decimals. Delta arithmetic and ranking use unrounded component totals, so a displayed value and displayed delta can differ by one last decimal.

## Ranked arms

Ranking first counts desired-sign raw deltas at least 0.001 xP (lower Bruno, Mbeumo, Tavernier; higher Rogers, Palmer), then uses the raw net directional sum `-ΔBruno -ΔMbeumo -ΔTavernier +ΔRogers +ΔPalmer`. Ties are ordered by arm id. Every arm is retained, including unfavorable and zero-direction arms.

| Rank | Arm | Desired signs | Net directional sum | Bruno | Mbeumo | Tavernier | Rogers | Palmer |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Team prior weight 24 | 5/5 | 0.242957 | 5.783 (-0.028) | 4.996 (-0.022) | 5.530 (-0.047) | 5.612 (+0.063) | 6.770 (+0.083) |
| 2 | Regression prior 1800 minutes | 4/5 | 0.344568 | 5.726 (-0.084) | 4.953 (-0.066) | 5.427 (-0.150) | 5.635 (+0.086) | 6.645 (-0.042) |
| 3 | Player form prior weight 12 | 4/5 | 0.319788 | 5.758 (-0.052) | 4.850 (-0.169) | 5.262 (-0.314) | 5.269 (-0.280) | 6.751 (+0.064) |
| 4 | FDR divisor 130 | 4/5 | 0.201552 | 5.767 (-0.044) | 4.982 (-0.036) | 5.579 (+0.002) | 5.602 (+0.053) | 6.757 (+0.070) |
| 5 | Clean sheet Elo slope 0.005 | 4/5 | 0.187433 | 5.779 (-0.032) | 4.987 (-0.032) | 5.579 (+0.002) | 5.612 (+0.063) | 6.750 (+0.063) |
| 6 | Selection certainty 0.75 | 3/5 | 0.485215 | 5.134 (-0.677) | 4.434 (-0.585) | 4.927 (-0.650) | 4.902 (-0.646) | 5.907 (-0.780) |
| 7 | Price prior scale 0.75 | 3/5 | -0.078037 | 5.717 (-0.094) | 4.945 (-0.074) | 5.519 (-0.058) | 5.454 (-0.095) | 6.478 (-0.209) |
| 8 | Expected role minutes +5 | 2/5 | 0.302507 | 5.818 (+0.008) | 5.025 (+0.006) | 5.615 (+0.038) | 5.744 (+0.195) | 6.847 (+0.160) |
| 9 | Price prior scale 1.25 | 2/5 | 0.078037 | 5.904 (+0.094) | 5.092 (+0.074) | 5.635 (+0.058) | 5.644 (+0.095) | 6.896 (+0.209) |
| 10 | Player form decay 1.00 | 2/5 | 0.027408 | 5.821 (+0.011) | 5.042 (+0.024) | 5.576 (-0.001) | 5.610 (+0.061) | 6.686 (-0.001) |
| 11 | Player form decay 0.90 | 2/5 | -0.025397 | 5.799 (-0.012) | 4.994 (-0.024) | 5.578 (+0.002) | 5.488 (-0.061) | 6.688 (+0.001) |
| 12 | Player winsor ratio 2.0 | 1/5 | 0.069692 | 5.811 (+0.000) | 5.019 (+0.000) | 5.370 (-0.207) | 5.417 (-0.132) | 6.681 (-0.006) |
| 13 | Clean sheet Elo slope 0.002 | 1/5 | -0.170756 | 5.840 (+0.029) | 5.048 (+0.029) | 5.575 (-0.002) | 5.492 (-0.057) | 6.629 (-0.057) |
| 14 | Regression prior 450 minutes | 1/5 | -0.240373 | 5.869 (+0.059) | 5.071 (+0.053) | 5.683 (+0.106) | 5.492 (-0.057) | 6.721 (+0.034) |
| 15 | FDR divisor 200 | 1/5 | -0.327522 | 5.882 (+0.071) | 5.078 (+0.059) | 5.574 (-0.003) | 5.463 (-0.086) | 6.572 (-0.115) |
| 16 | Player form prior weight 3 | 1/5 | -0.408177 | 5.881 (+0.070) | 5.233 (+0.214) | 5.975 (+0.398) | 5.905 (+0.356) | 6.605 (-0.082) |
| 17 | Bonus rate flat | 1/5 | -0.450362 | 5.860 (+0.050) | 5.050 (+0.032) | 5.481 (-0.096) | 5.358 (-0.190) | 6.413 (-0.274) |
| 18 | FDR divisor 300 | 1/5 | -0.655043 | 5.953 (+0.142) | 5.137 (+0.118) | 5.570 (-0.006) | 5.377 (-0.172) | 6.458 (-0.229) |
| 19 | Attack ratio clamp [0.55, 1.75] | 0/5 | 0.000000 | 5.811 (+0.000) | 5.019 (+0.000) | 5.577 (+0.000) | 5.549 (+0.000) | 6.687 (+0.000) |
| 20 | Baseline continuous FDR 150 | 0/5 | 0.000000 | 5.811 (+0.000) | 5.019 (+0.000) | 5.577 (+0.000) | 5.549 (+0.000) | 6.687 (+0.000) |
| 21 | Team form decay 0.80 | 0/5 | 0.000000 | 5.811 (+0.000) | 5.019 (+0.000) | 5.577 (+0.000) | 5.549 (+0.000) | 6.687 (+0.000) |
| 22 | Team form decay 1.00 | 0/5 | 0.000000 | 5.811 (+0.000) | 5.019 (+0.000) | 5.577 (+0.000) | 5.549 (+0.000) | 6.687 (+0.000) |
| 23 | Player winsor ratio 5.0 | 0/5 | -0.171166 | 5.811 (+0.000) | 5.019 (+0.000) | 5.748 (+0.171) | 5.549 (+0.000) | 6.687 (+0.000) |
| 24 | Clean sheet table path | 0/5 | -0.258462 | 5.848 (+0.037) | 5.056 (+0.037) | 5.607 (+0.030) | 5.472 (-0.077) | 6.610 (-0.077) |
| 25 | Team prior weight 6 | 0/5 | -0.391467 | 5.864 (+0.053) | 5.062 (+0.043) | 5.653 (+0.076) | 5.455 (-0.094) | 6.561 (-0.125) |

The top arm changes only `applyInSeasonForm`'s team prior weight from 12 to 24. Because the cached GW1/GW2 team-xG rows have no opponent/venue fields, the joint team fit has 10 contextual fixtures across GW3 here, so this arm is a one-gameweek shrinkage sensitivity and the team-decay arms are correctly zero on this input. Pulling those observations harder toward the saved preseason strengths changes the teams' fixture attack ratios and clean-sheet inputs in opposite directions: Bruno Fernandes attack returns -0.031, bonus +0.005; Bryan Mbeumo attack returns -0.024, bonus +0.003; Marcus Tavernier attack returns -0.033, bonus -0.012; Morgan Rogers attack returns +0.055, bonus +0.011; Cole Palmer attack returns +0.071, bonus +0.016.

The current selection model's alpha 0.60 arm is omitted because all five targets have at least 240 observed current-season minutes, which activates the role-established path that bypasses `START_RATE_ALPHA`; changing alpha therefore produces no target selection or xP delta on this frozen input.

## Interpretation

These rows show scenario sensitivity and directional tuning on one frozen snapshot. The ClubElo values here are the saved snapshot used by the production path; the synthetic-input limitation applies to earlier historical backtests, not this run. This one-gameweek comparison is not accuracy evidence, and changing a global assumption can move the five players in the requested directions by construction. Accuracy claims require a separate walk-forward evaluation on held-out fixtures.

## Reproduction

`npx tsx scripts/experiments/fdr-sensitivity-gw4.ts`

Saved input fetch times recorded in the JSON: data/snapshots/bootstrap.json=2026-09-10T23:32:05.839Z, data/snapshots/fixtures.json=2026-09-10T23:32:05.744Z, data/snapshots/in-season-xg-gw-1.json=2026-08-25T21:38:45.569Z, data/snapshots/in-season-xg-gw-2.json=2026-09-01T18:29:16.862Z, data/snapshots/in-season-xg-gw-3.json=2026-09-07T15:21:29.635Z, data/snapshots/in-season-player-rates-gw-1.json=2026-08-25T21:38:45.588Z, data/snapshots/in-season-player-rates-gw-2.json=2026-09-01T18:29:16.834Z, data/snapshots/in-season-player-rates-gw-3.json=2026-09-07T15:21:29.638Z, data/snapshots/in-season-starts-gw-1.json=2026-09-07T18:46:24.222Z, data/snapshots/in-season-starts-gw-2.json=2026-09-07T18:46:24.333Z, data/snapshots/in-season-starts-gw-3.json=2026-09-07T18:46:24.444Z, data/generated/rotowire-lineups.json=2026-09-10T22:15:21.109Z, data/generated/club-elo.json=2026-09-08T06:13:55.178Z.
