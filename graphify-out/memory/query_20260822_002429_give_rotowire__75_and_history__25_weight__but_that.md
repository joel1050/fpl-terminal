---
type: "query"
date: "2026-08-22T00:24:29.568123+00:00"
question: "give rotowire .75 and history .25 weight, but that shouldnt increase the p(start/cameo) if the player is inj/sus"
contributor: "graphify"
outcome: "useful"
source_nodes: ["buildPlayerSelections", "rotowireSignals", "officialAvailability", "normalizeScenarios"]
---

# Q: give rotowire .75 and history .25 weight, but that shouldnt increase the p(start/cameo) if the player is inj/sus

## Answer

Expanded from original query via graph vocab: [selection, probability, historical, rotowire, availability, player, minutes, confidence]. Replaced the hard RotoWire floor in buildPlayerSelections with a true 75/25 blend for covered teams. Predicted XI contributes start=0.90 and cameo=0.05; confirmed start=0.96; omitted players contribute start=0.10 and cameo=0.12. Historical start/cameo rates contribute 25%, using conservative fallbacks when unmapped. RotoWire QUES/OUT/SUS and official FPL injury/suspension adjustments remain after blending, so unavailable players cannot exceed 0.01 for either start or cameo even when simultaneously marked as a RotoWire starter. Live data has zero players at exactly 0.90, compared with 214 before. Added exact weighting and contradictory starter-plus-unavailable tests. All 83 unit tests, 10 E2E tests, typecheck, lint, and production build passed.

## Outcome

- Signal: useful

## Source Nodes

- buildPlayerSelections
- rotowireSignals
- officialAvailability
- normalizeScenarios