---
type: "query"
date: "2026-09-04T06:31:19.315510+00:00"
question: "but if the players price increases it does not reflect the actual selling price"
contributor: "graphify"
outcome: "corrected"
correction: "The app reconstructs selling prices but does not currently use them consistently: the displayed COST and exact optimizer still use market prices for rising owned players."
source_nodes: ["budget.ts", "optimizer.ts"]
---

# Q: but if the players price increases it does not reflect the actual selling price

## Answer

Expanded via graph vocab: [current, price, entry, history, budget, value, player, squad]. The import reconstruction retains purchase prices and computes official selling values, but TerminalApp's COST metric sums each selected player's current market price. The exact optimizer also prices every selected player at current market price even when an imported owned player should consume only their selling value. Therefore rising players display and optimize against the wrong cost despite an accurate transfer baseline. The correction is to derive imported owned-player costs with sellingPriceTenths(purchase,current), use that for the displayed squad sell value, and pass player-specific costs into the exact optimizer while new players remain priced at market.

## Outcome

- Signal: corrected
- Correction: The app reconstructs selling prices but does not currently use them consistently: the displayed COST and exact optimizer still use market prices for rising owned players.

## Source Nodes

- budget.ts
- optimizer.ts