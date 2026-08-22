---
type: "query"
date: "2026-08-21T06:25:28.410850+00:00"
question: "fix the clean-sheet calculation and whatever causes all player xminutes to be 73 min"
contributor: "graphify"
outcome: "useful"
source_nodes: ["fixtureAdjustment.ts", "projectPlayer()", "expectedMinutes.ts", "PlayerUniverse"]
---

# Q: fix the clean-sheet calculation and whatever causes all player xminutes to be 73 min

## Answer

Expanded from original query via graph vocab: [clean, sheet, probability, fixture, adjustment, expected, minutes, selection, project, player, history, strength]. Fixed fixtureAdjustment by deriving clean-sheet chance from a Poisson no-goal probability using expected goals against, venue, and the own-defence/opponent-attack strength ratio; the projection multiplier clamp no longer creates a 25.2 percent probability floor. Fixed selection by estimating conditional start and cameo duration from each player's historical match rows, with position priors only when history is absent, and projectPlayer now consumes those durations. Live verification produced 162 distinct expected-minute values among 215 predicted starters and about 9 percent clean-sheet probability for Coventry away to Arsenal. All tests, typecheck, lint, and production build passed.

## Outcome

- Signal: useful

## Source Nodes

- fixtureAdjustment.ts
- projectPlayer()
- expectedMinutes.ts
- PlayerUniverse