---
type: "query"
date: "2026-09-01T03:50:51.456890+00:00"
question: "what could be done to improve clean sheet odd correctness, is the algorithm already accurate"
contributor: "graphify"
outcome: "useful"
source_nodes: ["calculateFixtureAdjustment()", "deriveTeamStrengths()", "fixtureAdjustment.ts"]
---

# Q: what could be done to improve clean sheet odd correctness, is the algorithm already accurate

## Answer

Expanded from original query via graph vocab: [clean, sheet, probability, fixture, adjustment, strength, strengths, team, derive, expected]. The current 5x5 market-calibrated table is reasonably accurate at population level: on 660 walk-forward 2025/26 team-fixtures it predicted 0.257 clean sheets against 0.256 actual, with Brier 0.1840 versus 0.1907 for the constant league rate. The lift is statistically real but modest, and one season cannot establish exact fixture-level accuracy. Team strengths already update from recency-weighted xG with decay 0.90 and prior weight 10, backtested on 2023/24 and 2024/25. Bilinear interpolation, a simple Poisson replacement, and fitted table corrections did not improve held-out accuracy. The highest-value next improvement is a vig-removed bookmaker consensus from opponent team-total under 0.5 goals, blended with the internal estimate, then validated over several seasons. Expected lineups and defensive absences are the next internal feature worth testing. Shaw at 25 percent is plausible and not a demonstrated defect.

## Outcome

- Signal: useful

## Source Nodes

- calculateFixtureAdjustment()
- deriveTeamStrengths()
- fixtureAdjustment.ts