---
type: "query"
date: "2026-08-24T16:10:17.253370+00:00"
question: "Fix the xG input first just do this,&#x20;\n\nafter this show me the team strength rankings"
contributor: "graphify"
outcome: "useful"
source_nodes: ["loadInSeasonTeamXG()", "enrichPlayersWithHistory()", "deriveTeamStrengths()"]
---

# Q: Fix the xG input first just do this,&#x20;

after this show me the team strength rankings

## Answer

Expanded from original query via graph vocab: [load, live, gameweek, fixture, season, team, enrich].

Fixed the shared in-season xG loader. It now includes a gameweek only after every fixture is finished, skips double gameweeks because event-level xG cannot be split by fixture, and replaces an old partial snapshot when its row count is incomplete. The focused Vitest file passes 3 tests, TypeScript passes, and targeted ESLint passes.

The live FPL feed fetched at 2026-08-24T16:08:54Z has no fully completed gameweek, so zero in-season teams are included and rankings correctly remain on the preseason attack/defence prior. Combined ranking, where 1.0 is league average: Arsenal 1.129, Manchester City 1.129, Liverpool/Manchester United/Chelsea/Aston Villa 1.089, Tottenham/Brighton/Bournemouth 1.048, Newcastle/Brentford/Everton 1.008, Sunderland 0.968, Crystal Palace/Fulham/Nottingham Forest/Leeds 0.927, Coventry/Ipswich/Hull 0.847.

## Outcome

- Signal: useful

## Source Nodes

- loadInSeasonTeamXG()
- enrichPlayersWithHistory()
- deriveTeamStrengths()