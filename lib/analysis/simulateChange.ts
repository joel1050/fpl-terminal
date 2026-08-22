import type { ProposedMove, SimulationResult } from "../../types/analysis";
import type { SquadState } from "../../types/squad";
import type { Player } from "../../types/player";
import { analyzeSquad, type AnalyzeSquadOptions } from "./analyzeSquad";
import { asPlayers, costOf, legalSquad, playerMap, type PlayerUniverse, type SquadReference } from "./context";
import { budgetFeasibility } from "./replacements";

export interface SimulateChangeInput extends AnalyzeSquadOptions {
  squad: SquadReference;
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
  const projectedDeltaGW = after.projectedNextGW - before.projectedNextGW;
  const projectedDelta3 = after.projectedNext3 - before.projectedNext3;
  const projectedDelta5 = after.projectedNext5 - before.projectedNext5;
  if (priceDeltaTenths > 0) explanationFactors.push(`Costs ${(priceDeltaTenths / 10).toFixed(1)}m more.`);
  if (priceDeltaTenths < 0) explanationFactors.push(`Releases ${(-priceDeltaTenths / 10).toFixed(1)}m.`);
  if (projectedDelta5 > 0) explanationFactors.push(`Adds ${projectedDelta5.toFixed(1)} projected points over five gameweeks.`);
  if (projectedDelta5 < 0) explanationFactors.push(`Loses ${(-projectedDelta5).toFixed(1)} projected points over five gameweeks.`);
  explanationFactors.push(...legality.errors);
  if (afterIds.length < 15 && !feasibility.feasible) explanationFactors.push("The partial squad cannot be completed within the remaining budget.");
  if (!explanationFactors.length) explanationFactors.push("No material model change was detected.");
  return {
    before,
    after,
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
