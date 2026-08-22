"use client";

import { create } from "zustand";
import type { PersistentFPLState, Player, Position, WeeklyLineupPlan } from "@/types";
import { validateWeeklyLineup } from "@/lib/squad/weeklyLineup";

type RiskMode = "SAFE" | "BALANCED" | "AGGRESSIVE";
type BenchStrategy = "CHEAP" | "BALANCED" | "STRONG";

export type TerminalMode = "BUILD" | "ANALYZE";
export type SortKey = "name" | "price" | "nextGW" | "next3" | "next5" | "value" | "ownership" | "risk";

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
  benchGoalkeeperId?: number;
  lineupGameweek?: number;
  lineupProjectionFingerprint?: string;
};

const emptySlots = (): SlotMap => ({ GK: [], DEF: [], MID: [], FWD: [] });

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
  activeMobileTab: "SQUAD" | "ANALYSIS" | "MARKET" | "AI";
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
  horizon: 1 | 3 | 5;
  riskMode: RiskMode;
  benchStrategy: BenchStrategy;
  isHydrated: boolean;
  setMode: (mode: TerminalMode | null) => void;
  setMobileTab: (tab: TerminalState["activeMobileTab"]) => void;
  setSearch: (search: string) => void;
  setFilters: (filters: Partial<TerminalFilters>) => void;
  setSort: (sortKey: SortKey) => void;
  addPlayer: (id: number, position: Position) => boolean;
  removePlayer: (id: number) => boolean;
  toggleLock: (id: number) => void;
  setSelectedPlayer: (id?: number) => void;
  setStrategy: (strategy: Partial<Pick<TerminalState, "horizon" | "riskMode" | "benchStrategy">>) => void;
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
  activeMobileTab: "SQUAD" as const,
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
  riskMode: "BALANCED" as const,
  benchStrategy: "BALANCED" as const,
  isHydrated: false,
};

export const useTerminalStore = create<TerminalState>((set, get) => ({
  ...initial,
  setMode: (mode) => set({ mode }),
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
    set({
      playerIds: [...state.playerIds, id],
      byPosition: { ...state.byPosition, [position]: [...state.byPosition[position], id] },
      selectedPlayerId: id,
    });
    return true;
  },
  removePlayer: (id) => {
    const state = get();
    if (state.lockedPlayerIds.includes(id)) return false;
    const position = positionOf(id, state.byPosition);
    set({
      playerIds: state.playerIds.filter((playerId) => playerId !== id),
      byPosition: position ? { ...state.byPosition, [position]: state.byPosition[position].filter((playerId) => playerId !== id) } : state.byPosition,
      benchGoalkeeperId: state.benchGoalkeeperId === id ? undefined : state.benchGoalkeeperId,
      benchOrder: state.benchOrder.filter((playerId) => playerId !== id),
      lockedPlayerIds: state.lockedPlayerIds.filter((playerId) => playerId !== id),
      captainId: state.captainId === id ? undefined : state.captainId,
      viceCaptainId: state.viceCaptainId === id ? undefined : state.viceCaptainId,
    });
    return true;
  },
  toggleLock: (id) => set((state) => ({
    lockedPlayerIds: state.lockedPlayerIds.includes(id)
      ? state.lockedPlayerIds.filter((playerId) => playerId !== id)
      : [...state.lockedPlayerIds, id],
  })),
  setSelectedPlayer: (selectedPlayerId) => set({ selectedPlayerId }),
  setStrategy: (strategy) => set(strategy),
  setCaptain: (captainId) => {
    const state = get();
    const startingXI = deriveStartingXI(state.playerIds, state.benchGoalkeeperId, state.benchOrder);
    const lineupApplied = state.lineupGameweek !== undefined && state.lineupProjectionFingerprint !== undefined;
    if (lineupApplied && (captainId === undefined || state.viceCaptainId === undefined)) return false;
    if (captainId !== undefined && (startingXI.length !== 11 || !startingXI.includes(captainId) || captainId === state.viceCaptainId)) return false;
    set({ captainId });
    return true;
  },
  setViceCaptain: (viceCaptainId) => {
    const state = get();
    const startingXI = deriveStartingXI(state.playerIds, state.benchGoalkeeperId, state.benchOrder);
    const lineupApplied = state.lineupGameweek !== undefined && state.lineupProjectionFingerprint !== undefined;
    if (lineupApplied && (viceCaptainId === undefined || state.captainId === undefined)) return false;
    if (viceCaptainId !== undefined && (startingXI.length !== 11 || !startingXI.includes(viceCaptainId) || viceCaptainId === state.captainId)) return false;
    set({ viceCaptainId });
    return true;
  },
  applyLineup: (input) => {
    const state = get();
    const checked = validLineup(state, input);
    if (!checked.valid || checked.benchGoalkeeperId === undefined) return false;
    set({
      benchGoalkeeperId: checked.benchGoalkeeperId,
      benchOrder: checked.benchOrder,
      captainId: checked.captainId,
      viceCaptainId: checked.viceCaptainId,
      lineupGameweek: input.gameweek,
      lineupProjectionFingerprint: input.lineupProjectionFingerprint.trim(),
    });
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
    set({ benchGoalkeeperId, benchOrder });
    return true;
  },
  reorderBench: (order) => {
    const state = get();
    const current = state.benchOrder;
    const validCurrent = current.length === 3 && new Set(current).size === 3 && current.every((id) => state.playerIds.includes(id) && positionOf(id, state.byPosition) !== "GK");
    if (!validCurrent || order.length !== 3 || new Set(order).size !== 3 || order.some((id) => !current.includes(id))) return false;
    set({ benchOrder: [...order] });
    return true;
  },
  hydrate: (state) => {
    if (!state) return set({ isHydrated: true });
    const current = get();
    const playerIds = state.squad?.playerIds ?? [];
    const byPosition = state.squad?.byPosition ?? emptySlots();
    const incomingMetadata = Object.prototype.hasOwnProperty.call(state, "lineupGameweek") || Object.prototype.hasOwnProperty.call(state, "lineupProjectionFingerprint");
    const currentLineupApplied = current.lineupGameweek !== undefined && current.lineupProjectionFingerprint !== undefined;
    const candidateBenchGoalkeeperId = state.benchGoalkeeperId ?? (incomingMetadata ? undefined : current.benchGoalkeeperId);
    const candidateBenchOrder = state.benchOrder ? [...state.benchOrder] : incomingMetadata ? [] : [...current.benchOrder];
    const candidateLineupGameweek = state.lineupGameweek ?? (incomingMetadata ? undefined : current.lineupGameweek);
    const candidateLineupProjectionFingerprint = state.lineupProjectionFingerprint ?? (incomingMetadata ? undefined : current.lineupProjectionFingerprint);
    const candidateCaptainId = state.captainId ?? (incomingMetadata ? undefined : current.captainId);
    const candidateViceCaptainId = state.viceCaptainId ?? (incomingMetadata ? undefined : current.viceCaptainId);
    const metadataValid = !incomingMetadata || (candidateLineupGameweek !== undefined && typeof candidateLineupProjectionFingerprint === "string" && Boolean(candidateLineupProjectionFingerprint) && validLineup({ playerIds, byPosition, benchGoalkeeperId: candidateBenchGoalkeeperId, benchOrder: candidateBenchOrder, captainId: candidateCaptainId, viceCaptainId: candidateViceCaptainId }, { gameweek: candidateLineupGameweek, lineupProjectionFingerprint: candidateLineupProjectionFingerprint, benchGoalkeeperId: candidateBenchGoalkeeperId, benchOrder: candidateBenchOrder }).valid);
    const preserveCurrentLineup = currentLineupApplied && (!incomingMetadata || !metadataValid);
    set({
      playerIds,
      byPosition,
      benchGoalkeeperId: preserveCurrentLineup ? current.benchGoalkeeperId : candidateBenchGoalkeeperId,
      benchOrder: preserveCurrentLineup ? [...current.benchOrder] : candidateBenchOrder,
      lineupGameweek: preserveCurrentLineup ? current.lineupGameweek : metadataValid ? candidateLineupGameweek : undefined,
      lineupProjectionFingerprint: preserveCurrentLineup ? current.lineupProjectionFingerprint : metadataValid ? candidateLineupProjectionFingerprint : undefined,
      lockedPlayerIds: state.lockedPlayerIds ?? [],
      captainId: preserveCurrentLineup ? current.captainId : metadataValid ? candidateCaptainId : undefined,
      viceCaptainId: preserveCurrentLineup ? current.viceCaptainId : metadataValid ? candidateViceCaptainId : undefined,
      horizon: state.horizon ?? 5,
      riskMode: state.riskMode ?? "BALANCED",
      benchStrategy: state.benchStrategy ?? "BALANCED",
      isHydrated: true,
    });
  },
  reset: () => set({ ...initial, isHydrated: true }),
}));

export function exportTerminalState(state: TerminalState): PersistedTerminalState {
  return {
    squad: { playerIds: state.playerIds, byPosition: state.byPosition },
    lockedPlayerIds: state.lockedPlayerIds,
    captainId: state.captainId,
    viceCaptainId: state.viceCaptainId,
    benchOrder: state.benchOrder,
    benchGoalkeeperId: state.benchGoalkeeperId,
    lineupGameweek: state.lineupGameweek,
    lineupProjectionFingerprint: state.lineupProjectionFingerprint,
    horizon: state.horizon,
    riskMode: state.riskMode,
    benchStrategy: state.benchStrategy,
    excludedPlayerIds: [],
  };
}

export function parseSavedState(raw: string): Partial<PersistedTerminalState> | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedTerminalState>;
    if (!value || typeof value !== "object" || !value.squad || !Array.isArray(value.squad.playerIds)) return null;
    return value;
  } catch {
    return null;
  }
}
