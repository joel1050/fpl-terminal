---
type: "query"
date: "2026-09-03T05:53:06.868558+00:00"
question: "are double gameweeks and blank gameweeks handled in this app"
contributor: "graphify"
outcome: "useful"
source_nodes: ["projectPlayer.ts", "weeklyLineup.ts", "fixturePointsForGameweek"]
---

# Q: are double gameweeks and blank gameweeks handled in this app

## Answer

Expanded from original query via graph vocab: [fixture, fixtures, gameweek, gameweeks, lineup, projection, weekly]. Yes. Projection fixtures are grouped by gameweek and summed, so doubles include every fixture. Weekly lineup scoring filters all fixture projections for the selected gameweek and sums them. When the projection has a schedule but no fixture for that gameweek, points and minutes are zero, so blanks score zero. Chip refactoring should keep using gameweekValue and pickWeeklyTeam rather than aggregate nextGW fields.

## Outcome

- Signal: useful

## Source Nodes

- projectPlayer.ts
- weeklyLineup.ts
- fixturePointsForGameweek