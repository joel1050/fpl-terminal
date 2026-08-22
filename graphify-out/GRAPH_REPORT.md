# Graph Report - .  (2026-08-20)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 488 nodes · 1089 edges · 52 communities (12 shown, 40 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.68)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51

## God Nodes (most connected - your core abstractions)
1. `projectPlayer()` - 22 edges
2. `analyzeSquad()` - 20 edges
3. `playerMap()` - 20 edges
4. `suggestForSlot()` - 18 edges
5. `createFplToolAdapters()` - 17 edges
6. `PlayerUniverse` - 17 edges
7. `findReplacements()` - 17 edges
8. `costOf()` - 15 edges
9. `validatePartialSquad()` - 15 edges
10. `runAnalyst()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `findReplacements()` --indirect_call--> `minutes()`  [INFERRED]
  lib/analysis/replacements.ts → lib/squad/weeklyLineup.ts
- `minimumCheapCost()` --indirect_call--> `position()`  [INFERRED]
  lib/optimizer/optimizer.ts → lib/historical/ingest.ts
- `minimumRemainingSpend()` --indirect_call--> `position()`  [INFERRED]
  lib/squad/budget.ts → lib/historical/ingest.ts
- `RunAnalystOptions` --references--> `AIDataAdapters`  [EXTRACTED]
  lib/ai/agent.ts → lib/ai/tools.ts
- `compactPlayer()` --calls--> `projectPlayer()`  [EXTRACTED]
  lib/ai/tools.ts → lib/projections/projectPlayer.ts

## Import Cycles
- None detected.

## Communities (52 total, 40 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.09
Nodes (71): analyzeSquad(), AnalyzeSquadInput, AnalyzeSquadOptions, buildStrengths(), buildWarnings(), chooseStartingXI(), parseInput(), projectionFor() (+63 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (65): AnalystChat, AnalystChatRequest, AnalystRunResult, cleanAssistantText(), normalizeRequest(), offlineResult(), parseAssistantResponse(), parseJsonCandidate() (+57 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (47): clamp(), estimateExpectedMinutes(), ExpectedMinutesOptions, observedRecentMinutes(), priorMinutes(), statusAvailability(), calculateFixtureAdjustment(), clamp() (+39 more)

### Community 3 - "Community 3"
Cohesion: 0.12
Nodes (36): availableCandidates(), BudgetOptions, BudgetRequest, calculateBudgetFeasibility(), explainIllegalSelection(), IllegalSelectionExplanation, maxSafePriceForPosition(), minimumRemainingSpend() (+28 more)

### Community 4 - "Community 4"
Cohesion: 0.09
Nodes (41): capture(), decodeHtml(), entities, fetchRotowireLineups(), fixtureBlocks(), parseRotowireLineups(), parseTeamList(), playerRows() (+33 more)

### Community 5 - "Community 5"
Cohesion: 0.10
Nodes (30): parseExternal(), aggregateHistoricalPlayers(), CsvRow, download(), ingestHistoricalData(), IngestOptions, mapHistoricalPlayers(), normalizedName() (+22 more)

### Community 6 - "Community 6"
Cohesion: 0.15
Nodes (30): appearanceProbability(), applyMask(), basePoints(), benchIsValid(), candidateFor(), captainPair(), clamp(), compareCandidates() (+22 more)

### Community 7 - "Community 7"
Cohesion: 0.13
Nodes (18): BootstrapProjectionMetadata, normalizeBootstrap(), NormalizedBootstrap, NormalizedEvent, NormalizedFixture, NormalizedLiveElement, NormalizedLiveGameweek, NormalizedPlayerDetail (+10 more)

### Community 8 - "Community 8"
Cohesion: 0.18
Nodes (16): getMemoryCache(), isCacheFresh(), setMemoryCache(), errorMessage(), FPL_BASE_URL, FplRequestOptions, getBootstrap(), getFixtures() (+8 more)

### Community 9 - "Community 9"
Cohesion: 0.14
Nodes (13): FplBootstrapPayload, FplElementSchema, FplElementTypeSchema, FplEventSchema, FplFixtureSchema, FplHistoryRowSchema, FplLiveElementSchema, FplLiveResponseSchema (+5 more)

### Community 10 - "Community 10"
Cohesion: 0.21
Nodes (11): DataSource, FPL_CACHE_TTLS_MS, FplResponse, getFreshness(), memory, MemoryEntry, readSnapshot(), Snapshot (+3 more)

### Community 11 - "Community 11"
Cohesion: 0.25
Nodes (10): enrichBootstrapWithProjections(), currentGameweek(), deriveTeamStrengths(), EnrichedPlayers, EnrichmentEvent, EnrichmentTeam, enrichPlayersWithHistory(), finiteOr() (+2 more)

## Knowledge Gaps
- **135 isolated node(s):** `AnalystChat`, `DeepSeekChatRequest`, `idSchema`, `positionSchema`, `priceSchema` (+130 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **40 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `projectPlayer()` connect `Community 2` to `Community 0`, `Community 1`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Why does `normalizeBootstrap()` connect `Community 7` to `Community 1`, `Community 5`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `pickWeeklyTeam()` connect `Community 6` to `Community 1`, `Community 3`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **What connects `AnalystChat`, `DeepSeekChatRequest`, `idSchema` to the rest of the system?**
  _135 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08610049955921247 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05517503805175038 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06957047791893527 - nodes in this community are weakly interconnected._