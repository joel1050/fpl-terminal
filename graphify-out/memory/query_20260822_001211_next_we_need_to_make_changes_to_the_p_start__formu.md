---
type: "query"
date: "2026-08-22T00:12:11.815679+00:00"
question: "next we need to make changes to the p(start) formula how is it calculated"
contributor: "graphify"
outcome: "useful"
source_nodes: ["buildPlayerSelections", "historicalSignal", "fallbackStartRate", "rotowireSignals", "officialAvailability", "normalizeScenarios"]
---

# Q: next we need to make changes to the p(start) formula how is it calculated

## Answer

Expanded from original query via graph vocab: [selection, probability, historical, rotowire, player, confidence, availability, minutes]. P(start) is built in selection.ts. Historical start rate is starts divided by max(match rows, starts, ceil(minutes/90)); fallback is 0.15 with zero current minutes, otherwise clamp(0.1 + currentMinutes/1800, 0.15, 0.8). Base start = 0.75*historicalStart + 0.25*fallback; with no history it equals fallback. A RotoWire predicted starter gets a hard minimum 0.90, confirmed 0.96, and cameo capped at 0.05. A player omitted from a covered team's XI has start multiplied by 0.2 and cameo floored at 0.12. RotoWire QUES multiplies start by 0.65; OUT/SUS by 0.01. FPL unavailable caps start at 0.01; doubts apply 0.7 and chanceOfPlaying applies another percentage multiplier. Start/cameo are normalized if their sum exceeds one, and no-show is the remainder. Live data has 214 players at exactly 0.90, showing that the hard RotoWire floor erases most historical differences.

## Outcome

- Signal: useful

## Source Nodes

- buildPlayerSelections
- historicalSignal
- fallbackStartRate
- rotowireSignals
- officialAvailability
- normalizeScenarios