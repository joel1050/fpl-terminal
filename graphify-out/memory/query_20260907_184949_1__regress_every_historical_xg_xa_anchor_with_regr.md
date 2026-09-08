---
type: "query"
date: "2026-09-07T18:49:49.313215+00:00"
question: "1. Regress every historical xG/xA anchor with regressPer90(historical.rate, historical.minutes, pricePrior, 900) before passing it to blendPlayerRate. 2. Keep generic price priors league-neutral so the upcoming team-strength multiplier still lowers players from weak attacks. 3. For transferred players, normalize historical production using their former team’s strength, rather than their current club. 4. Tie RotoWire evidence to the projected fixture/Gameweek. Previous-GW confirmed teams should feed role history, not act as next-GW predictions. 5. Let current-season starts update expected start duration; Isak’s 81 minutes per match shouldn’t still produce a 62-minute forecast. apply these changes"
contributor: "graphify"
outcome: "useful"
source_nodes: ["projectPlayer.ts", "enrichPlayers.ts", "rotowireMapping.ts", "selection.ts"]
---

# Q: 1. Regress every historical xG/xA anchor with regressPer90(historical.rate, historical.minutes, pricePrior, 900) before passing it to blendPlayerRate. 2. Keep generic price priors league-neutral so the upcoming team-strength multiplier still lowers players from weak attacks. 3. For transferred players, normalize historical production using their former team’s strength, rather than their current club. 4. Tie RotoWire evidence to the projected fixture/Gameweek. Previous-GW confirmed teams should feed role history, not act as next-GW predictions. 5. Let current-season starts update expected start duration; Isak’s 81 minutes per match shouldn’t still produce a 62-minute forecast. apply these changes

## Answer

Expanded from original query via vocab: [project, player, expected, minutes, fixture, selection, historical, rate, regression, rotowire, mapping, strength]. Implemented regressed historical xG/xA anchors, neutral generic price priors, former-team strength normalization, fixture-scoped RotoWire selection using the earliest unfinished Gameweek, and current-season start-duration updates. Focused tests, typecheck, targeted lint, and production build pass.

## Outcome

- Signal: useful

## Source Nodes

- projectPlayer.ts
- enrichPlayers.ts
- rotowireMapping.ts
- selection.ts