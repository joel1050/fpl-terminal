---
type: "query"
date: "2026-08-22T00:07:34.722253+00:00"
question: "Implement conservative unmapped-defender xG/xA priors and market-calibrated clean-sheet probabilities using Luna xhigh subagents"
contributor: "graphify"
outcome: "useful"
source_nodes: ["projectPlayer.ts", "regressedPlayerRate", "fixtureAdjustment.ts", "calculateFixtureAdjustment"]
---

# Q: Implement conservative unmapped-defender xG/xA priors and market-calibrated clean-sheet probabilities using Luna xhigh subagents

## Answer

Expanded from original query via graph vocab: [project, projection, prior, regression, historical, player, fixture, clean, strength, test]. Implemented in projectPlayer.ts: defenders without usable last-season historical attacking rates now regress current observations toward 0.02 xG/90 and 0.02 xA/90, while mapped defenders retain the existing 0.08 historical regression prior and positionPrior remains xG-only. Implemented in fixtureAdjustment.ts: normalized consensus strengths map to 1-5 tiers and select market-calibrated home/away 5x5 clean-sheet probability tables; Coventry away to Arsenal is 0.06 and Arsenal home to Coventry is 0.50, with the difficulty-only fallback preserved. Added projection-priors.test.ts and clean-sheet-calibration.test.ts. Live Coventry starter next5 fell from 17.69 to 15.27 and value from 4.42 to 3.82. All 82 unit tests, 10 E2E tests, typecheck, lint, and production build passed.

## Outcome

- Signal: useful

## Source Nodes

- projectPlayer.ts
- regressedPlayerRate
- fixtureAdjustment.ts
- calculateFixtureAdjustment