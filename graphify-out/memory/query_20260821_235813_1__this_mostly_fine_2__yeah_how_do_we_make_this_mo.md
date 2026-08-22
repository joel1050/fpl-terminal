---
type: "query"
date: "2026-08-21T23:58:13.659896+00:00"
question: "1. this mostly fine 2. yeah how do we make this more realistic, it should be closer to zero, do we have access to last seasons stats 3. thats whatever its fine 4. look at betting odds for recent matches for clean sheets match it against our strength rating system and design appropriate clean sheet odds, it should be closer to 0 for ars - cov"
contributor: "graphify"
outcome: "useful"
source_nodes: ["HistoricalBundle", "ingest.ts", "regressedPlayerRate", "fixtureAdjustment.ts", "deriveTeamStrengths"]
---

# Q: 1. this mostly fine 2. yeah how do we make this more realistic, it should be closer to zero, do we have access to last seasons stats 3. thats whatever its fine 4. look at betting odds for recent matches for clean sheets match it against our strength rating system and design appropriate clean sheet odds, it should be closer to 0 for ars - cov

## Answer

Expanded from original query via graph vocab: [historical, history, season, fixture, clean, expected, strength, strengths, player, projection]. The repo already contains 841 player season records and 29,757 match records for 2025/26, with 461 exact current-player mappings and 138 unresolved. For 128 defenders with at least 900 minutes, xG/90 p25 was 0.0268 and xA/90 p25 was 0.0264; the current 0.08 priors are around the 75th percentile. Use actual regressed history when mapped and conservative 0.02 xG/90 plus 0.02 xA/90 for unmapped defenders. From 380 EPL matches using de-vigged closing average 1X2 and O/U 2.5 odds, inferred tier-1 away clean sheet probability against tier-5 opponents had a 6.8% median; Arsenal-specific examples were 6.3%, 6.0%, and 4.8%. Current Coventry-at-Arsenal is 9.0%, so target about 6%, not zero. Replace the coarse exponential strength ratio with market-calibrated home/away 5x5 tier tables, retaining a 2% emergency floor.

## Outcome

- Signal: useful

## Source Nodes

- HistoricalBundle
- ingest.ts
- regressedPlayerRate
- fixtureAdjustment.ts
- deriveTeamStrengths