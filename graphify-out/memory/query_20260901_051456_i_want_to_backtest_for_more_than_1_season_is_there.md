---
type: "query"
date: "2026-09-01T05:14:56.828294+00:00"
question: "i want to backtest for more than 1 season is there any way you can get data for more seasons"
contributor: "graphify"
outcome: "useful"
source_nodes: ["ingestHistoricalData()", "HistoricalBundle", "loadSeason()"]
---

# Q: i want to backtest for more than 1 season is there any way you can get data for more seasons

## Answer

Expanded from original query via graph vocab: [historical, season, data, ingest, load, fixture, fixtures, clean, sheet]. The existing ingestHistoricalData function already accepts a seasonPath and the backtest loader accepts BACKTEST_DATA_DIR. The Vaastav Fantasy Premier League archive has merged_gw.csv, players_raw.csv, and teams.csv for 2022-23, 2023-24, 2024-25, and 2025-26. These four seasons contain expected_goals and expected_assists, so they can test the same recency-weighted team-xG clean-sheet algorithm. Seasons 2021-22 and earlier lack expected-goals columns, so using them would require a second xG source and team/fixture mapping. The minimal implementation is to ingest each compatible season into a scratch directory, make the clean-sheet runner aggregate cases across those directories, and bootstrap by season/gameweek. Do not overwrite data/generated.

## Outcome

- Signal: useful

## Source Nodes

- ingestHistoricalData()
- HistoricalBundle
- loadSeason()