import type { Player, ProjectionConfidence } from "@/types/player";
import type { SingleTransferKind, SingleTransferSuggestion } from "@/types/analysis";
import { projectWeeklyLineupTotal, weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import { sellingPriceTenths } from "@/lib/chips/finance";
import {
  asPlayers,
  availabilityRisk,
  DEFAULT_BUDGET_TENTHS,
  DEFAULT_MAX_PLAYERS_PER_CLUB,
  hasAvailabilityRisk,
  legalSquad,
  playerMap,
  type CommonOptions,
  type PlayerUniverse,
  type SquadReference,
} from "./context";

const CASH_XP_PER_MILLION = 0.25;
const EPSILON = 0.000_001;

export interface SingleTransferSearchInput extends CommonOptions {
  squad: SquadReference;
  players: PlayerUniverse;
  gameweek: number;
  outgoingPlayerId?: number;
}

function idsOf(squad: SquadReference): number[] {
  return Array.isArray(squad)
    ? squad.map((item) => typeof item === "number" ? item : item.id)
    : [...(squad as { playerIds: number[] }).playerIds];
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function confidence(player: Player): ProjectionConfidence {
  return player.projection?.confidence ?? "LOW";
}

function allowedByRisk(player: Player, risk: CommonOptions["risk"]): boolean {
  return risk !== "SAFE" || (!hasAvailabilityRisk(player) && confidence(player) !== "LOW");
}

function kind(projectedDelta: number, cashReleasedTenths: number): SingleTransferKind {
  if (projectedDelta > EPSILON && cashReleasedTenths > 0) return "BOTH";
  return "XP_UPGRADE";
}

function dominates(left: SingleTransferSuggestion, right: SingleTransferSuggestion): boolean {
  return left.projectedDeltaPerGW >= right.projectedDeltaPerGW - EPSILON
    && left.cashReleasedTenths >= right.cashReleasedTenths
    && (left.projectedDeltaPerGW > right.projectedDeltaPerGW + EPSILON
      || left.cashReleasedTenths > right.cashReleasedTenths);
}

type IncomingCandidate = {
  player: Player;
  afterIds: number[];
  weeks: ReturnType<typeof weeklyPlayerMetrics>[];
};

function dominatesIncoming(left: IncomingCandidate, right: IncomingCandidate): boolean {
  if (left.player.priceTenths > right.player.priceTenths) return false;
  const noWorse = left.weeks.every((week, index) => week.points >= right.weeks[index].points - EPSILON
    && week.pDNP <= right.weeks[index].pDNP + EPSILON
    && week.minutes >= right.weeks[index].minutes - EPSILON);
  if (!noWorse) return false;
  const strictlyBetter = left.player.priceTenths < right.player.priceTenths
    || left.weeks.some((week, index) => week.points > right.weeks[index].points + EPSILON
      || week.pDNP < right.weeks[index].pDNP - EPSILON
      || week.minutes > right.weeks[index].minutes + EPSILON);
  return strictlyBetter || left.player.id < right.player.id;
}

function cannotImproveXp(outgoingWeeks: IncomingCandidate["weeks"], incomingWeeks: IncomingCandidate["weeks"]): boolean {
  return outgoingWeeks.every((week, index) => week.points >= incomingWeeks[index].points - EPSILON
    && week.pDNP <= incomingWeeks[index].pDNP + EPSILON
    && week.minutes >= incomingWeeks[index].minutes - EPSILON);
}

function explanation(move: Pick<SingleTransferSuggestion, "projectedDelta" | "cashReleasedTenths" | "horizon" | "kind">): string {
  const xp = `${move.projectedDelta >= 0 ? "+" : ""}${move.projectedDelta.toFixed(1)} xP over ${move.horizon}GW`;
  const money = move.cashReleasedTenths >= 0
    ? `releases £${(move.cashReleasedTenths / 10).toFixed(1)}m`
    : `costs £${(-move.cashReleasedTenths / 10).toFixed(1)}m`;
  const label = move.kind === "BOTH" ? "xP upgrade and cash release" : "xP upgrade";
  return `${label}: ${xp}, ${money}`;
}

/** Exhaustively ranks all legal one-player transfers on the xP/cash Pareto frontier. */
export function findBestSingleTransfers(input: SingleTransferSearchInput): SingleTransferSuggestion[] {
  const universe = asPlayers(input.players);
  const byId = playerMap(universe);
  const squadIds = idsOf(input.squad);
  const budgetTenths = input.budgetTenths ?? DEFAULT_BUDGET_TENTHS;
  const maxPlayersPerClub = input.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB;
  if (!legalSquad(squadIds, byId, { budgetTenths, maxPlayersPerClub }).legal) return [];

  const selected = new Set(squadIds);
  const locked = new Set(input.lockedPlayerIds ?? []);
  const excluded = new Set(input.excludedPlayerIds ?? []);
  const riskMode = input.risk ?? input.strategy?.risk ?? "BALANCED";
  const horizon = input.horizon ?? input.strategy?.horizon ?? 5;
  const squad = squadIds.map((id) => byId.get(id)).filter((player): player is Player => Boolean(player));
  // Selling a player returns the purchase price plus half the rise, not today's
  // market price. Without purchase prices the two are the same by definition.
  const sellingOf = (player: Player): number =>
    sellingPriceTenths(input.purchasePricesTenths?.[player.id] ?? player.priceTenths, player.priceTenths);
  const spentBefore = squad.reduce((sum, player) => sum + player.priceTenths, 0);
  const beforeXp = projectWeeklyLineupTotal({ squad, gameweek: input.gameweek, riskMode }, horizon);
  const candidates: SingleTransferSuggestion[] = [];
  const weeklyMetrics = new Map(universe.map((player) => [player.id, Array.from(
    { length: horizon },
    (_, index) => weeklyPlayerMetrics(player, input.gameweek + index),
  )]));

  for (const outgoingId of squadIds) {
    if ((input.outgoingPlayerId !== undefined && outgoingId !== input.outgoingPlayerId) || locked.has(outgoingId)) continue;
    const outgoing = byId.get(outgoingId);
    if (!outgoing) continue;
    const outgoingWeeks = weeklyMetrics.get(outgoingId)!;
    // Affordability is bank + selling value of the outgoing player. Expressed as
    // a budget so the existing legality check needs no change.
    const affordableBudget = input.bankTenths === undefined
      ? budgetTenths
      : spentBefore - outgoing.priceTenths + input.bankTenths + sellingOf(outgoing);
    const viable = universe.flatMap((incoming): IncomingCandidate[] => {
      if (incoming.position !== outgoing.position || selected.has(incoming.id) || excluded.has(incoming.id) || !allowedByRisk(incoming, riskMode)) return [];
      if (cannotImproveXp(outgoingWeeks, weeklyMetrics.get(incoming.id)!)) return [];
      const afterIds = squadIds.map((id) => id === outgoingId ? incoming.id : id);
      if (!legalSquad(afterIds, byId, { budgetTenths: affordableBudget, maxPlayersPerClub, excludedPlayerIds: input.excludedPlayerIds }).legal) return [];
      return [{ player: incoming, afterIds, weeks: weeklyMetrics.get(incoming.id)! }];
    });
    const frontier = viable.filter((candidate, index) => !viable.some((other, otherIndex) => otherIndex !== index && dominatesIncoming(other, candidate)));
    for (const { player: incoming, afterIds } of frontier) {
      const afterSquad = afterIds.map((id) => byId.get(id)).filter((player): player is Player => Boolean(player));
      const afterXp = projectWeeklyLineupTotal({ squad: afterSquad, gameweek: input.gameweek, riskMode }, horizon);
      const projectedDelta = rounded(afterXp - beforeXp);
      const projectedDeltaPerGW = rounded(projectedDelta / horizon);
      const cashReleasedTenths = sellingOf(outgoing) - incoming.priceTenths;
      if (projectedDelta <= EPSILON) continue;
      const moveKind = kind(projectedDelta, cashReleasedTenths);
      const move: SingleTransferSuggestion = {
        outgoingPlayerId: outgoingId,
        incomingPlayerId: incoming.id,
        horizon,
        beforeXp,
        afterXp,
        projectedDelta,
        projectedDeltaPerGW,
        cashReleasedTenths,
        score: rounded(projectedDeltaPerGW + CASH_XP_PER_MILLION * cashReleasedTenths / 10),
        kind: moveKind,
        incomingRisk: rounded(availabilityRisk(incoming)),
        confidence: confidence(incoming),
        reason: "",
      };
      move.reason = explanation(move);
      candidates.push(move);
    }
  }

  return candidates
    .filter((candidate, index) => !candidates.some((other, otherIndex) => otherIndex !== index && dominates(other, candidate)))
    .sort((left, right) => right.score - left.score
      || right.projectedDelta - left.projectedDelta
      || right.cashReleasedTenths - left.cashReleasedTenths
      || left.incomingRisk - right.incomingRisk
      || left.outgoingPlayerId - right.outgoingPlayerId
      || left.incomingPlayerId - right.incomingPlayerId);
}
