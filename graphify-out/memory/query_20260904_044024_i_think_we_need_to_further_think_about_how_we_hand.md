---
type: "query"
date: "2026-09-04T04:40:24.371651+00:00"
question: "i think we need to further think about how we handle cheap balanced and strong bench currently the weights are arbitrary"
contributor: "graphify"
outcome: "useful"
source_nodes: ["optimizer.ts", "weeklyLineup.ts", "expectedAutosubValue", "probabilityDidNotPlay", "objective.ts", "value.ts"]
---

# Q: i think we need to further think about how we handle cheap balanced and strong bench currently the weights are arbitrary

## Answer

Expanded from original query via vocab: [optimizer, bench, autosub, probability, objective, price, value, points, squad, weekly, lineup, minutes]. The current 0.15/0.20/0.35 reserve multipliers are arbitrary and structurally wrong because they apply one weight to every reserve, regardless of goalkeeper rules, bench order, formation legality, and starter DNP probabilities. A pure xP optimizer should have one data-derived expected-autosub objective: separate goalkeeper replacement probability and outfield slot-use probabilities, with Bench Boost weight 1.0. Keep computation fast by calibrating a linear surrogate from walk-forward simulations and using weeklyLineup.ts for exact post-solve lineup scoring. If CHEAP/BALANCED/STRONG remain, they should be explicit structural preferences or risk quantiles, not fake point weights; only BALANCED/EXPECTED is the default xP optimum.

## Outcome

- Signal: useful

## Source Nodes

- optimizer.ts
- weeklyLineup.ts
- expectedAutosubValue
- probabilityDidNotPlay
- objective.ts
- value.ts