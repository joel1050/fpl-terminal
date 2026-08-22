---
type: "query"
date: "2026-08-21T06:41:36.322395+00:00"
question: "How does TerminalApp compose the player universe squad weekly lineup analysis and analyst panels while preserving API store and projection behavior?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["PlayerUniverse", "weeklyLineup.ts", "pickWeeklyTeam", "TerminalApp"]
---

# Q: How does TerminalApp compose the player universe squad weekly lineup analysis and analyst panels while preserving API store and projection behavior?

## Answer

TerminalApp owns all frontend composition and behavior in components/terminal/TerminalApp.tsx; the visual shell can be changed safely through app/globals.css plus ModeChooser markup without touching projection, API, optimizer, store, or weekly lineup modules.

## Outcome

- Signal: useful

## Source Nodes

- PlayerUniverse
- weeklyLineup.ts
- pickWeeklyTeam
- TerminalApp