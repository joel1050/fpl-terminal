"use client";

import { create } from "zustand";
import { INITIAL_BUDGET_TENTHS, type Horizon, type PersistentFPLState, type Player, type Position, type SquadState, type WeeklyLineupPlan } from "@/types";
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

export type PersistedTerminalState = PersistentFPLState & {
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

function planFromState(state: Pick<TerminalState, "planningGameweek" | "playerIds" | "byPosition" | "benchGoalkeeperId" | "benchOrder" | "lockedPlayerIds" | "captainId" | "viceCaptainId" | "lineupGameweek" | "lineupProjectionFingerprint">, gameweek = state.planningGameweek): GameweekPlanSnapshot {
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

function activePlanPatch(state: TerminalState, patch: Partial<Pick<TerminalState, "playerIds" | "byPosition" | "benchGoalkeeperId" | "benchOrder" | "lockedPlayerIds" | "captainId" | "viceCaptainId" | "lineupGameweek" | "lineupProjectionFingerprint" | "selectedPlayerId">>): Partial<TerminalState> {
  const next = { ...state, ...patch };
  return { ...patch, gameweekPlans: savePlan(state.gameweekPlans, planFromState(next)) };
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

export function isLineupStale(lineupGameweek: number | undefined, lineupProjectionFingerprint: string | undefined, gameweek: number, projectionFingerprint: string): boolean {
  return lineupGameweek !== undefined && Boolean(lineupGameweek !== gameweek || lineupProjectionFingerprint !== projectionFingerprint);
}

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
  replaceSquad: (squad: SquadState, lineup: ApplyLineupInput, entryId: number, budgetTenths?: number) => boolean;
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
    const source = exact ?? nearestPriorPlan(savedPlans, gameweek) ?? planFromState(state, gameweek);
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
    }));
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
    }));
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
      selectedPlayerId: incomingId,
    }));
    return true;
  },
  replaceSquad: (squad, lineup, entryId, budgetTenths = INITIAL_BUDGET_TENTHS) => {
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
    const next = {
      playerIds: [...squad.playerIds],
      byPosition,
      benchGoalkeeperId: checked.benchGoalkeeperId,
      benchOrder: checked.benchOrder,
      lineupGameweek: lineup.gameweek,
      lineupProjectionFingerprint: lineup.lineupProjectionFingerprint.trim(),
      lockedPlayerIds: [],
      captainId: checked.captainId,
      viceCaptainId: checked.viceCaptainId,
      selectedPlayerId: undefined,
      entryId,
      budgetTenths,
    };
    const gameweek = lineup.gameweek;
    const nextState = { ...get(), ...next, planningGameweek: clampGameweek(gameweek, get().currentGameweek), gameweekPlans: {} };
    set({ ...next, planningGameweek: nextState.planningGameweek, gameweekPlans: { [gameweek]: planFromState(nextState, gameweek) } });
    return true;
  },
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
    gameweekPlans: plans,
    excludedPlayerIds: [],
  };
}

export function parseSavedState(raw: string): Partial<PersistedTerminalState> | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedTerminalState>;
    if (!value || typeof value !== "object" || Array.isArray(value) || !sanitizeSquad(value.squad)) return null;
    const parsed: Partial<PersistedTerminalState> = { ...value, squad: sanitizeSquad(value.squad) };
    if (Object.prototype.hasOwnProperty.call(value, "gameweekPlans")) parsed.gameweekPlans = sanitizePlans(value.gameweekPlans);
    if (value.planningGameweek !== undefined && !validGameweek(value.planningGameweek)) delete parsed.planningGameweek;
    if (value.currentGameweek !== undefined && !validGameweek(value.currentGameweek)) delete parsed.currentGameweek;
    return parsed;
  } catch {
    return null;
  }
}
