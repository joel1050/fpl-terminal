---
type: "query"
date: "2026-08-22T00:30:25.318753+00:00"
question: "give me a rundown of how xp is calculated for all 4 positions"
contributor: "graphify"
outcome: "useful"
source_nodes: ["projectPlayer", "fixtureComponents", "regressedPlayerRate", "calculateFixtureAdjustment", "buildPlayerSelections"]
---

# Q: give me a rundown of how xp is calculated for all 4 positions

## Answer

Expanded from original query via graph vocab: [project, projection, player, position, components, fixture, clean, expected, minutes, historical, strength]. For each fixture, projectPlayer sums start and cameo scenarios. Each scenario contributes probability times: 2 appearance points when minutes>=60 else 1; xG/90*minutes/90*attackMultiplier*goal points; xA/90*minutes/90*attackMultiplier*3; clean-sheet probability*position clean-sheet points when minutes>=60; GK saves/90*minutes/90*attackMultiplier/3; non-GK defensiveContribution/90*minutes/90*2 divided by threshold 10 for DEF or 12 for MID/FWD; and bonus/90*minutes/90*0.3. Position goal/CS values are GK 10/4, DEF 6/4, MID 5/1, FWD 4/0. Priors xG/xA are GK .01/.02, mapped DEF .08/.08, unmapped DEF .02/.02, MID .25/.20, FWD .45/.15. Rates regress historical/current per-90 data toward 900-minute priors. Clean sheets use venue-specific 1-5 strength tables. nextGW sums doubles; next3/next5 sum distinct GW windows. Risk/confidence do not alter XP. Current gaps: defenceMultiplier is not consumed by scoring components, GK saves incorrectly use attackMultiplier, and cards, goals-conceded deductions, own goals, penalty misses/saves, and a full BPS bonus model are absent.

## Outcome

- Signal: useful

## Source Nodes

- projectPlayer
- fixtureComponents
- regressedPlayerRate
- calculateFixtureAdjustment
- buildPlayerSelections