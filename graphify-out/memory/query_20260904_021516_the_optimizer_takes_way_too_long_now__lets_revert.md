---
type: "query"
date: "2026-09-04T02:15:16.755396+00:00"
question: "the optimizer takes way too long now, lets revert back to standardized bench options\\n\\nCHEAP, BALANCED AND STRONG\\n\\nBUT THE CHEAP OPTIONS SHOULD STILL BE GOOD FOR THE PRICE"
contributor: "graphify"
outcome: "useful"
source_nodes: ["optimizer.ts", "objective.ts", "value.ts"]
---

# Q: the optimizer takes way too long now, lets revert back to standardized bench options\n\nCHEAP, BALANCED AND STRONG\n\nBUT THE CHEAP OPTIONS SHOULD STILL BE GOOD FOR THE PRICE

## Answer

Expanded from original query via graph vocab: [optimizer, objective, bench, cheap, price, value, utility, horizon]. Removed the expected-autosub MILP variables and restored CHEAP, BALANCED, and STRONG settings. The fast linear objective values BALANCED reserves at 20% xP, STRONG at 35%, and CHEAP at 15% adjusted by 50/priceTenths so it selects useful value rather than the absolute cheapest player. Risk remains removed.

## Outcome

- Signal: useful

## Source Nodes

- optimizer.ts
- objective.ts
- value.ts