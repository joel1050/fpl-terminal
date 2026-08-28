import type { Player, Position } from "../../types/player";
import type { SquadState } from "../../types/squad";
import type { SquadAnalysis } from "../../types/analysis";
import type { Horizon } from "../../types/projection";
import { analyzeSquad } from "../analysis/analyzeSquad";
import {
  asPlayers,
  clubCounts,
  costOf,
  DEFAULT_BUDGET_TENTHS,
  DEFAULT_MAX_PLAYERS_PER_CLUB,
  legalSquad,
  normalizeSquad,
  playerMap,
  POSITIONS,
  POSITION_MINIMUMS,
  utilityValue,
  type CommonOptions,
  type PlayerUniverse,
  type SquadReference,
} from "../analysis/context";

export interface OptimizerInput extends CommonOptions {
  /** Gameweek the squad is being planned for; defaults to the first projected one. */
  gameweek?: number;
  players?: PlayerUniverse;
  playerPool?: PlayerUniverse;
  squad?: SquadReference;
  currentSquad?: SquadReference;
  beamWidth?: number;
  candidateLimit?: number;
}

export interface OptimizerResult {
  legal: boolean;
  squad?: SquadState;
  playerIds: number[];
  analysis?: SquadAnalysis;
  score?: number;
  errors: string[];
  warnings: string[];
}

interface CandidateState {
  ids: number[];
  cost: number;
  score: number;
}

const BACKUP_GOALKEEPER_WEIGHT = 0.05;
const BACKUP_GOALKEEPER_PRICE_DIVISOR = 20;

function currentIds(input: OptimizerInput): number[] {
  const value = input.currentSquad ?? input.squad;
  if (!value) return [];
  return Array.isArray(value) ? value.map((item) => typeof item === "number" ? item : item.id) : [...(value as SquadState).playerIds];
}

function buildSquad(ids: readonly number[], players: Map<number, Player>): SquadState {
  return normalizeSquad(ids, players);
}

function failure(ids: readonly number[], errors: string[], players: Map<number, Player>): OptimizerResult {
  return { legal: false, playerIds: [...ids], squad: buildSquad(ids, players), errors, warnings: [] };
}

function constructionScore(
  ids: readonly number[],
  players: ReadonlyMap<number, Player>,
  horizon: Horizon,
  risk: CommonOptions["risk"],
): number {
  const goalkeepers = ids
    .map((id) => players.get(id))
    .filter((player): player is Player => player?.position === "GK")
    .sort((a, b) => utilityValue(b, horizon, risk) - utilityValue(a, horizon, risk));
  const outfield = ids
    .map((id) => players.get(id))
    .filter((player): player is Player => player !== undefined && player.position !== "GK");
  return outfield.reduce((sum, player) => sum + utilityValue(player, horizon, risk), 0)
    + (goalkeepers[0] ? utilityValue(goalkeepers[0], horizon, risk) : 0)
    + goalkeepers.slice(1).reduce(
      (sum, player) => sum + utilityValue(player, horizon, risk) * BACKUP_GOALKEEPER_WEIGHT - player.priceTenths / BACKUP_GOALKEEPER_PRICE_DIVISOR,
      0,
    );
}

export function candidatePool(
  players: readonly Player[],
  position: Position,
  options: OptimizerInput,
  fixed: ReadonlySet<number>,
): Player[] {
  // ponytail: prune to ranked plus cheap candidates; widen only if this ever
  // misses a legal high-value squad in a materially larger universe.
  const limit = options.candidateLimit ?? 20;
  const excluded = new Set(options.excludedPlayerIds ?? []);
  const risk = options.risk ?? options.strategy?.risk ?? "BALANCED";
  const horizon = options.horizon ?? options.strategy?.horizon ?? 5;
  const available = players.filter((player) => player.position === position && (!excluded.has(player.id) || fixed.has(player.id)));
  const ranked = [...available].sort((a, b) => {
    const utility = utilityValue(b, horizon, risk) - utilityValue(a, horizon, risk);
    return utility || a.priceTenths - b.priceTenths || a.id - b.id;
  });
  const cheap = [...available].sort((a, b) => a.priceTenths - b.priceTenths || a.id - b.id);
  const selected = new Map<number, Player>();
  for (const player of [...ranked.slice(0, limit), ...cheap.slice(0, Math.max(8, Math.floor(limit / 2))), ...available.filter((player) => fixed.has(player.id))]) selected.set(player.id, player);
  return [...selected.values()].sort((a, b) => a.id - b.id);
}

function minimumCheapCost(
  remaining: readonly Position[],
  pools: ReadonlyMap<Position, readonly Player[]>,
  selected: ReadonlySet<number>,
): number | undefined {
  const positions = [...remaining].sort((a, b) => (pools.get(a)?.length ?? 0) - (pools.get(b)?.length ?? 0));
  const used = new Set(selected);
  let total = 0;
  for (const position of positions) {
    const candidate = (pools.get(position) ?? [])
      // Keep this as a lower bound; enforcing clubs here could prune a legal
      // combination because a greedy club assignment was expensive.
      .filter((player) => !used.has(player.id))
      .sort((a, b) => a.priceTenths - b.priceTenths || a.id - b.id)[0];
    if (!candidate) return undefined;
    used.add(candidate.id);
    total += candidate.priceTenths;
  }
  return total;
}

function beamConstruct(
  fixedIds: readonly number[],
  players: readonly Player[],
  options: OptimizerInput,
): CandidateState | undefined {
  const map = playerMap(players);
  const budget = options.budgetTenths ?? DEFAULT_BUDGET_TENTHS;
  const maxPerClub = options.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB;
  const positions: Position[] = [];
  const fixedCounts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const id of fixedIds) {
    const position = map.get(id)?.position;
    if (position) fixedCounts[position] += 1;
  }
  for (const position of POSITIONS) for (let i = fixedCounts[position]; i < POSITION_MINIMUMS[position]; i += 1) positions.push(position);
  const fixed = new Set(fixedIds);
  const pools = new Map<Position, Player[]>(POSITIONS.map((position) => [position, candidatePool(players, position, options, fixed)]));
  const horizon = options.horizon ?? options.strategy?.horizon ?? 5;
  const risk = options.risk ?? options.strategy?.risk ?? "BALANCED";
  let states: CandidateState[] = [{ ids: [...fixedIds], cost: costOf(fixedIds, map), score: constructionScore(fixedIds, map, horizon, risk) }];
  for (let slotIndex = 0; slotIndex < positions.length; slotIndex += 1) {
    const position = positions[slotIndex];
    const next: CandidateState[] = [];
    for (const state of states) {
      const selected = new Set(state.ids);
      const clubs = clubCounts(state.ids, map);
      for (const player of pools.get(position) ?? []) {
        if (selected.has(player.id)) continue;
        if ((clubs.get(player.teamId) ?? 0) >= maxPerClub) continue;
        const cost = state.cost + player.priceTenths;
        if (cost > budget) continue;
        const remaining = positions.slice(slotIndex + 1);
        const ids = [...state.ids, player.id];
        const minimum = minimumCheapCost(remaining, pools, new Set([...selected, player.id]));
        if (minimum === undefined || cost + minimum > budget) continue;
        next.push({ ids, cost, score: constructionScore(ids, map, horizon, risk) });
      }
    }
    const width = Math.max(24, options.beamWidth ?? 120);
    next.sort((a, b) => b.score - a.score || a.cost - b.cost || a.ids.join(",").localeCompare(b.ids.join(",")));
    states = next.slice(0, width);
    if (!states.length) return undefined;
  }
  const complete = states
    .filter((state) => legalSquad(state.ids, map, { budgetTenths: budget, maxPlayersPerClub: maxPerClub }).legal)
    .sort((a, b) => objectiveScore(b.ids, map, options) - objectiveScore(a.ids, map, options) || a.cost - b.cost);
  return complete[0];
}

function objectiveScore(ids: readonly number[], players: Map<number, Player>, options: OptimizerInput): number {
  const horizon = options.horizon ?? options.strategy?.horizon ?? 5;
  const risk = options.risk ?? options.strategy?.risk ?? "BALANCED";
  const bench = options.bench ?? options.strategy?.bench;
  const analysis = analyzeSquad({ squad: ids, players, horizon, risk, bench, budgetTenths: options.budgetTenths, maxPlayersPerClub: options.maxPlayersPerClub });
  const outfieldBenchWeights = [0.25, 0.15, 0.1];
  const startingSet = new Set(analysis.startingXI);
  let score = analysis.startingXI.reduce((sum, id) => sum + utilityValue(players.get(id)!, horizon, risk), 0);
  let outfieldIndex = 0;
  analysis.bench.forEach((id) => {
    const player = players.get(id)!;
    if (player.position === "GK") {
      score += utilityValue(player, horizon, risk) * BACKUP_GOALKEEPER_WEIGHT - player.priceTenths / BACKUP_GOALKEEPER_PRICE_DIVISOR;
    } else {
      score += utilityValue(player, horizon, risk) * (outfieldBenchWeights[outfieldIndex] ?? 0.1);
      outfieldIndex += 1;
    }
  });
  // Slightly prefer a healthy, high-confidence solution when projections tie.
  score += [...startingSet].reduce((sum, id) => sum + (players.get(id)?.projection?.confidence === "HIGH" ? 0.01 : 0), 0);
  if (bench === "CHEAP") score -= analysis.bench.reduce((sum, id) => sum + (players.get(id)?.priceTenths ?? 0), 0) / 10000;
  if (bench === "STRONG") score += analysis.bench.reduce((sum, id) => sum + utilityValue(players.get(id)!, horizon, risk), 0) * 0.04;
  return score;
}

function optimize(input: OptimizerInput, fixedIds: readonly number[]): OptimizerResult {
  const players = asPlayers(input.players ?? input.playerPool ?? []);
  const map = playerMap(players);
  const uniqueFixed = [...new Set(fixedIds)];
  const locked = new Set(input.lockedPlayerIds ?? []);
  const errors: string[] = [];
  const excluded = new Set(input.excludedPlayerIds ?? []);
  for (const id of uniqueFixed) if (!map.has(id)) errors.push(`Player ${id} is not in the player universe.`);
  for (const id of uniqueFixed) if (excluded.has(id)) errors.push(`Player ${id} is excluded.`);
  const fixedValidation = legalSquad(uniqueFixed, map, { budgetTenths: input.budgetTenths ?? DEFAULT_BUDGET_TENTHS, maxPlayersPerClub: input.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB, excludedPlayerIds: [] });
  for (const error of fixedValidation.errors) {
    if (error.startsWith("Squad must contain 15") || /requires \d+ players \(received/.test(error)) continue;
    errors.push(error);
  }
  if (errors.length) return failure(uniqueFixed, errors, map);
  const solution = beamConstruct(uniqueFixed, players, input);
  if (!solution) return failure(uniqueFixed, ["No legal squad satisfies the current budget, position, club, lock, or exclusion constraints."], map);
  const validation = legalSquad(solution.ids, map, { budgetTenths: input.budgetTenths ?? DEFAULT_BUDGET_TENTHS, maxPlayersPerClub: input.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB, excludedPlayerIds: input.excludedPlayerIds });
  if (!validation.legal) return failure(uniqueFixed, validation.errors, map);
  const squad = buildSquad(solution.ids, map);
  const analysis = analyzeSquad({ squad, players, horizon: input.horizon, risk: input.risk, bench: input.bench, budgetTenths: input.budgetTenths, maxPlayersPerClub: input.maxPlayersPerClub, excludedPlayerIds: input.excludedPlayerIds, lockedPlayerIds: [...locked] });
  return { legal: true, squad, playerIds: [...solution.ids], analysis, score: objectiveScore(solution.ids, map, input), errors: [], warnings: analysis.structuralWarnings };
}

export function optimizeFullSquad(input: OptimizerInput): OptimizerResult {
  const ids = currentIds(input);
  const locked = input.lockedPlayerIds ?? [];
  const fixed = locked.length ? locked : ids.length < 15 ? ids : [];
  return optimize(input, fixed);
}

export function completePartialSquad(input: OptimizerInput): OptimizerResult {
  return optimize(input, currentIds(input));
}

export function optimizeAroundLockedPlayers(input: OptimizerInput): OptimizerResult {
  return optimize(input, input.lockedPlayerIds ?? []);
}

export function optimizeAroundPlayer(playerId: number, input: OptimizerInput): OptimizerResult {
  const locks = [...new Set([...(input.lockedPlayerIds ?? []), playerId])];
  return optimize({ ...input, lockedPlayerIds: locks }, locks);
}

export function optimizeStartingXI(input: OptimizerInput): { playerIds: number[]; captainId?: number; viceCaptainId?: number; bench: number[] } {
  const result = input.squad || input.currentSquad ? analyzeSquad({ squad: input.squad ?? input.currentSquad!, players: input.players ?? input.playerPool, horizon: input.horizon, risk: input.risk, bench: input.bench }) : optimizeFullSquad(input).analysis;
  if (!result) return { playerIds: [], bench: [] };
  const map = playerMap(input.players ?? input.playerPool ?? []);
  const horizon = input.horizon ?? input.strategy?.horizon ?? 5;
  const risk = input.risk ?? input.strategy?.risk ?? "BALANCED";
  const sorted = [...result.startingXI].sort((a, b) => utilityValue(map.get(b)!, horizon, risk) - utilityValue(map.get(a)!, horizon, risk) || a - b);
  return { playerIds: result.startingXI, captainId: sorted[0], viceCaptainId: sorted[1], bench: result.bench };
}

export default optimizeFullSquad;
