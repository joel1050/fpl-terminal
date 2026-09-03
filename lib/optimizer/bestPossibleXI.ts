import loadHighs from "highs";

import type { Position } from "@/types/player";
import { isLegalStartingXI, weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import {
  asPlayers,
  clubCounts,
  costOf,
  DEFAULT_BUDGET_TENTHS,
  DEFAULT_MAX_PLAYERS_PER_CLUB,
  playerMap,
  POSITIONS,
  POSITION_MINIMUMS,
  type PlayerUniverse,
} from "@/lib/analysis/context";

/** Same formation rule the weekly lineup engine applies: 1 GK and the position minimums. */
const STARTER_MINIMUMS: Record<Position, number> = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
const XI_SIZE = 11;

export interface BestPossibleXIInput {
  players: PlayerUniverse;
  gameweek: number;
  budgetTenths?: number;
  maxPlayersPerClub?: number;
}

export interface BestPossibleXIResult {
  legal: boolean;
  playerIds: number[];
  costTenths: number;
  projectedXI: number;
  captainId: number;
  captainBonus: number;
  projectedTotal: number;
  solver?: "HIGHS";
  errors: string[];
}

const highsPromise = loadHighs();

function term(coefficient: number, variable: string): string {
  const sign = coefficient < 0 ? "-" : "+";
  return `${sign} ${Math.abs(coefficient).toFixed(8)} ${variable}`;
}

function expression(terms: Array<[number, string]>): string {
  return terms.filter(([coefficient]) => Math.abs(coefficient) > 1e-12).map(([coefficient, variable]) => term(coefficient, variable)).join(" ") || "0";
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function failure(errors: string[]): BestPossibleXIResult {
  return { legal: false, playerIds: [], costTenths: 0, projectedXI: 0, captainId: 0, captainBonus: 0, projectedTotal: 0, errors };
}

/**
 * Solves for the highest-scoring legal XI backed by a legal 15-player squad.
 * Used as the ceiling in the squad builder's team rating, so substitutes consume
 * budget and club slots even though their points are left out on both sides.
 */
export async function exactBestPossibleXI(input: BestPossibleXIInput): Promise<BestPossibleXIResult> {
  const players = asPlayers(input.players).sort((a, b) => a.id - b.id);
  const map = playerMap(players);
  const budget = input.budgetTenths ?? DEFAULT_BUDGET_TENTHS;
  const maxPerClub = input.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB;
  if (players.length < 15) return failure(["The player universe cannot produce a complete squad."]);
  for (const position of POSITIONS) {
    if (players.filter((player) => player.position === position).length < POSITION_MINIMUMS[position]) {
      return failure([`The player universe has no legal ${position} options for a complete squad.`]);
    }
  }

  const points = new Map(players.map((player) => [player.id, Math.max(0, weeklyPlayerMetrics(player, input.gameweek).points)]));
  const squad = (id: number) => `q_${id}`;
  const starter = (id: number) => `x_${id}`;
  const captain = (id: number) => `c_${id}`;
  const objective: Array<[number, string]> = [];
  const constraints: string[] = [];
  const binaries: string[] = [];

  for (const player of players) {
    const value = points.get(player.id) ?? 0;
    binaries.push(squad(player.id), starter(player.id), captain(player.id));
    objective.push([value, starter(player.id)], [value, captain(player.id)]);
    constraints.push(`starter_squad_${player.id}: ${expression([[1, starter(player.id)], [-1, squad(player.id)]])} <= 0`);
    constraints.push(`captain_starter_${player.id}: ${expression([[1, captain(player.id)], [-1, starter(player.id)]])} <= 0`);
  }

  constraints.push(`squad_size: ${expression(players.map((player) => [1, squad(player.id)]))} = 15`);
  constraints.push(`xi_size: ${expression(players.map((player) => [1, starter(player.id)]))} = ${XI_SIZE}`);
  constraints.push(`captain_size: ${expression(players.map((player) => [1, captain(player.id)]))} = 1`);
  for (const position of POSITIONS) {
    const members = players.filter((player) => player.position === position);
    constraints.push(`squad_${position}: ${expression(members.map((player) => [1, squad(player.id)]))} = ${POSITION_MINIMUMS[position]}`);
    constraints.push(`starters_${position}: ${expression(members.map((player) => [1, starter(player.id)]))} >= ${STARTER_MINIMUMS[position]}`);
    // Only the goalkeeper slot is capped: eleven players and the outfield
    // minimums already bound defenders, midfielders, and forwards.
    if (position === "GK") constraints.push(`starters_GK_max: ${expression(members.map((player) => [1, starter(player.id)]))} <= 1`);
  }
  constraints.push(`budget: ${expression(players.map((player) => [player.priceTenths, squad(player.id)]))} <= ${budget}`);
  for (const teamId of new Set(players.map((player) => player.teamId))) {
    const members = players.filter((player) => player.teamId === teamId);
    if (members.length <= maxPerClub) continue;
    constraints.push(`club_${teamId}: ${expression(members.map((player) => [1, squad(player.id)]))} <= ${maxPerClub}`);
  }

  const lp = [
    "Maximize",
    ` objective: ${expression(objective)}`,
    "Subject To",
    ...constraints.map((constraint) => ` ${constraint}`),
    "Binary",
    ...binaries.map((variable) => ` ${variable}`),
    "End",
  ].join("\n");

  const highs = await highsPromise;
  const result = highs.solve(lp, { output_flag: false, log_to_console: false, mip_rel_gap: 0, presolve: "on", random_seed: 0 });
  if (result.Status !== "Optimal") return failure([`Best possible XI solver returned ${result.Status}.`]);

  const selectedSquad = players.filter((player) => result.Columns[squad(player.id)]?.Primal > 0.5);
  const selected = players.filter((player) => result.Columns[starter(player.id)]?.Primal > 0.5);
  const ids = selected.map((player) => player.id);
  if (!isLegalStartingXI(selected)) return failure(["The best possible XI solver returned an illegal starting XI."]);
  const squadIds = selectedSquad.map((player) => player.id);
  const cost = costOf(squadIds, map);
  if (cost > budget) return failure([`The best possible XI costs ${cost} tenths and exceeds the ${budget}-tenths budget.`]);
  const clubs = clubCounts(squadIds, map);
  if ([...clubs.values()].some((count) => count > maxPerClub)) return failure(["The best possible XI breaks the club limit."]);

  const captainId = players.find((player) => result.Columns[captain(player.id)]?.Primal > 0.5)?.id ?? 0;
  const projectedXI = round(selected.reduce((sum, player) => sum + (points.get(player.id) ?? 0), 0));
  const captainBonus = round(points.get(captainId) ?? 0);
  return {
    legal: true,
    playerIds: ids,
    costTenths: cost,
    projectedXI,
    captainId,
    captainBonus,
    projectedTotal: round(projectedXI + captainBonus),
    solver: "HIGHS",
    errors: [],
  };
}

export default exactBestPossibleXI;
