import loadHighs from "highs";

import type { Player, Position } from "@/types/player";
import type { OptimizerInput, OptimizerResult } from "./optimizer";
import { analyzeSquad } from "@/lib/analysis/analyzeSquad";
import {
  asPlayers,
  DEFAULT_BUDGET_TENTHS,
  DEFAULT_MAX_PLAYERS_PER_CLUB,
  idsFromSquad,
  legalSquad,
  normalizeSquad,
  playerMap,
  POSITIONS,
  POSITION_MINIMUMS,
  horizonValue,
  utilityValue,
} from "@/lib/analysis/context";

export interface ExactOptimizerResult extends OptimizerResult {
  optimal?: true;
  solver?: "HIGHS";
  objective?: number;
  captainsByGameweek?: Array<{ gameweek: number; playerId: number }>;
}

const STARTER_MINIMUMS: Record<Position, number> = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
const highsPromise = loadHighs();

function idsFromInput(input: OptimizerInput): number[] {
  return idsFromSquad(input.currentSquad ?? input.squad);
}

function term(coefficient: number, variable: string): string {
  const sign = coefficient < 0 ? "-" : "+";
  return `${sign} ${Math.abs(coefficient).toFixed(8)} ${variable}`;
}

function expression(terms: Array<[number, string]>): string {
  return terms.filter(([coefficient]) => Math.abs(coefficient) > 1e-12).map(([coefficient, variable]) => term(coefficient, variable)).join(" ") || "0";
}

function exactFailure(ids: readonly number[], players: Map<number, Player>, errors: string[]): ExactOptimizerResult {
  return { legal: false, playerIds: [...ids], squad: normalizeSquad(ids, players), errors, warnings: [] };
}

async function solveExact(input: OptimizerInput, fixedIds: readonly number[]): Promise<ExactOptimizerResult> {
  const allPlayers = asPlayers(input.players ?? input.playerPool ?? []).sort((a, b) => a.id - b.id);
  const map = playerMap(allPlayers);
  const fixed = [...new Set(fixedIds)];
  const excluded = new Set(input.excludedPlayerIds ?? []);
  const errors: string[] = [];
  for (const id of fixed) {
    if (!map.has(id)) errors.push(`Player ${id} is not in the player universe.`);
    if (excluded.has(id)) errors.push(`Player ${id} is excluded.`);
  }
  const fixedValidation = legalSquad(fixed, map, {
    budgetTenths: input.budgetTenths ?? DEFAULT_BUDGET_TENTHS,
    maxPlayersPerClub: input.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB,
  });
  for (const error of fixedValidation.errors) {
    if (error.startsWith("Squad must contain 15") || /requires \d+ players \(received/.test(error)) continue;
    errors.push(error);
  }
  if (errors.length) return exactFailure(fixed, map, errors);

  const players = allPlayers.filter((player) => !excluded.has(player.id));
  const horizon = input.horizon ?? input.strategy?.horizon ?? 5;
  const risk = input.risk ?? input.strategy?.risk ?? "BALANCED";
  const bench = input.bench ?? input.strategy?.bench ?? "BALANCED";
  const budget = input.budgetTenths ?? DEFAULT_BUDGET_TENTHS;
  const maxPerClub = input.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB;
  const gameweeks = [...new Set(players.flatMap((player) => player.projection?.fixtures.map((fixture) => fixture.gameweek) ?? []))].sort((a, b) => a - b).slice(0, horizon);
  const objective: Array<[number, string]> = [];
  const binaries: string[] = [];
  const bounds: string[] = [];
  const constraints: string[] = [];
  const squad = (id: number) => `x_${id}`;
  const starter = (id: number) => `s_${id}`;
  const goalkeeperBench = (id: number) => `g_${id}`;
  const benchRole = (slot: number, id: number) => `b${slot}_${id}`;
  const captain = (gameweek: number, id: number) => `c${gameweek}_${id}`;
  const utilities = new Map(players.map((player) => [player.id, utilityValue(player, horizon, risk)]));

  for (const player of players) {
    const variables = [squad(player.id), starter(player.id), goalkeeperBench(player.id), benchRole(1, player.id), benchRole(2, player.id), benchRole(3, player.id)];
    binaries.push(...variables);
    const utility = utilities.get(player.id) ?? 0;
    objective.push([utility + (player.projection?.confidence === "HIGH" ? 0.01 : 0), starter(player.id)]);
    objective.push([utility * 0.05 - player.priceTenths / 20 - (bench === "CHEAP" ? player.priceTenths / 10000 : 0) + (bench === "STRONG" ? utility * 0.04 : 0), goalkeeperBench(player.id)]);
    [0.25, 0.15, 0.1].forEach((weight, index) => objective.push([
      utility * weight - (bench === "CHEAP" ? player.priceTenths / 10000 : 0) + (bench === "STRONG" ? utility * 0.04 : 0),
      benchRole(index + 1, player.id),
    ]));
    constraints.push(`assign_${player.id}: ${expression([[-1, squad(player.id)], [1, starter(player.id)], [1, goalkeeperBench(player.id)], [1, benchRole(1, player.id)], [1, benchRole(2, player.id)], [1, benchRole(3, player.id)]])} = 0`);
    if (player.position === "GK") {
      for (let slot = 1; slot <= 3; slot += 1) bounds.push(`${benchRole(slot, player.id)} = 0`);
    } else {
      bounds.push(`${goalkeeperBench(player.id)} = 0`);
    }
    const rawHorizon = horizonValue(player, horizon);
    const multiplier = rawHorizon && rawHorizon > 0 ? utility / rawHorizon : 0;
    for (const gameweek of gameweeks) {
      const variable = captain(gameweek, player.id);
      binaries.push(variable);
      const points = player.projection?.fixtures.filter((fixture) => fixture.gameweek === gameweek).reduce((sum, fixture) => sum + fixture.expectedPoints, 0) ?? 0;
      objective.push([points * multiplier, variable]);
      constraints.push(`captain_starter_${gameweek}_${player.id}: ${expression([[1, variable], [-1, starter(player.id)]])} <= 0`);
    }
  }

  constraints.push(`squad_size: ${expression(players.map((player) => [1, squad(player.id)]))} = 15`);
  constraints.push(`starter_size: ${expression(players.map((player) => [1, starter(player.id)]))} = 11`);
  constraints.push(`goalkeeper_bench_size: ${expression(players.map((player) => [1, goalkeeperBench(player.id)]))} = 1`);
  for (let slot = 1; slot <= 3; slot += 1) constraints.push(`bench_${slot}_size: ${expression(players.map((player) => [1, benchRole(slot, player.id)]))} = 1`);
  constraints.push(`budget: ${expression(players.map((player) => [player.priceTenths, squad(player.id)]))} <= ${budget}`);
  for (const position of POSITIONS) {
    const members = players.filter((player) => player.position === position);
    constraints.push(`squad_${position}: ${expression(members.map((player) => [1, squad(player.id)]))} = ${POSITION_MINIMUMS[position]}`);
    constraints.push(`starters_${position}: ${expression(members.map((player) => [1, starter(player.id)]))} >= ${STARTER_MINIMUMS[position]}`);
    if (position === "GK") constraints.push(`starter_gk_max: ${expression(members.map((player) => [1, starter(player.id)]))} <= 1`);
  }
  for (const teamId of new Set(players.map((player) => player.teamId))) {
    const members = players.filter((player) => player.teamId === teamId);
    constraints.push(`club_${teamId}: ${expression(members.map((player) => [1, squad(player.id)]))} <= ${maxPerClub}`);
  }
  for (const id of fixed) constraints.push(`fixed_${id}: ${squad(id)} = 1`);
  for (const gameweek of gameweeks) constraints.push(`captain_${gameweek}: ${expression(players.map((player) => [1, captain(gameweek, player.id)]))} = 1`);

  const lp = [
    "Maximize",
    ` objective: ${expression(objective)}`,
    "Subject To",
    ...constraints.map((constraint) => ` ${constraint}`),
    "Bounds",
    ...bounds.map((bound) => ` ${bound}`),
    "Binary",
    ...binaries.map((variable) => ` ${variable}`),
    "End",
  ].join("\n");
  const highs = await highsPromise;
  const result = highs.solve(lp, { output_flag: false, log_to_console: false, mip_rel_gap: 0, presolve: "on", random_seed: 0 });
  if (result.Status !== "Optimal") return exactFailure(fixed, map, [`Exact optimizer returned ${result.Status}.`]);
  const selectedIds = players.filter((player) => result.Columns[squad(player.id)]?.Primal > 0.5).map((player) => player.id);
  const validation = legalSquad(selectedIds, map, { budgetTenths: budget, maxPlayersPerClub: maxPerClub, excludedPlayerIds: input.excludedPlayerIds });
  if (!validation.legal) return exactFailure(fixed, map, validation.errors);
  const normalized = normalizeSquad(selectedIds, map);
  const analysis = analyzeSquad({ squad: normalized, players: allPlayers, horizon, risk, bench, budgetTenths: budget, maxPlayersPerClub: maxPerClub });
  return {
    legal: true,
    squad: normalized,
    playerIds: selectedIds,
    analysis,
    score: result.ObjectiveValue,
    objective: result.ObjectiveValue,
    optimal: true,
    solver: "HIGHS",
    captainsByGameweek: gameweeks.map((gameweek) => ({
      gameweek,
      playerId: players.find((player) => result.Columns[captain(gameweek, player.id)]?.Primal > 0.5)?.id ?? 0,
    })),
    errors: [],
    warnings: analysis.structuralWarnings,
  };
}

export function exactOptimizeFullSquad(input: OptimizerInput): Promise<ExactOptimizerResult> {
  const ids = idsFromInput(input);
  const locked = input.lockedPlayerIds ?? [];
  return solveExact(input, locked.length ? locked : ids.length < 15 ? ids : []);
}

export function exactCompletePartialSquad(input: OptimizerInput): Promise<ExactOptimizerResult> {
  return solveExact(input, idsFromInput(input));
}
