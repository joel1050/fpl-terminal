---
type: "query"
date: "2026-08-21T06:15:21.656669+00:00"
question: "look at the pts/pound does it look more accurate"
contributor: "graphify"
outcome: "useful"
source_nodes: ["PlayerUniverse", "projectPlayer()", "fixtureAdjustment.ts", "value.ts"]
---

# Q: look at the pts/pound does it look more accurate

## Answer

Expanded from original query via graph vocab: [player, universe, value, points, price, project, expected, minutes, selection, fixture, strength, sort]. The ranking is directionally improved by manual team strength but is still not credible: raw valueNext5 divides xP by full price, the clean-sheet model has an effective 25.2 percent floor because defenceMultiplier is clamped to 0.7 before multiplying by 0.36, promoted defenders without history share identical position priors, and one RotoWire predicted XI is applied as 90 percent start probability across the five-gameweek projection. The visible result is four Coventry, four Hull, and three Ipswich defenders clustered near the top with almost identical points. Prefer realistic clean-sheet probabilities, horizon-aware selection confidence, and value over replacement for ranking.

## Outcome

- Signal: useful

## Source Nodes

- PlayerUniverse
- projectPlayer()
- fixtureAdjustment.ts
- value.ts