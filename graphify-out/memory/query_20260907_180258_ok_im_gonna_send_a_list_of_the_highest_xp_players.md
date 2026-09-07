---
type: "query"
date: "2026-09-07T18:02:58.527349+00:00"
question: "ok im gonna send a list of the highest xp players in each position spot xp that is inconsistent with reality there defintely are a few, and how to fix those lets start with forwards"
contributor: "graphify"
outcome: "useful"
source_nodes: ["projectPlayer.ts", "projectPlayer()", "expectedMinutes.ts", "HistoricalBundle"]
---

# Q: ok im gonna send a list of the highest xp players in each position spot xp that is inconsistent with reality there defintely are a few, and how to fix those lets start with forwards

## Answer

Expanded from original query via graph vocab: [projection, player, expected, minutes, fixture, form, selection, historical, rate, regression, availability, strength]. Forward diagnosis: Isak 17.3 is too low; Awoniyi 22.6, Kostoulas 20.8, and McBurnie 17.5 are too high; Nketiah is only borderline. The form path uses an unregressed small-sample historical rate as its ten-match anchor. A same-snapshot counterfactual that first regresses that anchor toward the price-tier prior moves Isak 17.3 to 20.9, Awoniyi 22.6 to 19.6, and Kostoulas 20.8 to 18.8 while leaving established players nearly unchanged. McBurnie has no usable history and the generic prior is divided by Hull attack before the upcoming team multiplier restores it, cancelling the weak-team penalty; preserving the team effect moves him near 15.9. The lineup source is also not tied to planning Gameweek: confirmed GW3 starters receive a future-role boost, while Liverpool is absent because its match fell outside the Sep 5 scrape, leaving Isak at 62.2 expected minutes despite three starts and 243 minutes. Fix by shrinking the historical anchor before blendPlayerRate, keeping generic priors league-neutral, normalizing transferred historical rates by their source team, filtering lineup evidence to the projected fixture, and updating expected start duration from current-season starts.

## Outcome

- Signal: useful

## Source Nodes

- projectPlayer.ts
- projectPlayer()
- expectedMinutes.ts
- HistoricalBundle