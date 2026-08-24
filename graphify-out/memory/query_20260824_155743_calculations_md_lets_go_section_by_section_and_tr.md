---
type: "query"
date: "2026-08-24T15:57:43.890557+00:00"
question: "@calculations.md lets go section by section and try to improve the metrics formulation in this app, start with section 3\nsummarize it in a simple manner and rate 1-10 on how accurate you think it is as an estimate, and propose changes that you think would make it more accurate"
contributor: "graphify"
outcome: "useful"
source_nodes: ["deriveTeamStrengths()", "blendInSeasonForm()", "loadInSeasonTeamXG()", "calculateFixtureAdjustment()"]
---

# Q: @calculations.md lets go section by section and try to improve the metrics formulation in this app, start with section 3
summarize it in a simple manner and rate 1-10 on how accurate you think it is as an estimate, and propose changes that you think would make it more accurate

## Answer

Expanded from original query via graph vocab: [team, strength, season, prior].

Section 3 estimates each club's attack and defence strength. It starts with a manual preseason 1-5 tier, normalizes the league around 1.0, then moves that prior toward recency-weighted team xG as matches are played. A value above 1.0 means stronger than league average.

Rating: 6/10. The structure is sensible because attack and defence are separate, xG is less noisy than goals or results, and the prior protects early-season estimates. Accuracy is limited by four issues: the preseason input is coarse and rounded; in-season xG is not adjusted for opponent or venue; loadInSeasonTeamXG can cache a partly completed gameweek and cannot separate a double gameweek's per-fixture xG; and the claimed two-season backtest has no reproducible script or result artifact in the repository. With decay 0.9 and priorWeight 10, current-season evidence reaches only about 49.5% after 38 matches, so the coarse preseason prior still slightly dominates at season end.

Changes, in order: (1) only cache a gameweek after every fixture is finished and skip double-gameweek observations unless per-fixture xG is available; (2) convert each match's xG into opponent- and venue-adjusted evidence before blending; (3) retain continuous preseason attack/defence values instead of rounding to five tiers, with a promoted-team league adjustment; (4) commit a walk-forward backtest and retune decay/priorWeight after the data fixes. Section 7 should separately check whether multiplying FPL fixture difficulty by these team ratios double-counts opponent quality.

## Outcome

- Signal: useful

## Source Nodes

- deriveTeamStrengths()
- blendInSeasonForm()
- loadInSeasonTeamXG()
- calculateFixtureAdjustment()