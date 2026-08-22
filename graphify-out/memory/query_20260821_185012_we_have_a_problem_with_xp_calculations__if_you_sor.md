---
type: "query"
date: "2026-08-21T18:50:12.393862+00:00"
question: "we have a problem with xp calculations, if you sort by xp/pound you see a lot of bottom tier team players/defenders having a fairly high xp, there is something wrong diagnose the issue i think the problem is with clean sheet calculations for all teams"
contributor: "graphify"
outcome: "useful"
source_nodes: ["fixtureAdjustment.ts", "projectPlayer", "deriveTeamStrengths", "valuePerMillion", "buildPlayerSelections"]
---

# Q: we have a problem with xp calculations, if you sort by xp/pound you see a lot of bottom tier team players/defenders having a fairly high xp, there is something wrong diagnose the issue i think the problem is with clean sheet calculations for all teams

## Answer

Expansion trace: [project, projection, fixture, adjustment, clean, sheet, expected, points, value, player, strength, team]. Diagnosis: cheap bottom-tier defenders rank highly mainly because raw xP per full price rewards fixed appearance points, predicted RotoWire starters receive 0.90 start probability even without history, and no-history defenders receive generic xG/xA/defensive-contribution priors. The clean-sheet model is a secondary source of error: manual 1-5 consensus ratings overwrite distinct attack/defence and home/away strengths, and fixture difficulty no longer affects clean-sheet probability once strengths exist. Live decomposition showed Coventry defenders get 3.114 of 17.693 xP from clean sheets but 9.25 from appearance and 5.18 from generic attacking/defensive priors.

## Outcome

- Signal: useful

## Source Nodes

- fixtureAdjustment.ts
- projectPlayer
- deriveTeamStrengths
- valuePerMillion
- buildPlayerSelections