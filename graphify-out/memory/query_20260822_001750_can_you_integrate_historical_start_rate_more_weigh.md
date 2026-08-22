---
type: "query"
date: "2026-08-22T00:17:50.418923+00:00"
question: "can you integrate historical start rate more weight in the calculation how would we do this"
contributor: "graphify"
outcome: "useful"
source_nodes: ["buildPlayerSelections", "historicalSignal", "fallbackStartRate", "rotowireSignals", "normalizeScenarios"]
---

# Q: can you integrate historical start rate more weight in the calculation how would we do this

## Answer

Expanded from original query via graph vocab: [selection, probability, historical, rotowire, player, confidence, availability, minutes]. Increasing the existing 75% coefficient alone would do nothing for RotoWire starters because the later max(base, 0.90) still overwrites history. Replace the hard floor with confidence-weighted blending. Derive historicalRate as now, set historyReliability=min(history.matches/12,1), historyWeight=0.65*historyReliability, and map RotoWire to explicit probabilities: confirmed 0.98, predicted 0.88, omitted from a covered XI 0.10. With both sources, P(start)=(historyWeight*historicalRate+0.35*RotoProbability)/(historyWeight+0.35). With no history use RotoWire directly; with no RotoWire blend history toward the conservative fallback by historyReliability. Then apply availability adjustments and derive cameo/no-show. Full-history examples: 90% historical plus predicted becomes 89.3%; 70% becomes 76.3%; 50% becomes 63.3%; 20% becomes 43.8%. This retains meaningful differentiation while current lineup reporting still updates roles.

## Outcome

- Signal: useful

## Source Nodes

- buildPlayerSelections
- historicalSignal
- fallbackStartRate
- rotowireSignals
- normalizeScenarios