import type { Player, Position } from "../../types/player";
import type { ReplacementCandidate } from "../../types/analysis";
import type { BudgetFeasibility } from "../../types/squad";
import {
  asPlayers,
  availabilityRisk,
  clubCounts,
  costOf,
  DEFAULT_BUDGET_TENTHS,
  DEFAULT_MAX_PLAYERS_PER_CLUB,
  expectedMinutes,
  formatPrice,
  hasAvailabilityRisk,
  horizonValue,
  playerMap,
  POSITION_MINIMUMS,
  POSITIONS,
  type SquadReference,
  utilityValue,
  type CommonOptions,
  type PlayerUniverse,
} from "./context";

export interface ReplacementRequest extends CommonOptions {
  outgoingPlayerId: number;
  squad: SquadReference;
  players?: PlayerUniverse;
  playerPool?: PlayerUniverse;
}

export interface SlotSuggestionRequest extends CommonOptions {
  position: Position;
  currentSquad: SquadReference;
  players?: PlayerUniverse;
  playerPool?: PlayerUniverse;
}

export interface BudgetRequest extends CommonOptions {
  squad: SquadReference;
  players?: PlayerUniverse;
  playerPool?: PlayerUniverse;
}

export interface RichReplacementCandidate extends ReplacementCandidate {
  ownership: number;
  fixtures: Player["fixtures"];
  valueNext5: number;
}

export type ReplacementList = RichReplacementCandidate[] & {
  maxAffordablePriceTenths?: number;
  minimumRequiredTenths?: number;
  message?: string;
};

function asList(candidates: RichReplacementCandidate[], metadata?: Partial<ReplacementList>): ReplacementList {
  const result = candidates as ReplacementList;
  if (metadata) Object.assign(result, metadata);
  return result;
}

function strategyOptions(options: CommonOptions): Required<Pick<CommonOptions, "horizon" | "risk" | "bench">> {
  return {
    horizon: options.horizon ?? options.strategy?.horizon ?? 5,
    risk: options.risk ?? options.strategy?.risk ?? "BALANCED",
    bench: options.bench ?? options.strategy?.bench ?? "BALANCED",
  };
}

function requestPlayers(request: { players?: PlayerUniverse; playerPool?: PlayerUniverse }): PlayerUniverse {
  return request.players ?? request.playerPool ?? [];
}

function playerEligible(
  player: Player,
  selected: ReadonlySet<number>,
  clubs: Map<number, number>,
  outgoingId: number | undefined,
  outgoingTeamId: number | undefined,
  options: CommonOptions,
): boolean {
  if (player.id === outgoingId) return false;
  if (selected.has(player.id) && player.id !== outgoingId) return false;
  if ((options.excludedPlayerIds ?? []).includes(player.id)) return false;
  const clubCount = clubs.get(player.teamId) ?? 0;
  if (clubCount - (outgoingTeamId === player.teamId ? 1 : 0) >= (options.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB)) return false;
  const risk = options.risk ?? options.strategy?.risk ?? "BALANCED";
  const availability = options.availability ?? options.strategy?.availability ?? (risk === "SAFE" ? "AVAILABLE" : "ANY");
  if (availability === "NAILED" && (hasAvailabilityRisk(player) || expectedMinutes(player) < 75)) return false;
  if (availability === "AVAILABLE" && hasAvailabilityRisk(player)) return false;
  if (risk === "SAFE" && (hasAvailabilityRisk(player) || (player.projection?.confidence === "LOW"))) return false;
  return true;
}

function cheapCompletionCost(
  currentIds: readonly number[],
  universe: readonly Player[],
  options: CommonOptions,
  excludedIds: ReadonlySet<number> = new Set(),
): number | undefined {
  if (!excludedIds.size && options.excludedPlayerIds?.length) excludedIds = new Set(options.excludedPlayerIds);
  const selected = new Set(currentIds);
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const id of currentIds) {
    const position = universe.find((player) => player.id === id)?.position;
    if (position) counts[position] += 1;
  }
  const missing = POSITIONS.flatMap((position) => Array.from({ length: Math.max(0, POSITION_MINIMUMS[position] - counts[position]) }, () => position));
  if (!missing.length) return 0;
  const clubs = clubCounts(currentIds, playerMap(universe));
  const byPosition = new Map<Position, Player[]>();
  for (const position of POSITIONS) {
    const candidates = universe
      .filter((player) => player.position === position && !selected.has(player.id) && !excludedIds.has(player.id))
      .sort((a, b) => a.priceTenths - b.priceTenths || a.id - b.id)
      // ponytail: keep the 12 cheapest per position; widen only if a larger
      // player universe makes club-constrained completion materially fail.
      .slice(0, 12);
    byPosition.set(position, candidates);
  }
  const ordered = [...missing].sort((a, b) => (byPosition.get(a)?.length ?? 0) - (byPosition.get(b)?.length ?? 0));
  let best = Number.POSITIVE_INFINITY;
  function search(index: number, runningCost: number): void {
    if (runningCost >= best) return;
    if (index === ordered.length) {
      best = runningCost;
      return;
    }
    const position = ordered[index];
    for (const player of byPosition.get(position) ?? []) {
      if ((clubs.get(player.teamId) ?? 0) >= (options.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB)) continue;
      clubs.set(player.teamId, (clubs.get(player.teamId) ?? 0) + 1);
      search(index + 1, runningCost + player.priceTenths);
      const next = (clubs.get(player.teamId) ?? 1) - 1;
      if (next) clubs.set(player.teamId, next);
      else clubs.delete(player.teamId);
    }
  }
  search(0, 0);
  return Number.isFinite(best) ? best : undefined;
}

export function budgetFeasibility(squad: SquadReference, players: PlayerUniverse, options?: CommonOptions): BudgetFeasibility;
export function budgetFeasibility(request: BudgetRequest): BudgetFeasibility;
export function budgetFeasibility(
  squadOrRequest: SquadReference | BudgetRequest,
  players?: PlayerUniverse,
  options: CommonOptions = {},
): BudgetFeasibility {
  const request = !Array.isArray(squadOrRequest) && "squad" in squadOrRequest
    ? squadOrRequest
    : { squad: squadOrRequest, players, ...options };
  const universe = asPlayers(requestPlayers(request));
  const map = playerMap(universe);
  const currentIds = Array.isArray(request.squad) ? request.squad.map((item) => typeof item === "number" ? item : item.id) : (request.squad as { playerIds: number[] }).playerIds;
  const spentTenths = costOf(currentIds, map);
  const bankTenths = (request.budgetTenths ?? DEFAULT_BUDGET_TENTHS) - spentTenths;
  const minimumRequiredTenths = cheapCompletionCost(currentIds, universe, request) ?? Number.POSITIVE_INFINITY;
  const flexibleTenths = bankTenths - (Number.isFinite(minimumRequiredTenths) ? minimumRequiredTenths : 0);
  return {
    spentTenths,
    bankTenths,
    minimumRequiredTenths,
    flexibleTenths: Number.isFinite(minimumRequiredTenths) ? flexibleTenths : Number.NEGATIVE_INFINITY,
    feasible: Number.isFinite(minimumRequiredTenths) && flexibleTenths >= 0,
  };
}

export function findReplacements(request: ReplacementRequest): ReplacementList {
  const universe = asPlayers(requestPlayers(request));
  const map = playerMap(universe);
  const outgoing = map.get(request.outgoingPlayerId);
  if (!outgoing) return asList([], { message: `Player ${request.outgoingPlayerId} is not in the player universe.` });
  const currentIds = Array.isArray(request.squad) ? request.squad.map((item) => typeof item === "number" ? item : item.id) : (request.squad as { playerIds: number[] }).playerIds;
  if (!currentIds.includes(outgoing.id)) return asList([], { message: `${outgoing.displayName} is not in the squad.` });
  const selected = new Set(currentIds);
  const clubs = clubCounts(currentIds, map);
  const availableBudget = (request.budgetTenths ?? DEFAULT_BUDGET_TENTHS) - costOf(currentIds, map) + outgoing.priceTenths;
  const strategy = strategyOptions(request);
  const oldProjection = horizonValue(outgoing, strategy.horizon);
  const result = universe
    .filter((player) => player.position === outgoing.position)
    .filter((player) => playerEligible(player, selected, clubs, outgoing.id, outgoing.teamId, request))
    .filter((player) => player.priceTenths <= availableBudget)
    .map((player): RichReplacementCandidate => {
      const projection = horizonValue(player, strategy.horizon);
      const projectedDelta = projection - oldProjection;
      const minutes = expectedMinutes(player);
      const risk = availabilityRisk(player);
      const reasonParts = [projectedDelta >= 0 ? `+${projectedDelta.toFixed(1)} projected points` : `${projectedDelta.toFixed(1)} projected points`];
      if (minutes >= 80) reasonParts.push("secure minutes");
      else if (minutes < 60) reasonParts.push("minutes risk");
      if (risk >= 0.35) reasonParts.push("availability risk");
      if (player.fixtures.slice(0, strategy.horizon).some((fixture) => (fixture.difficulty ?? 3) <= 2)) reasonParts.push("favourable fixture run");
      return {
        playerId: player.id,
        priceTenths: player.priceTenths,
        projectedNext5: horizonValue(player, 5),
        projectedDelta,
        bankDeltaTenths: outgoing.priceTenths - player.priceTenths,
        expectedMinutes: minutes,
        confidence: player.projection?.confidence ?? "LOW",
        ownership: player.ownership,
        fixtures: player.fixtures,
        valueNext5: projection / Math.max(1, player.priceTenths / 10),
        reason: reasonParts.join(", "),
      };
    })
    .sort((a, b) => {
      const aScore = a.projectedDelta + (strategy.risk === "SAFE" ? a.expectedMinutes / 100 : 0) + a.bankDeltaTenths / 100;
      const bScore = b.projectedDelta + (strategy.risk === "SAFE" ? b.expectedMinutes / 100 : 0) + b.bankDeltaTenths / 100;
      return bScore - aScore || a.priceTenths - b.priceTenths || a.playerId - b.playerId;
    });
  return asList(result, { maxAffordablePriceTenths: availableBudget });
}

export function maxAffordablePrice(position: Position, currentSquad: SquadReference, players: PlayerUniverse, options?: CommonOptions): number;
export function maxAffordablePrice(request: SlotSuggestionRequest): number;
export function maxAffordablePrice(
  positionOrRequest: Position | SlotSuggestionRequest,
  currentSquad?: SquadReference,
  players?: PlayerUniverse,
  options: CommonOptions = {},
): number {
  const request = typeof positionOrRequest === "string"
    ? { position: positionOrRequest, currentSquad: currentSquad!, players, ...options }
    : positionOrRequest;
  const universe = asPlayers(requestPlayers(request));
  const map = playerMap(universe);
  const currentIds = Array.isArray(request.currentSquad) ? request.currentSquad.map((item) => typeof item === "number" ? item : item.id) : (request.currentSquad as { playerIds: number[] }).playerIds;
  const currentCost = costOf(currentIds, map);
  const bank = (request.budgetTenths ?? DEFAULT_BUDGET_TENTHS) - currentCost;
  const currentPositionCount = currentIds.filter((id) => map.get(id)?.position === request.position).length;
  if (currentPositionCount >= POSITION_MINIMUMS[request.position]) return 0;
  const selected = new Set(currentIds);
  const clubs = clubCounts(currentIds, map);
  let best = 0;
  for (const candidate of universe
    .filter((player) => player.position === request.position && !selected.has(player.id) && !(request.excludedPlayerIds ?? []).includes(player.id))
    .sort((a, b) => b.priceTenths - a.priceTenths || a.id - b.id)) {
    if (candidate.priceTenths > bank) continue;
    if ((clubs.get(candidate.teamId) ?? 0) >= (request.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB)) continue;
    const withCandidate = [...currentIds, candidate.id];
    const completion = cheapCompletionCost(withCandidate, universe, request);
    if (completion !== undefined && candidate.priceTenths + completion <= bank) {
      best = Math.max(best, candidate.priceTenths);
      break;
    }
  }
  return best;
}

export function suggestForSlot(request: SlotSuggestionRequest): ReplacementList {
  const universe = asPlayers(requestPlayers(request));
  const map = playerMap(universe);
  const currentIds = Array.isArray(request.currentSquad) ? request.currentSquad.map((item) => typeof item === "number" ? item : item.id) : (request.currentSquad as { playerIds: number[] }).playerIds;
  const selected = new Set(currentIds);
  const clubs = clubCounts(currentIds, map);
  const bank = (request.budgetTenths ?? DEFAULT_BUDGET_TENTHS) - costOf(currentIds, map);
  const safePrice = maxAffordablePrice(request.position, currentIds, universe, request);
  const strategy = strategyOptions(request);
  const candidates = universe
    .filter((player) => player.position === request.position)
    .filter((player) => !selected.has(player.id) && !(request.excludedPlayerIds ?? []).includes(player.id))
    .filter((player) => player.priceTenths <= safePrice)
    .filter((player) => (clubs.get(player.teamId) ?? 0) < (request.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB))
    .filter((player) => !((request.availability ?? request.strategy?.availability ?? (strategy.risk === "SAFE" ? "AVAILABLE" : "ANY")) !== "ANY" && hasAvailabilityRisk(player)))
    .map((player): RichReplacementCandidate => ({
      playerId: player.id,
      priceTenths: player.priceTenths,
      projectedNext5: horizonValue(player, 5),
      projectedDelta: horizonValue(player, strategy.horizon),
      bankDeltaTenths: bank - player.priceTenths,
      expectedMinutes: expectedMinutes(player),
      confidence: player.projection?.confidence ?? "LOW",
      ownership: player.ownership,
      fixtures: player.fixtures,
      valueNext5: horizonValue(player, 5) / Math.max(1, player.priceTenths / 10),
      reason: `${formatPrice(player.priceTenths)} fits the safe completion budget; ${utilityValue(player, strategy.horizon, strategy.risk).toFixed(1)} utility`,
    }))
    .sort((a, b) => b.projectedDelta - a.projectedDelta || b.expectedMinutes - a.expectedMinutes || a.priceTenths - b.priceTenths || a.playerId - b.playerId);
  const required = cheapCompletionCost(currentIds, universe, request) ?? 0;
  return asList(candidates, {
    maxAffordablePriceTenths: safePrice,
    minimumRequiredTenths: required,
    message: candidates.length ? undefined : "No legal player fits while keeping the remaining squad completable.",
  });
}

export const calculateBudgetFeasibility = budgetFeasibility;
export const minimumRequiredSpend = (squad: SquadReference, players: PlayerUniverse, options?: CommonOptions): number => budgetFeasibility(squad, players, options).minimumRequiredTenths;
export const minimumRemainingSpend = minimumRequiredSpend;
export const maxSafePriceForPosition = maxAffordablePrice;
export const maximumSafePrice = maxAffordablePrice;

export { cheapCompletionCost };
