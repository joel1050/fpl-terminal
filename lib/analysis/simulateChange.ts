import type { ProposedMove, SimulationResult } from "../../types/analysis";
import type { SquadState } from "../../types/squad";
import type { Player } from "../../types/player";
import { analyzeSquad, type AnalyzeSquadOptions } from "./analyzeSquad";
import { asPlayers, costOf, legalSquad, playerMap, type PlayerUniverse, type SquadReference } from "./context";
import { budgetFeasibility } from "./replacements";
import { projectWeeklyLineupHorizons } from "../squad/weeklyLineup";

export interface SimulateChangeInput extends AnalyzeSquadOptions {
  squad: SquadReference;
  gameweek?: number;
  players?: PlayerUniverse;
  playerPool?: PlayerUniverse;
  outId?: number;
  inId?: number;
  outgoingPlayerId?: number;
  incomingPlayerId?: number;
  addId?: number;
  lockPlayerId?: number;
}

function idsOf(squad: SquadReference): number[] {
  return Array.isArray(squad) ? squad.map((item) => typeof item === "number" ? item : item.id) : [...(squad as SquadState).playerIds];
}

function proposedSecondaryMoves(
  ids: readonly number[],
  players: readonly Player[],
  options: SimulateChangeInput,
): ProposedMove[] {
  const map = playerMap(players);
  const locked = new Set(options.lockedPlayerIds ?? []);
  const budget = options.budgetTenths ?? 1000;
  if (costOf(ids, map) <= budget) return [];
  const candidates: ProposedMove[] = [];
  for (const out of ids) {
    if (locked.has(out) || out === options.outId) continue;
    const player = map.get(out);
    if (!player) continue;
    const cheaper = players
      .filter((candidate) => candidate.position === player.position && !ids.includes(candidate.id) && candidate.priceTenths < player.priceTenths)
      .sort((a, b) => a.priceTenths - b.priceTenths || b.id - a.id)[0];
    if (cheaper) {
      candidates.push({ outId: out, inId: cheaper.id, priceDeltaTenths: cheaper.priceTenths - player.priceTenths, projectedDelta: 0 });
    }
  }
  return candidates.slice(0, 3);
}

export function simulateChange(input: SimulateChangeInput): SimulationResult {
  const fallbackPlayers = Array.isArray(input.squad) && input.squad.every((item) => typeof item !== "number") ? input.squad as readonly Player[] : [];
  const universe = asPlayers(input.players ?? input.playerPool ?? fallbackPlayers);
  const map = playerMap(universe);
  const beforeIds = idsOf(input.squad);
  const outId = input.outId ?? input.outgoingPlayerId;
  const inId = input.inId ?? input.incomingPlayerId ?? input.addId;
  const afterIds = [...beforeIds];
  const explanationFactors: string[] = [];
  if (outId !== undefined) {
    const index = afterIds.indexOf(outId);
    if (index >= 0 && inId !== undefined) afterIds[index] = inId;
    else if (index < 0) explanationFactors.push("The outgoing player is not in the squad.");
  } else if (inId !== undefined) {
    if (afterIds.includes(inId)) explanationFactors.push("The incoming player is already selected.");
    else afterIds.push(inId);
  } else {
    explanationFactors.push("No player change was provided.");
  }
  const before = analyzeSquad({ ...input, squad: beforeIds });
  const after = analyzeSquad({ ...input, squad: afterIds });
  const legality = legalSquad(afterIds, map, {
    budgetTenths: input.budgetTenths,
    maxPlayersPerClub: input.maxPlayersPerClub,
    excludedPlayerIds: input.excludedPlayerIds,
  });
  const feasibility = budgetFeasibility(afterIds, universe, input);
  const partialErrors = legality.errors.filter((error) => !error.startsWith("Squad must contain 15") && !/requires \d+ players \(received/.test(error));
  const legal = partialErrors.length === 0 && (afterIds.length === 15 ? legality.legal : feasibility.feasible);
  const priceDeltaTenths = costOf(afterIds, map) - costOf(beforeIds, map);
  const baselineLegal = legalSquad(beforeIds, map, {
    budgetTenths: input.budgetTenths,
    maxPlayersPerClub: input.maxPlayersPerClub,
    excludedPlayerIds: input.excludedPlayerIds,
  }).legal;
  const riskMode = input.risk ?? input.strategy?.risk ?? "BALANCED";
  const gameweek = input.gameweek ?? 1;
  const beforePlayers = beforeIds.map((id) => map.get(id)).filter((player): player is Player => Boolean(player));
  const afterPlayers = afterIds.map((id) => map.get(id)).filter((player): player is Player => Boolean(player));
  const beforeProjection = baselineLegal
    ? projectWeeklyLineupHorizons({ squad: beforePlayers, gameweek, riskMode })
    : { nextGW: before.projectedNextGW, next3: before.projectedNext3, next5: before.projectedNext5 };
  const afterProjection = legal
    ? projectWeeklyLineupHorizons({ squad: afterPlayers, gameweek, riskMode })
    : { nextGW: after.projectedNextGW, next3: after.projectedNext3, next5: after.projectedNext5 };
  const projectedDeltaGW = afterProjection.nextGW - beforeProjection.nextGW;
  const projectedDelta3 = afterProjection.next3 - beforeProjection.next3;
  const projectedDelta5 = afterProjection.next5 - beforeProjection.next5;
  const horizon = input.horizon ?? input.strategy?.horizon ?? 5;
  const optimizedBeforeXp = horizon === 1 ? beforeProjection.nextGW : horizon === 3 ? beforeProjection.next3 : beforeProjection.next5;
  const optimizedAfterXp = horizon === 1 ? afterProjection.nextGW : horizon === 3 ? afterProjection.next3 : afterProjection.next5;
  const projectedDelta = optimizedAfterXp - optimizedBeforeXp;
  if (priceDeltaTenths > 0) explanationFactors.push(`Costs ${(priceDeltaTenths / 10).toFixed(1)}m more.`);
  if (priceDeltaTenths < 0) explanationFactors.push(`Releases ${(-priceDeltaTenths / 10).toFixed(1)}m.`);
  if (projectedDelta > 0) explanationFactors.push(`Adds ${projectedDelta.toFixed(1)} optimized projected points over ${horizon} gameweek${horizon === 1 ? "" : "s"}.`);
  if (projectedDelta < 0) explanationFactors.push(`Loses ${(-projectedDelta).toFixed(1)} optimized projected points over ${horizon} gameweek${horizon === 1 ? "" : "s"}.`);
  explanationFactors.push(...legality.errors);
  if (afterIds.length < 15 && !feasibility.feasible) explanationFactors.push("The partial squad cannot be completed within the remaining budget.");
  if (!explanationFactors.length) explanationFactors.push("No material model change was detected.");
  return {
    before,
    after,
    horizon,
    optimizedBeforeXp,
    optimizedAfterXp,
    projectedDelta,
    priceDeltaTenths,
    projectedDeltaGW,
    projectedDelta3,
    projectedDelta5,
    requiredSecondaryMoves: proposedSecondaryMoves(afterIds, universe, input),
    legal,
    explanationFactors,
  };
}

export default simulateChange;
