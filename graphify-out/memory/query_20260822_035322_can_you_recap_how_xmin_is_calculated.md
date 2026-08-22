---
type: "query"
date: "2026-08-22T03:53:22.686492+00:00"
question: "can you recap how xmin is calculated"
contributor: "graphify"
outcome: "useful"
source_nodes: ["expectedMinutes.ts", "projectPlayer()", "HistoricalBundle"]
---

# Q: can you recap how xmin is calculated

## Answer

Expanded from original query via vocab: [expected, minutes, selection, historical, current, player, projection, availability]. In the normal enriched path, xMin is P(start) times expected start minutes plus P(cameo) times expected cameo minutes; no-appearance probability contributes zero. RotoWire-covered teams use 75 percent RotoWire signal and 25 percent historical rate, while uncovered teams use 75 percent historical rate and 25 percent current-season fallback. Injury, suspension, doubtful status, and chance-of-playing adjustments are applied afterward, and probabilities are normalized. Role minutes come from historical high-minute and cameo appearances when available, otherwise position defaults. projectPlayer uses the same start/cameo scenarios directly for xP. The standalone fallback blends a historical prior and recent minutes, then applies status availability.

## Outcome

- Signal: useful

## Source Nodes

- expectedMinutes.ts
- projectPlayer()
- HistoricalBundle