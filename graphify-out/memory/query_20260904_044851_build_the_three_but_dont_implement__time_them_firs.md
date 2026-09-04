---
type: "query"
date: "2026-09-04T04:48:51.154071+00:00"
question: "build the three but dont implement, time them first for each horizon"
contributor: "graphify"
outcome: "useful"
source_nodes: ["optimizer.ts", "weeklyLineup.ts", "expectedAutosubValue", "probabilityDidNotPlay", "objective.ts", "value.ts"]
---

# Q: build the three but dont implement, time them first for each horizon

## Answer

Expanded from original query via vocab: [optimizer, bench, autosub, probability, objective,?]. Prototyped outside app code on the live 652-player GW3 pool with warmed HiGHS. CHEAP used three lexicographic solves: starting/captain xP, minimum reserve spend, then maximum reserve value at that spend. BALANCED used two solves: starter-only calibration followed by a DNP-derived linear autosub surrogate. STRONG used one solve with an extra first-bench binary per outfield player per week, modeling one guaranteed outfield replacement. Warm single-run times in ms for horizons 1/3/5/10: CHEAP 2362/1454/12131/37616; BALANCED 269/2245/6828/11341; STRONG 215/3499/10145/4242. MILP branching caused non-monotonic timings. The disposable script was removed and no application code was changed. Outcome: naive CHEAP is too slow at long horizons; BALANCED needs a one-pass coefficient precomputation or other simplification before implementation; STRONG changes the objective away from expected points and has variable solve behavior.

## Outcome

- Signal: useful

## Source Nodes

- optimizer.ts
- weeklyLineup.ts
- expectedAutosubValue
- probabilityDidNotPlay
- objective.ts
- value.ts