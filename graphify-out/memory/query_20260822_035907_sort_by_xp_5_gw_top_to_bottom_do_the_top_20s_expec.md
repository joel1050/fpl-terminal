---
type: "query"
date: "2026-08-22T03:59:07.265070+00:00"
question: "sort by xp 5 gw top to bottom do the top 20s expected minutes look accurate compared to last seasons minutes played?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["projectPlayer()", "expectedMinutes.ts", "enrichPlayers.ts", "HistoricalBundle"]
---

# Q: sort by xp 5 gw top to bottom do the top 20s expected minutes look accurate compared to last seasons minutes played?

## Answer

Expanded from original query via vocab: [expected, minutes, projection, historical, current, player]. Using the checked-in GW1 snapshot and 2025/26 historical bundle, the top 20 by next5 xP have mean xMin 76.9 versus 73.4 historical minutes per match, mean absolute error 6.3 minutes, and correlation 0.978; 11 of 20 are within 5 minutes and 16 of 20 within 10. Stable starters are well calibrated, while Cherki, Palmer, Foden, Wirtz, and Saka are materially above last-season rates because the 75 percent RotoWire weighting raises predicted-start probabilities. Virgil is conservatively low because the defender start-minute default is 84 rather than 90. The minutes model is broadly sound, but the rotation-player estimates need caution and confirmation.

## Outcome

- Signal: useful

## Source Nodes

- projectPlayer()
- expectedMinutes.ts
- enrichPlayers.ts
- HistoricalBundle