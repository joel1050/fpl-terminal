"use client";

import { create } from "zustand";
import { INITIAL_BUDGET_TENTHS, type Horizon, type PersistentFPLState, type Player, type Position, type SquadState, type WeeklyLineupPlan } from "@/types";
import type { ChipKind, FinancialConfidence, PlannedTransfer, TransferBaseline } from "@/types/chips";
import { validateChipSelection } from "@/lib/chips/seasonPolicy";
import { isLeagueKey } from "@/lib/leagues/leagueKey";
import { validateWeeklyLineup } from "@/lib/squad/weeklyLineup";

type RiskMode = "SAFE" | "BALANCED" | "AGGRESSIVE";
type BenchStrategy = "CHEAP" | "BALANCED" | "STRONG";

export type DesktopPanel = "market" | "squad";

export const PANEL_RATIO_MAX = 1000;

export function sanitizePanelRatios(ratios: Partial<Record<DesktopPanel, number>> | undefined): Partial<Record<DesktopPanel, number>> {
  const cleaned: Partial<Record<DesktopPanel, number>> = {};
  if (!ratios) return cleaned;
  for (const panel of Object.keys(ratios) as DesktopPanel[]) {
    const value = ratios[panel];
    if (typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= PANEL_RATIO_MAX) cleaned[panel] = Math.round(value);
  }
  return cleaned;
}

export type TerminalMode = "BUILD" | "ANALYZE";
export type SortKey = "name" | "price" | "nextGW" | "form" | "next5" | "value" | "ownership" | "risk";

export type TerminalFilters = {
  position: Position | "ALL";
  club: string;
  minPrice: string;
  maxPrice: string;
  minOwnership: string;
  maxOwnership: string;
  availability: "ALL" | "AVAILABLE" | "DOUBTFUL" | "UNAVAILABLE";
  confidence: "ALL" | "HIGH" | "MEDIUM" | "LOW";
  risk: "ALL" | "LOW" | "MEDIUM" | "HIGH";
  affordableOnly: boolean;
  excludeSelected: boolean;
  quick: "ALL" | "VALUE" | "PREMIUM" | "DIFFERENTIAL" | "NAILED" | "CHEAP";
};

type SlotMap = Record<Position, number[]>;

export type ApplyLineupInput = {
  gameweek: number;
  lineupProjectionFingerprint: string;
  benchGoalkeeperId?: number;
  benchOrder?: number[];
  captainId?: number;
  viceCaptainId?: number;
};

/**
 * The shape written to local storage and to a downloaded export.
 *
 * Bump `SAVED_STATE_VERSION` only for a change existing saved state cannot
 * survive - a renamed or re-typed field, not a new optional one. Additive
 * changes need no bump: every field is sanitized on read, so an older save
 * simply arrives without it.
 */
export const SAVED_STATE_VERSION = 1;

export type PersistedTerminalState = PersistentFPLState & {
  /** Absent on anything saved before versioning; read as version 0. */
  version?: number;
  mode?: TerminalMode | null;
  entryId?: number;
  budgetTenths?: number;
  selectedLeagueKey?: string;
  benchGoalkeeperId?: number;
  lineupGameweek?: number;
  lineupProjectionFingerprint?: string;
  panelRatios?: Partial<Record<DesktopPanel, number>>;
  dismissedTransferKeys?: string[];
  currentGameweek?: number;
  planningGameweek?: number;
  gameweekPlans?: Record<number, GameweekPlanSnapshot>;
  transferBaseline?: TransferBaseline | null;
  usedChips?: Array<{ kind: ChipKind; gameweek: number }>;
};

export type PermanentSquadSnapshot = {
  playerIds: number[];
  byPosition: SlotMap;
  benchGoalkeeperId?: number;
  benchOrder: number[];
  lockedPlayerIds: number[];
  captainId?: number;
  viceCaptainId?: number;
};

export type GameweekPlanSnapshot = {
  gameweek: number;
  playerIds: number[];
  byPosition: SlotMap;
  benchGoalkeeperId?: number;
  benchOrder: number[];
  lockedPlayerIds: number[];
  captainId?: number;
  viceCaptainId?: number;
  lineupGameweek?: number;
  lineupProjectionFingerprint?: string;
  chip: ChipKind | null;
  plannedTransfers: PlannedTransfer[];
  /** Preserved permanent squad, used only by Free Hit weeks. */
  permanentSquad?: PermanentSquadSnapshot;
};

/** Alias used by callers that refer to a saved weekly plan rather than its storage shape. */
export type GameweekPlan = GameweekPlanSnapshot;

const emptySlots = (): SlotMap => ({ GK: [], DEF: [], MID: [], FWD: [] });

const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];
const MAX_GAMEWEEK = 38;

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validGameweek(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_GAMEWEEK;
}

function validBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function clampGameweek(gameweek: number, currentGameweek = 1): number {
  const current = validGameweek(currentGameweek) ? currentGameweek : 1;
  if (!Number.isFinite(gameweek)) return current;
  return Math.min(MAX_GAMEWEEK, Math.max(current, Math.trunc(gameweek)));
}

function cloneSlotMap(byPosition: SlotMap): SlotMap {
  return Object.fromEntries(POSITIONS.map((position) => [position, [...byPosition[position]]])) as SlotMap;
}

function clonePlan(plan: GameweekPlanSnapshot, gameweek = plan.gameweek): GameweekPlanSnapshot {
  return {
    ...plan,
    gameweek,
    playerIds: [...plan.playerIds],
    byPosition: cloneSlotMap(plan.byPosition),
    benchOrder: [...plan.benchOrder],
    lockedPlayerIds: [...plan.lockedPlayerIds],
    chip: plan.chip ?? null,
    plannedTransfers: plan.plannedTransfers.map((transfer) => ({ ...transfer })),
    permanentSquad: plan.permanentSquad
      ? {
        playerIds: [...plan.permanentSquad.playerIds],
        byPosition: cloneSlotMap(plan.permanentSquad.byPosition),
        benchGoalkeeperId: plan.permanentSquad.benchGoalkeeperId,
        benchOrder: [...plan.permanentSquad.benchOrder],
        lockedPlayerIds: [...plan.permanentSquad.lockedPlayerIds],
        captainId: plan.permanentSquad.captainId,
        viceCaptainId: plan.permanentSquad.viceCaptainId,
      }
      : undefined,
  };
}

function validChip(value: unknown): value is ChipKind | null {
  return value === null || value === undefined || value === "wildcard" || value === "freehit" || value === "bboost" || value === "3xc";
}

function sanitizeTransfers(value: unknown): PlannedTransfer[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const result: PlannedTransfer[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const candidate = item as Partial<PlannedTransfer>;
    if (!validId(candidate.outId) || !validId(candidate.inId)) return undefined;
    if (candidate.position !== "GK" && candidate.position !== "DEF" && candidate.position !== "MID" && candidate.position !== "FWD") return undefined;
    if (candidate.outId === candidate.inId) return undefined;
    result.push({ outId: candidate.outId, inId: candidate.inId, position: candidate.position });
  }
  return result;
}

function sanitizePermanentSquad(value: unknown): PermanentSquadSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PermanentSquadSnapshot>;
  if (!validNumberArray(candidate.playerIds) || !validSlotMap(candidate.byPosition)) return undefined;
  if (candidate.playerIds.length > 15) return undefined;
  const memberSet = new Set(candidate.playerIds);
  // Lineup fields are optional (pre-lineup snapshots predate them) but when
  // present they must reference squad members.
  if (candidate.benchGoalkeeperId !== undefined
    && (!validId(candidate.benchGoalkeeperId) || !candidate.byPosition.GK.includes(candidate.benchGoalkeeperId))) return undefined;
  const benchOrder = candidate.benchOrder === undefined ? [] : candidate.benchOrder;
  const lockedPlayerIds = candidate.lockedPlayerIds === undefined ? [] : candidate.lockedPlayerIds;
  if (!Array.isArray(benchOrder) || !benchOrder.every(validId) || new Set(benchOrder).size !== benchOrder.length
    || benchOrder.length > 3 || benchOrder.some((id) => !memberSet.has(id))) return undefined;
  if (!Array.isArray(lockedPlayerIds) || !lockedPlayerIds.every(validId) || new Set(lockedPlayerIds).size !== lockedPlayerIds.length
    || lockedPlayerIds.some((id) => !memberSet.has(id))) return undefined;
  if (candidate.captainId !== undefined && (!validId(candidate.captainId) || !memberSet.has(candidate.captainId))) return undefined;
  if (candidate.viceCaptainId !== undefined && (!validId(candidate.viceCaptainId) || !memberSet.has(candidate.viceCaptainId))) return undefined;
  if (candidate.captainId !== undefined && candidate.captainId === candidate.viceCaptainId) return undefined;
  return {
    playerIds: [...candidate.playerIds],
    byPosition: cloneSlotMap(candidate.byPosition),
    benchGoalkeeperId: candidate.benchGoalkeeperId,
    benchOrder: [...benchOrder],
    lockedPlayerIds: [...lockedPlayerIds],
    captainId: candidate.captainId,
    viceCaptainId: candidate.viceCaptainId,
  };
}

/** Drops lineup choices that reference players outside the given squad. */
function conformLineupToSquad(
  playerIds: readonly number[],
  benchGoalkeeperId: number | undefined,
  benchOrder: readonly number[],
  captainId: number | undefined,
  viceCaptainId: number | undefined,
): { benchGoalkeeperId?: number; benchOrder: number[]; captainId?: number; viceCaptainId?: number } {
  const members = new Set(playerIds);
  const keeper = benchGoalkeeperId !== undefined && members.has(benchGoalkeeperId) ? benchGoalkeeperId : undefined;
  const order = benchOrder.filter((id) => members.has(id)).slice(0, 3);
  const captain = captainId !== undefined && members.has(captainId) ? captainId : undefined;
  let vice = viceCaptainId !== undefined && members.has(viceCaptainId) ? viceCaptainId : undefined;
  if (captain !== undefined && vice === captain) vice = undefined;
  return { benchGoalkeeperId: keeper, benchOrder: order, captainId: captain, viceCaptainId: vice };
}

export function sanitizeBaseline(value: unknown): TransferBaseline | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<TransferBaseline>;
  if (!validNumberArray(candidate.squadPlayerIds) || candidate.squadPlayerIds!.length > 15) return null;
  if (!validSlotMap(candidate.byPosition)) return null;
  if (typeof candidate.bankTenths !== "number" || !Number.isSafeInteger(candidate.bankTenths)) return null;
  if (typeof candidate.freeTransfers !== "number" || !Number.isSafeInteger(candidate.freeTransfers)) return null;
  if (!candidate.purchasePricesTenths || typeof candidate.purchasePricesTenths !== "object") return null;
  const prices: Record<number, number> = {};
  for (const [key, price] of Object.entries(candidate.purchasePricesTenths)) {
    const id = Number(key);
    if (!validId(id) || typeof price !== "number" || !Number.isSafeInteger(price)) return null;
    prices[id] = price;
  }
  if (candidate.financialConfidence !== "EXACT" && candidate.financialConfidence !== "ESTIMATED") return null;
  if (!validGameweek(candidate.startGameweek)) return null;
  const warnings = Array.isArray(candidate.warnings) ? candidate.warnings.filter((w): w is string => typeof w === "string") : [];
  return {
    squadPlayerIds: [...candidate.squadPlayerIds!],
    byPosition: cloneSlotMap(candidate.byPosition!),
    bankTenths: candidate.bankTenths!,
    freeTransfers: candidate.freeTransfers!,
    purchasePricesTenths: prices,
    financialConfidence: candidate.financialConfidence as FinancialConfidence,
    startGameweek: candidate.startGameweek!,
    warnings,
  };
}

function sanitizeUsedChips(value: unknown): Array<{ kind: ChipKind; gameweek: number }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ kind: ChipKind; gameweek: number }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as { kind?: unknown; gameweek?: unknown };
    if (validChip(candidate.kind) && candidate.kind !== null && validGameweek(candidate.gameweek)) {
      result.push({ kind: candidate.kind, gameweek: candidate.gameweek as number });
    }
  }
  return result;
}

/**
 * Baseline for a squad with no import behind it. Purchase price is the market
 * price, because a hand-built squad is bought at today's prices, and the bank
 * is whatever the budget leaves. Always ESTIMATED: a real team's purchase
 * prices and bank cannot be derived from a list of players.
 */
export function estimatedBaselineFallback(
  playerIds: number[],
  byPosition: SlotMap,
  budgetTenths: number,
  gameweek: number,
  priceById?: ReadonlyMap<number, number>,
): TransferBaseline {
  const purchasePricesTenths: Record<number, number> = {};
  let spent = 0;
  if (priceById) {
    for (const id of playerIds) {
      const price = priceById.get(id);
      if (price === undefined) continue;
      purchasePricesTenths[id] = Math.trunc(price);
      spent += Math.trunc(price);
    }
  }
  return {
    squadPlayerIds: [...playerIds],
    byPosition: cloneSlotMap(byPosition),
    bankTenths: priceById ? Math.max(0, Math.trunc(budgetTenths) - spent) : 0,
    freeTransfers: 1,
    purchasePricesTenths,
    financialConfidence: "ESTIMATED",
    startGameweek: validGameweek(gameweek) ? gameweek : 1,
    warnings: ["Squad was built by hand, so purchase prices use market prices and finances are ESTIMATED."],
  };
}

function validNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(validId) && new Set(value).size === value.length;
}

function safeNumberArray(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every(validId) ? [...value] : undefined;
}

function validSlotMap(value: unknown): value is SlotMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Record<Position, unknown>>;
  return POSITIONS.every((position) => validNumberArray(candidate[position]));
}

function validSquadShape(value: unknown): value is SquadState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SquadState>;
  return validNumberArray(candidate.playerIds) && validSlotMap(candidate.byPosition);
}

function sanitizeSquad(value: unknown): SquadState | undefined {
  if (!validSquadShape(value)) return undefined;
  return { playerIds: [...value.playerIds], byPosition: cloneSlotMap(value.byPosition) };
}

function sanitizePlan(value: unknown, expectedGameweek: number): GameweekPlanSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<GameweekPlanSnapshot>;
  if ((candidate.gameweek !== undefined && candidate.gameweek !== expectedGameweek)
    || !validNumberArray(candidate.playerIds)
    || !validSlotMap(candidate.byPosition)
    || !validNumberArray(candidate.benchOrder)
    || !validNumberArray(candidate.lockedPlayerIds)) return undefined;
  const byPosition = candidate.byPosition as SlotMap;
  if (candidate.playerIds.length > 15
    || byPosition.GK.length > 2
    || byPosition.DEF.length > 5
    || byPosition.MID.length > 5
    || byPosition.FWD.length > 3
    || candidate.benchOrder.length > 3
    || candidate.lockedPlayerIds.length > 15) return undefined;
  const listedIds = POSITIONS.flatMap((position) => candidate.byPosition?.[position] ?? []);
  const playerSet = new Set(candidate.playerIds);
  if (listedIds.some((id) => !playerSet.has(id)) || new Set(listedIds).size !== listedIds.length) return undefined;
  if (candidate.benchGoalkeeperId !== undefined && (!validId(candidate.benchGoalkeeperId) || !byPosition.GK.includes(candidate.benchGoalkeeperId))) return undefined;
  if (candidate.benchOrder.some((id) => !playerSet.has(id) || byPosition.GK.includes(id))) return undefined;
  if (candidate.lockedPlayerIds.some((id) => !playerSet.has(id))) return undefined;
  if (candidate.captainId !== undefined && (!validId(candidate.captainId) || !playerSet.has(candidate.captainId))) return undefined;
  if (candidate.viceCaptainId !== undefined && (!validId(candidate.viceCaptainId) || !playerSet.has(candidate.viceCaptainId))) return undefined;
  if (candidate.captainId !== undefined && candidate.captainId === candidate.viceCaptainId) return undefined;
  if (candidate.lineupGameweek !== undefined && !validGameweek(candidate.lineupGameweek)) return undefined;
  if (candidate.lineupProjectionFingerprint !== undefined && (typeof candidate.lineupProjectionFingerprint !== "string" || !candidate.lineupProjectionFingerprint.trim())) return undefined;
  if ((candidate.lineupGameweek === undefined) !== (candidate.lineupProjectionFingerprint === undefined)) return undefined;
  // New chip fields: invalid values are dropped without discarding the squad or lineup.
  const chip = validChip(candidate.chip) ? (candidate.chip ?? null) : null;
  const plannedTransfers = sanitizeTransfers(candidate.plannedTransfers);
  if (plannedTransfers === undefined) return undefined;
  const permanentSquad = sanitizePermanentSquad(candidate.permanentSquad);
  if (candidate.permanentSquad !== undefined && permanentSquad === undefined) return undefined;
  if (permanentSquad !== undefined && chip !== "freehit") return undefined;
  return clonePlan({
    gameweek: expectedGameweek,
    playerIds: candidate.playerIds,
    byPosition,
    benchGoalkeeperId: candidate.benchGoalkeeperId,
    benchOrder: candidate.benchOrder,
    lockedPlayerIds: candidate.lockedPlayerIds,
    captainId: candidate.captainId,
    viceCaptainId: candidate.viceCaptainId,
    lineupGameweek: candidate.lineupGameweek,
    lineupProjectionFingerprint: candidate.lineupProjectionFingerprint?.trim(),
    chip,
    plannedTransfers,
    permanentSquad,
  });
}

function sanitizePlans(value: unknown): Record<number, GameweekPlanSnapshot> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const plans: Record<number, GameweekPlanSnapshot> = {};
  for (const [key, rawPlan] of Object.entries(value)) {
    const gameweek = Number(key);
    if (!validGameweek(gameweek)) continue;
    const plan = sanitizePlan(rawPlan, gameweek);
    if (plan) plans[gameweek] = plan;
  }
  return plans;
}

export type PlanStateFields = Pick<TerminalState, "planningGameweek" | "playerIds" | "byPosition" | "benchGoalkeeperId" | "benchOrder" | "lockedPlayerIds" | "captainId" | "viceCaptainId" | "lineupGameweek" | "lineupProjectionFingerprint" | "chip" | "plannedTransfers" | "permanentSquad">;

function planFromState(state: PlanStateFields, gameweek = state.planningGameweek): GameweekPlanSnapshot {
  return {
    gameweek,
    playerIds: [...state.playerIds],
    byPosition: cloneSlotMap(state.byPosition),
    benchGoalkeeperId: state.benchGoalkeeperId,
    benchOrder: [...state.benchOrder],
    lockedPlayerIds: [...state.lockedPlayerIds],
    captainId: state.captainId,
    viceCaptainId: state.viceCaptainId,
    lineupGameweek: state.lineupGameweek,
    lineupProjectionFingerprint: state.lineupProjectionFingerprint,
    chip: state.chip ?? null,
    plannedTransfers: state.plannedTransfers.map((transfer) => ({ ...transfer })),
    permanentSquad: state.permanentSquad ? clonePermanentSnapshot(state.permanentSquad) : undefined,
  };
}

function validHorizon(value: unknown): value is Horizon {
  return value === 1 || value === 3 || value === 5 || value === 10;
}
function savePlan(plans: Record<number, GameweekPlanSnapshot>, plan: GameweekPlanSnapshot): Record<number, GameweekPlanSnapshot> {
  const clean = sanitizePlan(plan, plan.gameweek);
  return clean ? { ...plans, [plan.gameweek]: clean } : { ...plans };
}

function nearestPriorPlan(plans: Record<number, GameweekPlanSnapshot>, gameweek: number): GameweekPlanSnapshot | undefined {
  const source = Object.keys(plans)
    .map(Number)
    .filter((candidate) => candidate <= gameweek)
    .sort((left, right) => right - left)[0];
  return source === undefined ? undefined : plans[source];
}

function diffTransfers(before: readonly number[], after: readonly number[], byPosition: SlotMap): PlannedTransfer[] {
  const afterSet = new Set(after);
  const beforeSet = new Set(before);
  const outs = before.filter((id) => !afterSet.has(id));
  const ins = after.filter((id) => !beforeSet.has(id));
  const count = Math.min(outs.length, ins.length);
  const result: PlannedTransfer[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push({ outId: outs[index], inId: ins[index], position: positionOf(ins[index], byPosition) ?? "MID" });
  }
  return result;
}

/** Squad entering a gameweek: the latest earlier plan, else the imported baseline. */
function enteringSquadFor(state: TerminalState, gameweek: number): number[] {
  const prior = Object.keys(state.gameweekPlans)
    .map(Number)
    .filter((gw) => Number.isSafeInteger(gw) && gw < gameweek && state.gameweekPlans[gw])
    .sort((left, right) => right - left)[0];
  if (prior !== undefined) return [...state.gameweekPlans[prior].playerIds];
  if (state.transferBaseline) return [...state.transferBaseline.squadPlayerIds];
  return [...state.playerIds];
}

/**
 * When an earlier permanent squad change invalidates later plans, clear only
 * the later squad and transfer plans while retaining unaffected chip-only
 * lineup plans where possible. Returns the cleaned plans and the first cleared GW.
 */
export function invalidateDownstreamPlans(
  plans: Record<number, GameweekPlanSnapshot>,
  changedGameweek: number,
  outgoingId?: number,
  incomingId?: number,
): { plans: Record<number, GameweekPlanSnapshot>; firstClearedGameweek: number | null } {
  const next: Record<number, GameweekPlanSnapshot> = { ...plans };
  let firstCleared: number | null = null;
  for (const key of Object.keys(next)) {
    const gw = Number(key);
    if (!Number.isSafeInteger(gw) || gw <= changedGameweek) continue;
    const plan = next[gw];
    const referencesOutgoing = outgoingId !== undefined && plan.playerIds.includes(outgoingId);
    const alreadyHasIncoming = incomingId !== undefined && plan.playerIds.includes(incomingId);
    if (outgoingId === undefined) continue; // bench/captaincy-only edits never invalidate squads.
    if (!referencesOutgoing) continue;
    if (incomingId !== undefined && !alreadyHasIncoming) {
      // Remap the plan onto the new squad when every other player is shared.
      const remappedIds = plan.playerIds.map((id) => id === outgoingId ? incomingId : id);
      if (new Set(remappedIds).size !== remappedIds.length) {
        delete next[gw];
        firstCleared = firstCleared ?? gw;
        continue;
      }
      const incomingPosition = positionOf(incomingId, plan.byPosition) ?? positionOf(outgoingId, plan.byPosition);
      const byPosition = cloneSlotMap(plan.byPosition);
      if (incomingPosition) {
        for (const position of POSITIONS) byPosition[position] = byPosition[position].filter((id) => id !== outgoingId);
        if (!byPosition[incomingPosition].includes(incomingId)) byPosition[incomingPosition].push(incomingId);
      }
      const remap = (id: number) => id === outgoingId ? incomingId : id;
      next[gw] = {
        ...clonePlan(plan, gw),
        playerIds: remappedIds,
        byPosition,
        benchGoalkeeperId: plan.benchGoalkeeperId === outgoingId ? incomingId : plan.benchGoalkeeperId,
        benchOrder: plan.benchOrder.map(remap),
        lockedPlayerIds: plan.lockedPlayerIds.map(remap).filter((id) => remappedIds.includes(id)),
        captainId: plan.captainId === outgoingId ? incomingId : plan.captainId,
        viceCaptainId: plan.viceCaptainId === outgoingId ? incomingId : plan.viceCaptainId,
        plannedTransfers: plan.plannedTransfers.map((transfer) => ({
          outId: remap(transfer.outId),
          inId: remap(transfer.inId),
          position: transfer.position,
        })),
        // A permanent-line change also moves any preserved Free Hit
        // snapshot taken from that line, so later reversion stays exact.
        permanentSquad: plan.permanentSquad
          ? remapPermanentSnapshot(plan.permanentSquad, outgoingId, incomingId, incomingPosition)
          : undefined,
      };
      continue;
    }
    // Removal without replacement invalidates any later plan holding the player.
    delete next[gw];
    firstCleared = firstCleared ?? gw;
  }
  return { plans: next, firstClearedGameweek: firstCleared };
}

/** Moves a preserved Free Hit snapshot along a permanent-line change. */
function remapPermanentSnapshot(
  snapshot: PermanentSquadSnapshot,
  outgoingId: number,
  incomingId: number,
  incomingPosition: Position | undefined,
): PermanentSquadSnapshot {
  const remap = (id: number) => id === outgoingId ? incomingId : id;
  const mapOptional = (id: number | undefined) => id === undefined ? undefined : remap(id);
  if (!snapshot.playerIds.includes(outgoingId)) {
    return {
      playerIds: [...snapshot.playerIds],
      byPosition: cloneSlotMap(snapshot.byPosition),
      benchGoalkeeperId: snapshot.benchGoalkeeperId,
      benchOrder: [...snapshot.benchOrder],
      lockedPlayerIds: [...snapshot.lockedPlayerIds],
      captainId: snapshot.captainId,
      viceCaptainId: snapshot.viceCaptainId,
    };
  }
  const playerIds = snapshot.playerIds.includes(incomingId)
    // Slot already filled: drop the outgoing entry.
    ? snapshot.playerIds.filter((id) => id !== outgoingId)
    : snapshot.playerIds.map(remap);
  const byPosition = cloneSlotMap(snapshot.byPosition);
  const position = incomingPosition ?? positionOf(outgoingId, snapshot.byPosition);
  for (const slot of POSITIONS) byPosition[slot] = byPosition[slot].filter((id) => id !== outgoingId);
  if (position && !snapshot.playerIds.includes(incomingId) && !byPosition[position].includes(incomingId)) {
    byPosition[position].push(incomingId);
  }
  const lineup = conformLineupToSquad(
    playerIds,
    mapOptional(snapshot.benchGoalkeeperId),
    snapshot.benchOrder.map(remap),
    mapOptional(snapshot.captainId),
    mapOptional(snapshot.viceCaptainId),
  );
  return {
    playerIds,
    byPosition,
    benchGoalkeeperId: lineup.benchGoalkeeperId,
    benchOrder: lineup.benchOrder,
    lockedPlayerIds: snapshot.lockedPlayerIds.map(remap).filter((id) => playerIds.includes(id)),
    captainId: lineup.captainId,
    viceCaptainId: lineup.viceCaptainId,
  };
}

/** Captures the current squad and lineup as a Free Hit permanent snapshot. */
function takePermanentSnapshot(state: Pick<TerminalState, "playerIds" | "byPosition" | "benchGoalkeeperId" | "benchOrder" | "lockedPlayerIds" | "captainId" | "viceCaptainId">): PermanentSquadSnapshot {
  return {
    playerIds: [...state.playerIds],
    byPosition: cloneSlotMap(state.byPosition),
    benchGoalkeeperId: state.benchGoalkeeperId,
    benchOrder: [...state.benchOrder],
    lockedPlayerIds: [...state.lockedPlayerIds],
    captainId: state.captainId,
    viceCaptainId: state.viceCaptainId,
  };
}

function clonePermanentSnapshot(snapshot: PermanentSquadSnapshot): PermanentSquadSnapshot {
  return {
    playerIds: [...snapshot.playerIds],
    byPosition: cloneSlotMap(snapshot.byPosition),
    benchGoalkeeperId: snapshot.benchGoalkeeperId,
    benchOrder: [...snapshot.benchOrder],
    lockedPlayerIds: [...snapshot.lockedPlayerIds],
    captainId: snapshot.captainId,
    viceCaptainId: snapshot.viceCaptainId,
  };
}

/** Squad edits on a Free Hit week touch only the temporary squad, so later
 * permanent-line plans are unaffected. Every other edit invalidates. */
function squadChangeFor(state: TerminalState, change: { outgoingId?: number; incomingId?: number }): { outgoingId?: number; incomingId?: number } | undefined {
  if (state.chip === "freehit" && state.permanentSquad !== undefined) return undefined;
  return change;
}

function activePlanPatch(state: TerminalState, patch: Partial<Pick<TerminalState, "playerIds" | "byPosition" | "benchGoalkeeperId" | "benchOrder" | "lockedPlayerIds" | "captainId" | "viceCaptainId" | "lineupGameweek" | "lineupProjectionFingerprint" | "selectedPlayerId" | "chip" | "plannedTransfers" | "permanentSquad">>, squadChange?: { outgoingId?: number; incomingId?: number }): Partial<TerminalState> {  const next = { ...state, ...patch };
  const explicitTransfers = patch.plannedTransfers;
  // Pair sequential remove/add steps into transfers by diffing the squad
  // entering this gameweek against the new squad, so free editing still
  // yields correct transfer accounting.
  const enteringSquad = patch.playerIds || patch.byPosition ? enteringSquadFor(state, state.planningGameweek) : state.playerIds;
  const withTransfers: PlanStateFields = {
    ...next,
    plannedTransfers: explicitTransfers ?? (
      patch.playerIds || patch.byPosition
        ? diffTransfers(enteringSquad, next.playerIds, next.byPosition)
        : [...next.plannedTransfers]
    ),
  };
  let gameweekPlans = savePlan(state.gameweekPlans, planFromState(withTransfers));
  let planNotice = state.planNotice;
  if (squadChange && (squadChange.outgoingId !== undefined || squadChange.incomingId !== undefined)) {
    const invalidated = invalidateDownstreamPlans(gameweekPlans, state.planningGameweek, squadChange.outgoingId, squadChange.incomingId);
    gameweekPlans = invalidated.plans;
    planNotice = invalidated.firstClearedGameweek !== null
      ? `GW${invalidated.firstClearedGameweek} onward cleared after the squad change.`
      : planNotice;
  }
  const { selectedPlayerId: _ignored, ...rest } = patch as { selectedPlayerId?: number };
  void _ignored;
  return { ...rest, plannedTransfers: withTransfers.plannedTransfers, gameweekPlans, planNotice };
}

function positionOf(id: number, byPosition: SlotMap): Position | undefined {
  return (Object.keys(byPosition) as Position[]).find((position) => byPosition[position].includes(id));
}

export function deriveStartingXI(playerIds: readonly number[], benchGoalkeeperId: number | undefined, benchOrder: readonly number[]): number[] {
  const bench = new Set([benchGoalkeeperId, ...benchOrder]);
  return playerIds.filter((id) => !bench.has(id));
}

function placeholderPlayers(byPosition: SlotMap): Player[] {
  return (Object.keys(byPosition) as Position[]).flatMap((position) => byPosition[position].map((id) => ({
    id,
    firstName: "",
    lastName: "",
    displayName: String(id),
    teamId: id,
    teamName: "",
    teamShortName: "",
    position,
    priceTenths: 0,
    ownership: 0,
    status: "a",
    current: { totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 0 },
    fixtures: [],
  })));
}

function weeklyPlan(state: Pick<TerminalState, "playerIds" | "byPosition" | "benchGoalkeeperId" | "benchOrder" | "captainId" | "viceCaptainId">, gameweek: number, fingerprint: string, benchGoalkeeperId: number | undefined, benchOrder: readonly number[], startingXI: readonly number[]): WeeklyLineupPlan {
  const counts = startingXI.reduce((result, id) => {
    const position = positionOf(id, state.byPosition);
    if (position) result[position] += 1;
    return result;
  }, { GK: 0, DEF: 0, MID: 0, FWD: 0 });
  return {
    gameweek,
    starterIds: [...startingXI],
    formation: `${counts.DEF}-${counts.MID}-${counts.FWD}`,
    benchGoalkeeperId: benchGoalkeeperId ?? 0,
    benchOrder: [...benchOrder] as [number, number, number],
    captainId: state.captainId ?? 0,
    viceCaptainId: state.viceCaptainId ?? 0,
    projectedXI: 0,
    captainBonus: 0,
    projectedTotal: 0,
    autosubValue: 0,
    explanations: [],
    warnings: [],
    projectionFingerprint: fingerprint,
  };
}

function fallbackLineupErrors(state: Pick<TerminalState, "playerIds" | "byPosition">, startingXI: readonly number[], benchGoalkeeperId: number | undefined, benchOrder: readonly number[], captainId: number | undefined, viceCaptainId: number | undefined): string[] {
  const errors: string[] = [];
  const counts = startingXI.reduce((result, id) => {
    const position = positionOf(id, state.byPosition);
    if (position) result[position] += 1;
    return result;
  }, { GK: 0, DEF: 0, MID: 0, FWD: 0 });
  if (state.playerIds.length !== 15 || startingXI.length !== 11 || new Set(startingXI).size !== 11) errors.push("A weekly lineup needs a complete squad and 11 distinct starters.");
  if (benchGoalkeeperId === undefined || !state.byPosition.GK.includes(benchGoalkeeperId) || startingXI.includes(benchGoalkeeperId)) errors.push("Bench goalkeeper must be the non-starting goalkeeper.");
  if (benchOrder.length !== 3 || new Set(benchOrder).size !== 3 || benchOrder.some((id) => !state.playerIds.includes(id) || startingXI.includes(id) || positionOf(id, state.byPosition) === "GK")) errors.push("Bench order must contain three distinct non-starting outfield players.");
  if (counts.GK !== 1 || counts.DEF < 3 || counts.MID < 2 || counts.FWD < 1 || counts.DEF + counts.MID + counts.FWD !== 10) errors.push("The weekly XI does not satisfy formation rules.");
  if (captainId === undefined || viceCaptainId === undefined || !startingXI.includes(captainId) || !startingXI.includes(viceCaptainId) || captainId === viceCaptainId) errors.push("Captain and vice-captain must be different starters.");
  return errors;
}

function validLineup(state: Pick<TerminalState, "playerIds" | "byPosition" | "benchGoalkeeperId" | "benchOrder" | "captainId" | "viceCaptainId">, override: Partial<ApplyLineupInput>): { valid: boolean; errors: string[]; benchGoalkeeperId?: number; benchOrder: number[]; startingXI: number[]; captainId?: number; viceCaptainId?: number } {
  const errors: string[] = [];
  const benchGoalkeeperId = override.benchGoalkeeperId ?? state.benchGoalkeeperId;
  const benchOrder = [...(override.benchOrder ?? state.benchOrder)];
  const startingXI = deriveStartingXI(state.playerIds, benchGoalkeeperId, benchOrder);
  const captainId = override.captainId ?? state.captainId;
  const viceCaptainId = override.viceCaptainId ?? state.viceCaptainId;
  if (typeof override.gameweek !== "number" || !Number.isInteger(override.gameweek) || override.gameweek < 1) errors.push("Lineup gameweek must be a positive integer.");
  if (typeof override.lineupProjectionFingerprint !== "string" || !override.lineupProjectionFingerprint.trim()) errors.push("Lineup projection fingerprint is required.");
  if (typeof override.gameweek === "number" && typeof override.lineupProjectionFingerprint === "string") {
    try {
      const validation = validateWeeklyLineup(weeklyPlan({ ...state, captainId, viceCaptainId }, override.gameweek, override.lineupProjectionFingerprint, benchGoalkeeperId, benchOrder, startingXI), placeholderPlayers(state.byPosition));
      errors.push(...validation.errors);
    } catch {
      errors.push(...fallbackLineupErrors(state, startingXI, benchGoalkeeperId, benchOrder, captainId, viceCaptainId));
    }
  }
  if (errors.length) return { valid: false, errors, benchOrder, startingXI };
  return { valid: true, errors: [], benchGoalkeeperId, benchOrder, startingXI, captainId, viceCaptainId };
}

export function isLineupStale(lineupGameweek: number | undefined, lineupProjectionFingerprint: string | undefined, gameweek: number, projectionFingerprint: string, lineupChip?: ChipKind | null, chip?: ChipKind | null): boolean {
  if (lineupGameweek === undefined) return false;
  if (lineupGameweek !== gameweek || lineupProjectionFingerprint !== projectionFingerprint) return true;
  if (lineupChip !== undefined || chip !== undefined) return (lineupChip ?? null) !== (chip ?? null);
  return false;
}

export type ChipApplyInput = {
  gameweek: number;
  chip: ChipKind;
  squad?: SquadState;
  lineup?: ApplyLineupInput;
  plannedTransfers?: PlannedTransfer[];
  permanentSquad?: PermanentSquadSnapshot;
};

export type PreApplySnapshot = {
  gameweekPlans: Record<number, GameweekPlanSnapshot>;
  playerIds: number[];
  byPosition: SlotMap;
  benchGoalkeeperId?: number;
  benchOrder: number[];
  lockedPlayerIds: number[];
  captainId?: number;
  viceCaptainId?: number;
  lineupGameweek?: number;
  lineupProjectionFingerprint?: string;
  chip: ChipKind | null;
  plannedTransfers: PlannedTransfer[];
  permanentSquad?: PermanentSquadSnapshot;
  planningGameweek: number;
  transferBaseline: TransferBaseline | null;
};

export type TerminalState = {
  mode: TerminalMode | null;
  entryId?: number;
  budgetTenths: number;
  /** The league the manager last opened in the Leagues workspace. */
  selectedLeagueKey?: string;
  activeMobileTab: "SQUAD" | "MARKET";
  currentGameweek: number;
  planningGameweek: number;
  gameweekPlans: Record<number, GameweekPlanSnapshot>;
  playerIds: number[];
  byPosition: SlotMap;
  benchGoalkeeperId?: number;
  benchOrder: number[];
  lineupGameweek?: number;
  lineupProjectionFingerprint?: string;
  lockedPlayerIds: number[];
  captainId?: number;
  viceCaptainId?: number;
  chip: ChipKind | null;
  plannedTransfers: PlannedTransfer[];
  permanentSquad?: PermanentSquadSnapshot;
  transferBaseline: TransferBaseline | null;
  usedChips: Array<{ kind: ChipKind; gameweek: number }>;
  planNotice: string | null;
  preApplySnapshot: PreApplySnapshot | null;
  selectedPlayerId?: number;
  search: string;
  filters: TerminalFilters;
  sortKey: SortKey;
  sortDirection: "asc" | "desc";
  horizon: Horizon;
  transferHorizon: Horizon;
  riskMode: RiskMode;
  benchStrategy: BenchStrategy;
  panelRatios: Partial<Record<DesktopPanel, number>>;
  dismissedTransferKeys: string[];
  isHydrated: boolean;
  setMode: (mode: TerminalMode | null) => void;
  /** Market spend and the displayed bank let the store update either a hand-built budget or an imported baseline. */
  setBankTenths: (tenths: number, spentTenths: number, displayedTenths: number) => boolean;
  initializeGameweek: (currentGameweek: number) => number;
  setPlanningGameweek: (gameweek: number) => boolean;
  switchGameweek: (gameweek: number) => boolean;
  setMobileTab: (tab: TerminalState["activeMobileTab"]) => void;
  setSearch: (search: string) => void;
  setFilters: (filters: Partial<TerminalFilters>) => void;
  setSort: (sortKey: SortKey) => void;
  addPlayer: (id: number, position: Position) => boolean;
  removePlayer: (id: number) => boolean;
  replacePlayer: (outgoingId: number, incomingId: number, position: Position) => boolean;
  replaceSquad: (squad: SquadState, lineup: ApplyLineupInput, entryId: number, budgetTenths?: number, options?: { transferBaseline?: TransferBaseline | null; usedChips?: Array<{ kind: ChipKind; gameweek: number }> }) => boolean;
  setChip: (gameweek: number, chip: ChipKind | null) => boolean;
  applyChipSuggestion: (input: ChipApplyInput) => boolean;
  undoChipApply: () => boolean;
  clearPlanNotice: () => void;
  setTransferBaseline: (baseline: TransferBaseline | null) => void;
  toggleLock: (id: number) => void;
  setSelectedPlayer: (id?: number) => void;
  setStrategy: (strategy: Partial<Pick<TerminalState, "horizon" | "transferHorizon" | "riskMode" | "benchStrategy">>) => void;
  setPanelRatios: (ratios: Partial<Record<DesktopPanel, number>>) => void;
  setSelectedLeagueKey: (key: string) => void;
  dismissTransferSuggestion: (outgoingId: number, incomingId: number) => void;
  setCaptain: (id?: number) => boolean;
  setViceCaptain: (id?: number) => boolean;
  applyLineup: (input: ApplyLineupInput) => boolean;
  swapStarterBench: (starterId: number, benchId: number) => boolean;
  reorderBench: (order: number[]) => boolean;
  hydrate: (state: Partial<PersistedTerminalState> | null) => void;
  reset: () => void;
};

const initial = {
  mode: null,
  entryId: undefined,
  budgetTenths: INITIAL_BUDGET_TENTHS,
  selectedLeagueKey: undefined as string | undefined,
  activeMobileTab: "SQUAD" as const,
  currentGameweek: 1,
  planningGameweek: 1,
  gameweekPlans: {} as Record<number, GameweekPlanSnapshot>,
  playerIds: [],
  byPosition: emptySlots(),
  benchGoalkeeperId: undefined,
  benchOrder: [],
  lineupGameweek: undefined,
  lineupProjectionFingerprint: undefined,
  lockedPlayerIds: [],
  captainId: undefined,
  viceCaptainId: undefined,
  chip: null as ChipKind | null,
  plannedTransfers: [] as PlannedTransfer[],
  permanentSquad: undefined as PermanentSquadSnapshot | undefined,
  transferBaseline: null as TransferBaseline | null,
  usedChips: [] as Array<{ kind: ChipKind; gameweek: number }>,
  planNotice: null as string | null,
  preApplySnapshot: null as PreApplySnapshot | null,
  selectedPlayerId: undefined,
  search: "",
  filters: {
    position: "ALL" as const,
    club: "",
    minPrice: "",
    maxPrice: "",
    minOwnership: "",
    maxOwnership: "",
    availability: "ALL" as const,
    confidence: "ALL" as const,
    risk: "ALL" as const,
    affordableOnly: false,
    excludeSelected: false,
    quick: "ALL" as const,
  },
  sortKey: "nextGW" as SortKey,
  sortDirection: "desc" as const,
  horizon: 5 as const,
  transferHorizon: 5 as const,
  riskMode: "BALANCED" as const,
  benchStrategy: "BALANCED" as const,
  panelRatios: {},
  dismissedTransferKeys: [],
  isHydrated: false,
};

export const useTerminalStore = create<TerminalState>((set, get) => ({
  ...initial,
  setMode: (mode) => set({ mode }),
  setBankTenths: (tenths, spentTenths, displayedTenths) => {
    if (!Number.isSafeInteger(tenths) || tenths < 0 || !Number.isSafeInteger(displayedTenths)) return false;
    const state = get();
    // An imported team has a real baseline, so the bank is a fact about it and
    // the replay debits it as transfers are planned.
    if (state.entryId !== undefined && state.transferBaseline) {
      const baseline = state.transferBaseline;
      const adjustedBaselineBank = baseline.bankTenths + tenths - displayedTenths;
      if (adjustedBaselineBank < 0) return false;
      set({
        transferBaseline: {
          ...baseline,
          // The field shows the replayed bank. Move the baseline by the edit's
          // delta so planned transfers are not applied to the typed value twice.
          bankTenths: adjustedBaselineBank,
          financialConfidence: "ESTIMATED",
          warnings: [
            ...baseline.warnings.filter((text) => !text.startsWith("Bank set by hand")),
            "Bank set by hand; finances are ESTIMATED.",
          ],
        },
      });
      return true;
    }
    // A squad built by hand has no bank of its own: what is left to spend is
    // the budget minus what the squad costs. Move the budget, so the figure
    // keeps falling as players are added rather than freezing.
    if (!Number.isSafeInteger(spentTenths) || spentTenths < 0) return false;
    set({ budgetTenths: spentTenths + tenths });
    return true;
  },
  initializeGameweek: (currentGameweek) => {
    const normalized = validGameweek(currentGameweek) ? currentGameweek : 1;
    set({ currentGameweek: normalized });
    const state = get();
    const target = clampGameweek(state.planningGameweek, normalized);
    state.setPlanningGameweek(target);
    return target;
  },
  setPlanningGameweek: (requestedGameweek) => {
    const state = get();
    const gameweek = clampGameweek(requestedGameweek, state.currentGameweek);
    const savedPlans = savePlan(state.gameweekPlans, planFromState(state));
    const exact = savedPlans[gameweek];
    let source = exact ?? nearestPriorPlan(savedPlans, gameweek) ?? planFromState(state, gameweek);
    // Free Hit reversion: weeks after a Free Hit restore the preserved
    // permanent squad and lineup instead of carrying temporary picks forward.
    if (!exact && source.chip === "freehit" && source.gameweek < gameweek && source.permanentSquad) {
      const snap = source.permanentSquad;
      const lineup = conformLineupToSquad(snap.playerIds, snap.benchGoalkeeperId, snap.benchOrder, snap.captainId, snap.viceCaptainId);
      source = {
        ...clonePlan(source, gameweek),
        playerIds: [...snap.playerIds],
        byPosition: cloneSlotMap(snap.byPosition),
        benchGoalkeeperId: lineup.benchGoalkeeperId,
        benchOrder: lineup.benchOrder,
        lockedPlayerIds: [...snap.lockedPlayerIds],
        captainId: lineup.captainId,
        viceCaptainId: lineup.viceCaptainId,
        chip: null,
        plannedTransfers: [],
        permanentSquad: undefined,
      };
    }
    const restored = clonePlan(source, gameweek);
    if (!exact && source.lineupGameweek !== undefined) restored.lineupGameweek = gameweek;
    set({
      planningGameweek: gameweek,
      playerIds: [...restored.playerIds],
      byPosition: cloneSlotMap(restored.byPosition),
      benchGoalkeeperId: restored.benchGoalkeeperId,
      benchOrder: [...restored.benchOrder],
      lockedPlayerIds: [...restored.lockedPlayerIds],
      captainId: restored.captainId,
      viceCaptainId: restored.viceCaptainId,
      lineupGameweek: restored.lineupGameweek,
      lineupProjectionFingerprint: restored.lineupProjectionFingerprint,
      chip: restored.chip,
      plannedTransfers: restored.plannedTransfers.map((transfer) => ({ ...transfer })),
      permanentSquad: restored.permanentSquad ? clonePermanentSnapshot(restored.permanentSquad) : undefined,
      selectedPlayerId: undefined,
      gameweekPlans: savePlan(savedPlans, restored),
    });
    return true;
  },
  switchGameweek: (gameweek) => get().setPlanningGameweek(gameweek),
  setMobileTab: (activeMobileTab) => set({ activeMobileTab }),
  setSearch: (search) => set({ search }),
  setFilters: (filters) => set((state) => ({ filters: { ...state.filters, ...filters } })),
  setSort: (sortKey) => set((state) => ({
    sortKey,
    sortDirection: state.sortKey === sortKey && state.sortDirection === "desc" ? "asc" : "desc",
  })),
  addPlayer: (id, position) => {
    const state = get();
    if (state.playerIds.includes(id)) return false;
    const limits: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
    if (state.byPosition[position].length >= limits[position] || state.playerIds.length >= 15) return false;
    set(activePlanPatch(state, {
      playerIds: [...state.playerIds, id],
      byPosition: { ...state.byPosition, [position]: [...state.byPosition[position], id] },
    }, squadChangeFor(state, { incomingId: id })));
    return true;
  },
  removePlayer: (id) => {
    const state = get();
    if (state.lockedPlayerIds.includes(id)) return false;
    const position = positionOf(id, state.byPosition);
    set(activePlanPatch(state, {
      playerIds: state.playerIds.filter((playerId) => playerId !== id),
      byPosition: position ? { ...state.byPosition, [position]: state.byPosition[position].filter((playerId) => playerId !== id) } : state.byPosition,
      benchGoalkeeperId: state.benchGoalkeeperId === id ? undefined : state.benchGoalkeeperId,
      benchOrder: state.benchOrder.filter((playerId) => playerId !== id),
      lockedPlayerIds: state.lockedPlayerIds.filter((playerId) => playerId !== id),
      captainId: state.captainId === id ? undefined : state.captainId,
      viceCaptainId: state.viceCaptainId === id ? undefined : state.viceCaptainId,
    }, squadChangeFor(state, { outgoingId: id })));
    return true;
  },
  replacePlayer: (outgoingId, incomingId, position) => {
    const state = get();
    if (state.lockedPlayerIds.includes(outgoingId) || state.playerIds.includes(incomingId) || positionOf(outgoingId, state.byPosition) !== position) return false;
    set(activePlanPatch(state, {
      playerIds: state.playerIds.map((id) => id === outgoingId ? incomingId : id),
      byPosition: { ...state.byPosition, [position]: state.byPosition[position].map((id) => id === outgoingId ? incomingId : id) },
      benchGoalkeeperId: state.benchGoalkeeperId === outgoingId ? incomingId : state.benchGoalkeeperId,
      benchOrder: state.benchOrder.map((id) => id === outgoingId ? incomingId : id),
      captainId: state.captainId === outgoingId ? incomingId : state.captainId,
      viceCaptainId: state.viceCaptainId === outgoingId ? incomingId : state.viceCaptainId,
    }, squadChangeFor(state, { outgoingId, incomingId })));
    return true;
  },
  replaceSquad: (squad, lineup, entryId, budgetTenths = INITIAL_BUDGET_TENTHS, options) => {
    const counts: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
    const listed = (Object.keys(counts) as Position[]).flatMap((position) => squad.byPosition[position]);
    if (squad.playerIds.length !== 15
      || new Set(squad.playerIds).size !== 15
      || listed.length !== 15
      || new Set(listed).size !== 15
      || listed.some((id) => !squad.playerIds.includes(id))
      || (Object.keys(counts) as Position[]).some((position) => squad.byPosition[position].length !== counts[position])
      || !Number.isSafeInteger(entryId)
      || entryId < 1
      || !validBudget(budgetTenths)) return false;
    const byPosition = Object.fromEntries((Object.keys(counts) as Position[]).map((position) => [position, [...squad.byPosition[position]]])) as SlotMap;
    const checked = validLineup({
      playerIds: squad.playerIds,
      byPosition,
      benchGoalkeeperId: lineup.benchGoalkeeperId,
      benchOrder: lineup.benchOrder ?? [],
      captainId: lineup.captainId,
      viceCaptainId: lineup.viceCaptainId,
    }, lineup);
    if (!checked.valid || checked.benchGoalkeeperId === undefined) return false;
    const baseline = options?.transferBaseline !== undefined ? sanitizeBaseline(options.transferBaseline) : get().transferBaseline;
    const usedChips = options?.usedChips !== undefined ? sanitizeUsedChips(options.usedChips) : get().usedChips;
    const next = {
      playerIds: [...squad.playerIds],
      byPosition,
      benchGoalkeeperId: checked.benchGoalkeeperId,
      benchOrder: checked.benchOrder,
      lineupGameweek: lineup.gameweek,
      lineupProjectionFingerprint: lineup.lineupProjectionFingerprint.trim(),
      lockedPlayerIds: [...squad.playerIds],
      captainId: checked.captainId,
      viceCaptainId: checked.viceCaptainId,
      selectedPlayerId: undefined,
      entryId,
      budgetTenths,
      chip: null as ChipKind | null,
      plannedTransfers: [] as PlannedTransfer[],
      permanentSquad: undefined as PermanentSquadSnapshot | undefined,
      transferBaseline: baseline,
      usedChips,
      planNotice: null as string | null,
      preApplySnapshot: null as PreApplySnapshot | null,
    };
    const gameweek = lineup.gameweek;
    const nextState = { ...get(), ...next, planningGameweek: clampGameweek(gameweek, get().currentGameweek), gameweekPlans: {} };
    set({ ...next, planningGameweek: nextState.planningGameweek, gameweekPlans: { [gameweek]: planFromState(nextState, gameweek) } });
    return true;
  },
  setChip: (gameweek, chip) => {
    const state = get();
    if (!validGameweek(gameweek)) return false;
    if (chip !== null && !validChip(chip)) return false;
    const planned: Record<number, ChipKind | null> = {};
    for (const [key, plan] of Object.entries(state.gameweekPlans)) planned[Number(key)] = plan.chip;
    if (state.planningGameweek === gameweek) planned[gameweek] = state.chip;
    // Validate against official usage + planned chips (excluding this GW's current value).
    const plannedForValidation: Record<number, ChipKind | null> = { ...planned };
    delete plannedForValidation[gameweek];
    if (state.planningGameweek === gameweek) {
      // current state's chip is being replaced; already removed above.
    } else if (state.gameweekPlans[gameweek]) {
      // exact plan's chip already excluded by delete.
    }
    const legality = validateChipSelection(chip, gameweek, state.usedChips, plannedForValidation, state.currentGameweek);
    if (!legality.legal) return false;
    const onFreeHit = (candidateChip: ChipKind | null, snapshot: PermanentSquadSnapshot | undefined) =>
      candidateChip === "freehit" && snapshot !== undefined;
    if (state.planningGameweek === gameweek) {
      if (onFreeHit(state.chip, state.permanentSquad) && chip !== "freehit") {
        // Leaving a Free Hit restores the preserved permanent squad and
        // lineup; the temporary picks never became real.
        const snap = state.permanentSquad!;
        const lineup = conformLineupToSquad(snap.playerIds, snap.benchGoalkeeperId, snap.benchOrder, snap.captainId, snap.viceCaptainId);
        set(activePlanPatch(state, {
          chip,
          playerIds: [...snap.playerIds],
          byPosition: cloneSlotMap(snap.byPosition),
          benchGoalkeeperId: lineup.benchGoalkeeperId,
          benchOrder: lineup.benchOrder,
          lockedPlayerIds: [...snap.lockedPlayerIds],
          captainId: lineup.captainId,
          viceCaptainId: lineup.viceCaptainId,
          permanentSquad: undefined,
        }));
      } else if (chip === "freehit" && !onFreeHit(state.chip, state.permanentSquad)) {
        // Entering a Free Hit preserves the current permanent squad/lineup.
        set(activePlanPatch(state, { chip, permanentSquad: takePermanentSnapshot(state) }));
      } else {
        set(activePlanPatch(state, { chip, permanentSquad: onFreeHit(chip, state.permanentSquad) ? clonePermanentSnapshot(state.permanentSquad!) : undefined }));
      }
    } else {
      const existing = state.gameweekPlans[gameweek];
      // Base a new plan on the permanent line, never on another week's
      // temporary Free Hit squad.
      const viewingTemp = onFreeHit(state.chip, state.permanentSquad);
      const permanentBase = viewingTemp && !existing ? state.permanentSquad! : undefined;
      const base = existing ?? {
        gameweek,
        playerIds: permanentBase ? [...permanentBase.playerIds] : [...state.playerIds],
        byPosition: permanentBase ? cloneSlotMap(permanentBase.byPosition) : cloneSlotMap(state.byPosition),
        benchGoalkeeperId: permanentBase?.benchGoalkeeperId ?? state.benchGoalkeeperId,
        benchOrder: permanentBase ? [...permanentBase.benchOrder] : [...state.benchOrder],
        lockedPlayerIds: permanentBase ? [...permanentBase.lockedPlayerIds] : [...state.lockedPlayerIds],
        captainId: permanentBase?.captainId ?? state.captainId,
        viceCaptainId: permanentBase?.viceCaptainId ?? state.viceCaptainId,
        chip: null as ChipKind | null,
        plannedTransfers: [] as PlannedTransfer[],
      };
      const existingSnap = existing?.chip === "freehit" ? existing.permanentSquad : undefined;
      let playerIds = [...base.playerIds];
      let byPosition = cloneSlotMap(base.byPosition);
      let benchGoalkeeperId = state.gameweekPlans[gameweek]?.benchGoalkeeperId ?? base.benchGoalkeeperId;
      let benchOrder = state.gameweekPlans[gameweek]?.benchOrder ?? [...base.benchOrder];
      let lockedPlayerIds = state.gameweekPlans[gameweek]?.lockedPlayerIds ?? [...base.lockedPlayerIds];
      let captainId = state.gameweekPlans[gameweek]?.captainId ?? base.captainId;
      let viceCaptainId = state.gameweekPlans[gameweek]?.viceCaptainId ?? base.viceCaptainId;
      let permanentSquad: PermanentSquadSnapshot | undefined;
      if (chip === "freehit") {
        // Re-selecting keeps the preserved permanent squad; a fresh Free Hit
        // preserves the base squad and lineup it was set from.
        permanentSquad = existingSnap ? clonePermanentSnapshot(existingSnap) : takePermanentSnapshot({
          playerIds, byPosition, benchGoalkeeperId, benchOrder, lockedPlayerIds, captainId, viceCaptainId,
        });
      } else if (existingSnap) {
        // Leaving a Free Hit restores the preserved permanent squad/lineup.
        const lineup = conformLineupToSquad(existingSnap.playerIds, existingSnap.benchGoalkeeperId, existingSnap.benchOrder, existingSnap.captainId, existingSnap.viceCaptainId);
        playerIds = [...existingSnap.playerIds];
        byPosition = cloneSlotMap(existingSnap.byPosition);
        benchGoalkeeperId = lineup.benchGoalkeeperId;
        benchOrder = lineup.benchOrder;
        lockedPlayerIds = [...existingSnap.lockedPlayerIds];
        captainId = lineup.captainId;
        viceCaptainId = lineup.viceCaptainId;
        permanentSquad = undefined;
      }
      const updated: GameweekPlanSnapshot = clonePlan({
        gameweek,
        playerIds,
        byPosition,
        benchGoalkeeperId,
        benchOrder,
        lockedPlayerIds,
        captainId,
        viceCaptainId,
        lineupGameweek: state.gameweekPlans[gameweek]?.lineupGameweek,
        lineupProjectionFingerprint: state.gameweekPlans[gameweek]?.lineupProjectionFingerprint,
        chip,
        plannedTransfers: state.gameweekPlans[gameweek]?.plannedTransfers ?? [],
        permanentSquad,
      }, gameweek);
      const clean = sanitizePlan(updated, gameweek);
      if (!clean) return false;
      set({ gameweekPlans: { ...state.gameweekPlans, [gameweek]: clean } });
    }
    return true;
  },
  applyChipSuggestion: (input) => {
    const state = get();
    if (!validGameweek(input.gameweek)) return false;
    const planned: Record<number, ChipKind | null> = {};
    for (const [key, plan] of Object.entries(state.gameweekPlans)) planned[Number(key)] = plan.chip;
    const plannedForValidation: Record<number, ChipKind | null> = { ...planned };
    delete plannedForValidation[input.gameweek];
    const legality = validateChipSelection(input.chip, input.gameweek, state.usedChips, plannedForValidation, state.currentGameweek);
    if (!legality.legal) return false;
    // Validate the generated squad shape when one is supplied.
    let nextSquad: { playerIds: number[]; byPosition: SlotMap } | undefined;
    if (input.squad) {
      const counts: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
      const listed = (Object.keys(counts) as Position[]).flatMap((position) => input.squad!.byPosition[position]);
      if (input.squad.playerIds.length !== 15
        || new Set(input.squad.playerIds).size !== 15
        || listed.length !== 15
        || new Set(listed).size !== 15
        || (Object.keys(counts) as Position[]).some((position) => input.squad!.byPosition[position].length !== counts[position])) return false;
      nextSquad = { playerIds: [...input.squad.playerIds], byPosition: cloneSlotMap(input.squad.byPosition) };
    }
    // Validate the recommended lineup against the post-apply squad.
    const squadForLineup = nextSquad ?? { playerIds: state.playerIds, byPosition: state.byPosition };
    if (input.lineup) {
      const checked = validLineup(
        {
          playerIds: squadForLineup.playerIds,
          byPosition: squadForLineup.byPosition,
          benchGoalkeeperId: input.lineup.benchGoalkeeperId ?? state.benchGoalkeeperId,
          benchOrder: input.lineup.benchOrder ?? state.benchOrder,
          captainId: input.lineup.captainId ?? state.captainId,
          viceCaptainId: input.lineup.viceCaptainId ?? state.viceCaptainId,
        },
        { ...input.lineup, gameweek: input.gameweek },
      );
      if (!checked.valid) return false;
    }
    // One ephemeral pre-apply snapshot for one-click Undo (never persisted).
    const snapshot: PreApplySnapshot = {
      gameweekPlans: Object.fromEntries(Object.entries(state.gameweekPlans).map(([key, plan]) => [key, clonePlan(plan)])),
      playerIds: [...state.playerIds],
      byPosition: cloneSlotMap(state.byPosition),
      benchGoalkeeperId: state.benchGoalkeeperId,
      benchOrder: [...state.benchOrder],
      lockedPlayerIds: [...state.lockedPlayerIds],
      captainId: state.captainId,
      viceCaptainId: state.viceCaptainId,
      lineupGameweek: state.lineupGameweek,
      lineupProjectionFingerprint: state.lineupProjectionFingerprint,
      chip: state.chip,
      plannedTransfers: state.plannedTransfers.map((transfer) => ({ ...transfer })),
      permanentSquad: state.permanentSquad ? clonePermanentSnapshot(state.permanentSquad) : undefined,
      planningGameweek: state.planningGameweek,
      transferBaseline: state.transferBaseline ? sanitizeBaseline(JSON.parse(JSON.stringify(state.transferBaseline))) : null,
    };
    const targetPlan = state.planningGameweek === input.gameweek ? undefined : state.gameweekPlans[input.gameweek];
    const targetIsFH = state.planningGameweek === input.gameweek
      ? state.chip === "freehit"
      : targetPlan?.chip === "freehit";
    const targetPermanent = (state.planningGameweek === input.gameweek ? state.permanentSquad : targetPlan?.permanentSquad) ?? undefined;
    const existingPermanent = targetIsFH && targetPermanent ? clonePermanentSnapshot(targetPermanent) : undefined;
    // Squad and lineup currently at the target week (temporary when it is a
    // Free Hit week); the Free Hit permanent snapshot is preserved separately.
    const preApplySquad = state.planningGameweek === input.gameweek
      ? { playerIds: state.playerIds, byPosition: state.byPosition }
      : { playerIds: targetPlan?.playerIds ?? state.playerIds, byPosition: targetPlan?.byPosition ?? state.byPosition };
    const permanentSquad = input.chip === "freehit"
      ? input.permanentSquad ? clonePermanentSnapshot(input.permanentSquad) : existingPermanent ?? takePermanentSnapshot({
        playerIds: [...preApplySquad.playerIds],
        byPosition: cloneSlotMap(preApplySquad.byPosition),
        benchGoalkeeperId: state.planningGameweek === input.gameweek ? state.benchGoalkeeperId : targetPlan?.benchGoalkeeperId,
        benchOrder: [...(state.planningGameweek === input.gameweek ? state.benchOrder : targetPlan?.benchOrder ?? [])],
        lockedPlayerIds: [...(state.planningGameweek === input.gameweek ? state.lockedPlayerIds : targetPlan?.lockedPlayerIds ?? [])],
        captainId: state.planningGameweek === input.gameweek ? state.captainId : targetPlan?.captainId,
        viceCaptainId: state.planningGameweek === input.gameweek ? state.viceCaptainId : targetPlan?.viceCaptainId,
      })
      : undefined;
    // Atomically set chip, squad/lineup, transfers, and captaincy.
    if (state.planningGameweek === input.gameweek) {
      const patch: Partial<TerminalState> = {
        chip: input.chip,
        permanentSquad,
        plannedTransfers: (input.plannedTransfers ?? state.plannedTransfers).map((transfer) => ({ ...transfer })),
        preApplySnapshot: snapshot,
      };
      if (nextSquad) {
        patch.playerIds = nextSquad.playerIds;
        patch.byPosition = nextSquad.byPosition;
      } else if (input.chip !== "freehit" && existingPermanent) {
        // Advice without a squad (BB/TC) over a Free Hit week applies to
        // the restored permanent squad, not the temporary picks.
        const lineup = conformLineupToSquad(existingPermanent.playerIds, existingPermanent.benchGoalkeeperId, existingPermanent.benchOrder, existingPermanent.captainId, existingPermanent.viceCaptainId);
        patch.playerIds = [...existingPermanent.playerIds];
        patch.byPosition = cloneSlotMap(existingPermanent.byPosition);
        patch.benchGoalkeeperId = lineup.benchGoalkeeperId;
        patch.benchOrder = lineup.benchOrder;
        patch.lockedPlayerIds = [...existingPermanent.lockedPlayerIds];
        patch.captainId = lineup.captainId;
        patch.viceCaptainId = lineup.viceCaptainId;
      }
      if (input.lineup) {
        const checked = validLineup({ ...state, ...patch, playerIds: patch.playerIds ?? state.playerIds, byPosition: patch.byPosition ?? state.byPosition }, { ...input.lineup, gameweek: input.gameweek });
        if (!checked.valid || checked.benchGoalkeeperId === undefined) return false;
        patch.benchGoalkeeperId = checked.benchGoalkeeperId;
        patch.benchOrder = checked.benchOrder;
        patch.captainId = checked.captainId;
        patch.viceCaptainId = checked.viceCaptainId;
        patch.lineupGameweek = input.gameweek;
        patch.lineupProjectionFingerprint = input.lineup.lineupProjectionFingerprint.trim();
      }
      // Squad changes from WC/FH advice invalidate downstream plans the same way.
      const beforeIds = [...state.playerIds];
      set({ preApplySnapshot: snapshot });
      set(activePlanPatch({ ...state, preApplySnapshot: snapshot }, patch));
      void beforeIds;
    } else {
      const existing = state.gameweekPlans[input.gameweek];
      // Advice without a squad over a Free Hit week applies to the restored
      // permanent squad rather than the temporary picks.
      const restorePermanent = !nextSquad && input.chip !== "freehit" && existingPermanent;
      const baseIds = nextSquad?.playerIds ?? (restorePermanent ? [...existingPermanent!.playerIds] : existing?.playerIds) ?? [...state.playerIds];
      const baseByPosition = nextSquad?.byPosition ?? (restorePermanent ? cloneSlotMap(existingPermanent!.byPosition) : existing?.byPosition) ?? cloneSlotMap(state.byPosition);
      const restoredLineup = restorePermanent
        ? conformLineupToSquad(existingPermanent!.playerIds, existingPermanent!.benchGoalkeeperId, existingPermanent!.benchOrder, existingPermanent!.captainId, existingPermanent!.viceCaptainId)
        : undefined;
      const updated: GameweekPlanSnapshot = clonePlan({
        gameweek: input.gameweek,
        playerIds: baseIds,
        byPosition: baseByPosition,
        benchGoalkeeperId: input.lineup?.benchGoalkeeperId ?? restoredLineup?.benchGoalkeeperId ?? existing?.benchGoalkeeperId ?? state.benchGoalkeeperId,
        benchOrder: input.lineup?.benchOrder ?? (restoredLineup ? [...restoredLineup.benchOrder] : existing?.benchOrder) ?? [...state.benchOrder],
        lockedPlayerIds: restorePermanent ? [...existingPermanent!.lockedPlayerIds] : existing?.lockedPlayerIds ?? [...state.lockedPlayerIds],
        captainId: input.lineup?.captainId ?? restoredLineup?.captainId ?? existing?.captainId ?? state.captainId,
        viceCaptainId: input.lineup?.viceCaptainId ?? restoredLineup?.viceCaptainId ?? existing?.viceCaptainId ?? state.viceCaptainId,
        lineupGameweek: input.lineup ? input.gameweek : existing?.lineupGameweek,
        lineupProjectionFingerprint: input.lineup ? input.lineup.lineupProjectionFingerprint.trim() : existing?.lineupProjectionFingerprint,
        chip: input.chip,
        plannedTransfers: (input.plannedTransfers ?? existing?.plannedTransfers ?? []).map((transfer) => ({ ...transfer })),
        permanentSquad,
      }, input.gameweek);
      const clean = sanitizePlan(updated, input.gameweek);
      if (!clean) return false;
      set({ preApplySnapshot: snapshot, gameweekPlans: { ...state.gameweekPlans, [input.gameweek]: clean } });
    }
    return true;
  },
  undoChipApply: () => {
    const state = get();
    const snapshot = state.preApplySnapshot;
    if (!snapshot) return false;
    set({
      gameweekPlans: Object.fromEntries(Object.entries(snapshot.gameweekPlans).map(([key, plan]) => [key, clonePlan(plan)])),
      playerIds: [...snapshot.playerIds],
      byPosition: cloneSlotMap(snapshot.byPosition),
      benchGoalkeeperId: snapshot.benchGoalkeeperId,
      benchOrder: [...snapshot.benchOrder],
      lockedPlayerIds: [...snapshot.lockedPlayerIds],
      captainId: snapshot.captainId,
      viceCaptainId: snapshot.viceCaptainId,
      lineupGameweek: snapshot.lineupGameweek,
      lineupProjectionFingerprint: snapshot.lineupProjectionFingerprint,
      chip: snapshot.chip,
      plannedTransfers: snapshot.plannedTransfers.map((transfer) => ({ ...transfer })),
      permanentSquad: snapshot.permanentSquad ? clonePermanentSnapshot(snapshot.permanentSquad) : undefined,
      planningGameweek: snapshot.planningGameweek,
      transferBaseline: snapshot.transferBaseline,
      preApplySnapshot: null,
      planNotice: "Chip advice undone.",
    });
    return true;
  },
  clearPlanNotice: () => set({ planNotice: null }),
  setTransferBaseline: (baseline) => set({ transferBaseline: sanitizeBaseline(baseline) }),
  toggleLock: (id) => set((state) => activePlanPatch(state, {
    lockedPlayerIds: state.lockedPlayerIds.includes(id)
      ? state.lockedPlayerIds.filter((playerId) => playerId !== id)
      : [...state.lockedPlayerIds, id],
  })),
  setSelectedPlayer: (selectedPlayerId) => set({ selectedPlayerId }),
  setStrategy: (strategy) => set(strategy),
  setSelectedLeagueKey: (key) => {
    if (isLeagueKey(key)) set({ selectedLeagueKey: key });
  },
  setPanelRatios: (ratios) => set({ panelRatios: sanitizePanelRatios(ratios) }),
  dismissTransferSuggestion: (outgoingId, incomingId) => {
    if (!Number.isSafeInteger(outgoingId) || outgoingId < 1 || !Number.isSafeInteger(incomingId) || incomingId < 1) return;
    const key = `${outgoingId}:${incomingId}`;
    set((state) => state.dismissedTransferKeys.includes(key) ? state : { dismissedTransferKeys: [...state.dismissedTransferKeys, key].slice(-600) });
  },
  setCaptain: (captainId) => {
    const state = get();
    const startingXI = deriveStartingXI(state.playerIds, state.benchGoalkeeperId, state.benchOrder);
    const lineupApplied = state.lineupGameweek !== undefined && state.lineupProjectionFingerprint !== undefined;
    if (lineupApplied && (captainId === undefined || state.viceCaptainId === undefined)) return false;
    if (captainId !== undefined && (startingXI.length !== 11 || !startingXI.includes(captainId) || captainId === state.viceCaptainId)) return false;
    set(activePlanPatch(state, { captainId }));
    return true;
  },
  setViceCaptain: (viceCaptainId) => {
    const state = get();
    const startingXI = deriveStartingXI(state.playerIds, state.benchGoalkeeperId, state.benchOrder);
    const lineupApplied = state.lineupGameweek !== undefined && state.lineupProjectionFingerprint !== undefined;
    if (lineupApplied && (viceCaptainId === undefined || state.captainId === undefined)) return false;
    if (viceCaptainId !== undefined && (startingXI.length !== 11 || !startingXI.includes(viceCaptainId) || viceCaptainId === state.captainId)) return false;
    set(activePlanPatch(state, { viceCaptainId }));
    return true;
  },
  applyLineup: (input) => {
    const state = get();
    const checked = validLineup(state, input);
    if (!checked.valid || checked.benchGoalkeeperId === undefined) return false;
    set(activePlanPatch(state, {
      benchGoalkeeperId: checked.benchGoalkeeperId,
      benchOrder: checked.benchOrder,
      captainId: checked.captainId,
      viceCaptainId: checked.viceCaptainId,
      lineupGameweek: input.gameweek,
      lineupProjectionFingerprint: input.lineupProjectionFingerprint.trim(),
    }));
    return true;
  },
  swapStarterBench: (starterId, benchId) => {
    const state = get();
    const benchIds = [state.benchGoalkeeperId, ...state.benchOrder].filter((id): id is number => id !== undefined);
    const startingXI = deriveStartingXI(state.playerIds, state.benchGoalkeeperId, state.benchOrder);
    if (!startingXI.includes(starterId) || !benchIds.includes(benchId)) return false;
    if (state.captainId === starterId || state.viceCaptainId === starterId) return false;
    const nextStartingXI = startingXI.map((id) => id === starterId ? benchId : id);
    const benchGoalkeeperId = state.benchGoalkeeperId === benchId ? starterId : state.benchGoalkeeperId;
    const benchOrder = state.benchOrder.map((id) => id === benchId ? starterId : id);
    const lineupApplied = state.lineupGameweek !== undefined && state.lineupProjectionFingerprint !== undefined;
    if (lineupApplied && (state.captainId === undefined || state.viceCaptainId === undefined)) return false;
    const validationCaptainId = state.captainId ?? nextStartingXI[0];
    const validationViceCaptainId = state.viceCaptainId ?? nextStartingXI.find((id) => id !== validationCaptainId);
    const nextState = { ...state, benchGoalkeeperId, benchOrder, captainId: validationCaptainId, viceCaptainId: validationViceCaptainId, playerIds: state.playerIds, byPosition: state.byPosition };
    const checked = validLineup(nextState, { gameweek: state.lineupGameweek ?? 1, lineupProjectionFingerprint: state.lineupProjectionFingerprint ?? "draft" , benchGoalkeeperId, benchOrder });
    const structuralErrors = checked.errors.filter((error) => !error.includes("gameweek") && !error.includes("fingerprint"));
    if (state.playerIds.length === 15 && (structuralErrors.length > 0 || nextStartingXI.length !== 11)) return false;
    set(activePlanPatch(state, { benchGoalkeeperId, benchOrder }));
    return true;
  },
  reorderBench: (order) => {
    const state = get();
    const current = state.benchOrder;
    const validCurrent = current.length === 3 && new Set(current).size === 3 && current.every((id) => state.playerIds.includes(id) && positionOf(id, state.byPosition) !== "GK");
    if (!validCurrent || order.length !== 3 || new Set(order).size !== 3 || order.some((id) => !current.includes(id))) return false;
    set(activePlanPatch(state, { benchOrder: [...order] }));
    return true;
  },
  hydrate: (state) => {
    if (!state) return set({ isHydrated: true });
    const current = get();
    const hasSquad = Object.prototype.hasOwnProperty.call(state, "squad");
    const incomingSquad = sanitizeSquad(state.squad);
    const playerIds = incomingSquad?.playerIds ?? (hasSquad ? [] : [...current.playerIds]);
    const byPosition = incomingSquad?.byPosition ?? (hasSquad ? emptySlots() : cloneSlotMap(current.byPosition));
    const hasPlans = Object.prototype.hasOwnProperty.call(state, "gameweekPlans");
    const plans = hasPlans ? sanitizePlans(state.gameweekPlans) : {};
    const currentGameweek = validGameweek(state.currentGameweek) ? state.currentGameweek : current.currentGameweek;
    const requestedGameweek = validGameweek(state.planningGameweek) ? state.planningGameweek : current.planningGameweek;
    const planningGameweek = clampGameweek(requestedGameweek, currentGameweek);
    const persistedPlan = hasPlans ? plans[planningGameweek] : undefined;
    const planPlayerIds = persistedPlan?.playerIds ?? playerIds;
    const planByPosition = persistedPlan?.byPosition ?? byPosition;
    const incomingMetadata = Object.prototype.hasOwnProperty.call(state, "lineupGameweek") || Object.prototype.hasOwnProperty.call(state, "lineupProjectionFingerprint");
    const currentLineupApplied = current.lineupGameweek !== undefined && current.lineupProjectionFingerprint !== undefined;
    const candidateBenchGoalkeeperId = persistedPlan?.benchGoalkeeperId ?? (validId(state.benchGoalkeeperId) ? state.benchGoalkeeperId : undefined) ?? (incomingMetadata ? undefined : current.benchGoalkeeperId);
    const candidateBenchOrder = persistedPlan ? [...persistedPlan.benchOrder] : safeNumberArray(state.benchOrder) ?? (incomingMetadata ? [] : [...current.benchOrder]);
    const candidateLineupGameweek = persistedPlan?.lineupGameweek ?? (validGameweek(state.lineupGameweek) ? state.lineupGameweek : undefined) ?? (incomingMetadata ? undefined : current.lineupGameweek);
    const candidateLineupProjectionFingerprint = persistedPlan?.lineupProjectionFingerprint ?? (typeof state.lineupProjectionFingerprint === "string" && state.lineupProjectionFingerprint.trim() ? state.lineupProjectionFingerprint.trim() : undefined) ?? (incomingMetadata ? undefined : current.lineupProjectionFingerprint);
    const candidateCaptainId = persistedPlan?.captainId ?? (validId(state.captainId) ? state.captainId : undefined) ?? (incomingMetadata ? undefined : current.captainId);
    const candidateViceCaptainId = persistedPlan?.viceCaptainId ?? (validId(state.viceCaptainId) ? state.viceCaptainId : undefined) ?? (incomingMetadata ? undefined : current.viceCaptainId);
    const metadataValid = persistedPlan ? true : !incomingMetadata || (candidateLineupGameweek !== undefined && typeof candidateLineupProjectionFingerprint === "string" && Boolean(candidateLineupProjectionFingerprint) && validLineup({ playerIds: planPlayerIds, byPosition: planByPosition, benchGoalkeeperId: candidateBenchGoalkeeperId, benchOrder: candidateBenchOrder, captainId: candidateCaptainId, viceCaptainId: candidateViceCaptainId }, { gameweek: candidateLineupGameweek, lineupProjectionFingerprint: candidateLineupProjectionFingerprint, benchGoalkeeperId: candidateBenchGoalkeeperId, benchOrder: candidateBenchOrder }).valid);
    const preserveCurrentLineup = currentLineupApplied && (!incomingMetadata || !metadataValid);
    const activeState = {
      playerIds: persistedPlan ? [...persistedPlan.playerIds] : playerIds,
      byPosition: persistedPlan ? cloneSlotMap(persistedPlan.byPosition) : byPosition,
      benchGoalkeeperId: preserveCurrentLineup ? current.benchGoalkeeperId : candidateBenchGoalkeeperId,
      benchOrder: preserveCurrentLineup ? [...current.benchOrder] : candidateBenchOrder,
      lineupGameweek: preserveCurrentLineup ? current.lineupGameweek : metadataValid ? candidateLineupGameweek : undefined,
      lineupProjectionFingerprint: preserveCurrentLineup ? current.lineupProjectionFingerprint : metadataValid ? candidateLineupProjectionFingerprint : undefined,
      lockedPlayerIds: persistedPlan ? [...persistedPlan.lockedPlayerIds] : (Array.isArray(state.lockedPlayerIds) ? [...new Set(state.lockedPlayerIds.filter(validId).filter((id) => playerIds.includes(id)))] : []),
      captainId: preserveCurrentLineup ? current.captainId : metadataValid ? candidateCaptainId : undefined,
      viceCaptainId: preserveCurrentLineup ? current.viceCaptainId : metadataValid ? candidateViceCaptainId : undefined,
      chip: persistedPlan?.chip ?? (validChip((state as Partial<GameweekPlanSnapshot>).chip) ? ((state as Partial<GameweekPlanSnapshot>).chip ?? null) : current.chip),
      plannedTransfers: persistedPlan ? persistedPlan.plannedTransfers.map((transfer) => ({ ...transfer })) : (sanitizeTransfers((state as { plannedTransfers?: unknown }).plannedTransfers) ?? [...current.plannedTransfers]),
      permanentSquad: persistedPlan?.permanentSquad ? clonePermanentSnapshot(persistedPlan.permanentSquad) : undefined,
    };
    const nextPlans = hasPlans
      ? savePlan(plans, persistedPlan ?? planFromState({ ...current, ...activeState, planningGameweek }, planningGameweek))
      : hasSquad && incomingSquad
        // A new squad replaces the plan for the gameweek being planned. Plans
        // saved for other gameweeks survive, and the snapshot keeps any stale
        // lineup metadata so the UI can still flag it as outdated.
        ? { ...current.gameweekPlans, [planningGameweek]: planFromState({ ...current, ...activeState, planningGameweek }, planningGameweek) }
        : current.gameweekPlans;
    set({
      currentGameweek,
      planningGameweek,
      mode: state.mode === "BUILD" || state.mode === "ANALYZE" || state.mode === null ? state.mode : current.mode,
      entryId: Number.isSafeInteger(state.entryId) && Number(state.entryId) > 0 ? state.entryId : current.entryId,
      budgetTenths: validBudget(state.budgetTenths) ? state.budgetTenths : current.budgetTenths,
      selectedLeagueKey: isLeagueKey(state.selectedLeagueKey) ? state.selectedLeagueKey : current.selectedLeagueKey,
      ...activeState,
      transferBaseline: Object.prototype.hasOwnProperty.call(state, "transferBaseline")
        ? sanitizeBaseline(state.transferBaseline)
        : current.transferBaseline,
      usedChips: Object.prototype.hasOwnProperty.call(state, "usedChips") ? sanitizeUsedChips(state.usedChips) : current.usedChips,
      planNotice: null,
      preApplySnapshot: null,
      horizon: validHorizon(state.horizon) ? state.horizon : current.horizon,
      transferHorizon: validHorizon(state.transferHorizon) ? state.transferHorizon : current.transferHorizon,
      riskMode: state.riskMode === "SAFE" || state.riskMode === "BALANCED" || state.riskMode === "AGGRESSIVE" ? state.riskMode : current.riskMode,
      benchStrategy: state.benchStrategy === "CHEAP" || state.benchStrategy === "BALANCED" || state.benchStrategy === "STRONG" ? state.benchStrategy : current.benchStrategy,
      panelRatios: sanitizePanelRatios(state.panelRatios),
      dismissedTransferKeys: [...new Set((Array.isArray(state.dismissedTransferKeys) ? state.dismissedTransferKeys : []).filter((key): key is string => typeof key === "string" && /^[1-9]\d*:[1-9]\d*$/.test(key)))].slice(0, 600),
      gameweekPlans: nextPlans,
      isHydrated: true,
    });
  },
  reset: () => set({ ...initial, isHydrated: true }),
}));

export function exportTerminalState(state: TerminalState): PersistedTerminalState {
  const plans = Object.keys(state.gameweekPlans).reduce((result, key) => {
    const gameweek = Number(key);
    const clean = sanitizePlan(state.gameweekPlans[gameweek], gameweek);
    if (clean) result[gameweek] = clean;
    return result;
  }, {} as Record<number, GameweekPlanSnapshot>);
  return {
    version: SAVED_STATE_VERSION,
    mode: state.mode,
    entryId: state.entryId,
    budgetTenths: state.budgetTenths,
    selectedLeagueKey: state.selectedLeagueKey,
    squad: { playerIds: state.playerIds, byPosition: state.byPosition },
    lockedPlayerIds: state.lockedPlayerIds,
    captainId: state.captainId,
    viceCaptainId: state.viceCaptainId,
    benchOrder: state.benchOrder,
    benchGoalkeeperId: state.benchGoalkeeperId,
    lineupGameweek: state.lineupGameweek,
    lineupProjectionFingerprint: state.lineupProjectionFingerprint,
    horizon: state.horizon,
    transferHorizon: state.transferHorizon,
    riskMode: state.riskMode,
    benchStrategy: state.benchStrategy,
    panelRatios: state.panelRatios,
    dismissedTransferKeys: state.dismissedTransferKeys,
    planningGameweek: state.planningGameweek,
    currentGameweek: state.currentGameweek,
    gameweekPlans: plans,
    transferBaseline: state.transferBaseline,
    usedChips: state.usedChips,
    excludedPlayerIds: [],
  };
}

export function parseSavedState(raw: string): Partial<PersistedTerminalState> | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedTerminalState>;
    if (!value || typeof value !== "object" || Array.isArray(value) || !sanitizeSquad(value.squad)) return null;
    // Unversioned saves predate the stamp and are read as version 0: their
    // fields go through the same sanitizers, so they load rather than vanish.
    // A save from a newer build is the one case worth refusing - this build
    // cannot know what its fields mean, and guessing would corrupt a squad
    // that is still fine in the tab that wrote it. Refusing keeps that save
    // untouched on disk for the newer build to pick up again.
    const version = value.version ?? 0;
    if (typeof version !== "number" || !Number.isFinite(version) || version > SAVED_STATE_VERSION) return null;
    const parsed: Partial<PersistedTerminalState> = { ...value, squad: sanitizeSquad(value.squad) };
    if (Object.prototype.hasOwnProperty.call(value, "gameweekPlans")) parsed.gameweekPlans = sanitizePlans(value.gameweekPlans);
    else parsed.gameweekPlans = {};
    if (value.planningGameweek !== undefined && !validGameweek(value.planningGameweek)) delete parsed.planningGameweek;
    if (value.currentGameweek !== undefined && !validGameweek(value.currentGameweek)) delete parsed.currentGameweek;
    // Migrate pre-chip exports: no chips, no planned transfers, and an
    // estimated financial baseline derived from the saved squad and budget.
    // Invalid new fields are dropped without discarding squad or lineup.
    if (Object.prototype.hasOwnProperty.call(value, "transferBaseline")) {
      const baseline = sanitizeBaseline(value.transferBaseline);
      if (baseline) parsed.transferBaseline = baseline;
      else delete parsed.transferBaseline;
    }
    if (Object.prototype.hasOwnProperty.call(value, "usedChips")) parsed.usedChips = sanitizeUsedChips(value.usedChips);
    return parsed;
  } catch {
    return null;
  }
}

/** Migration helper used when no baseline was ever saved. */
export function baselineWithMigrationFallback(
  baseline: TransferBaseline | null,
  playerIds: number[],
  byPosition: SlotMap,
  budgetTenths: number,
  gameweek: number,
  priceById?: ReadonlyMap<number, number>,
): TransferBaseline {
  if (baseline) return baseline;
  return estimatedBaselineFallback(playerIds, byPosition, budgetTenths, gameweek, priceById);
}
