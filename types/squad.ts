import type { Player, Position, PriceTenths } from "./player";
import type { Horizon } from "./projection";

export const SQUAD_SIZE = 15;
export const INITIAL_BUDGET_TENTHS: PriceTenths = 1000;
export const MAX_PLAYERS_PER_CLUB = 3;

export interface SquadState {
  playerIds: number[];
  byPosition: Record<Position, number[]>;
}

export interface PersistentFPLState {
  squad: SquadState;
  lockedPlayerIds: number[];
  captainId?: number;
  viceCaptainId?: number;
  benchOrder: number[];
  horizon: Horizon;
  /** Horizon the transfer suggestions are searched over, chosen on that panel. */
  transferHorizon: Horizon;
  riskMode: "SAFE" | "BALANCED" | "AGGRESSIVE";
  benchStrategy: "CHEAP" | "BALANCED" | "STRONG";
  excludedPlayerIds: number[];
}

export interface SquadConstraints {
  budgetTenths: PriceTenths;
  positionCounts: Record<Position, number>;
  maxPlayersPerClub: number;
}

export interface SquadValidation {
  legal: boolean;
  errors: string[];
  warnings: string[];
}

export interface BudgetFeasibility {
  spentTenths: PriceTenths;
  bankTenths: PriceTenths;
  minimumRequiredTenths: PriceTenths;
  flexibleTenths: PriceTenths;
  feasible: boolean;
}

export interface BenchPlan {
  goalkeeperId?: number;
  outfieldIds: number[];
}

export interface StartingXIPlan {
  playerIds: number[];
  captainId?: number;
  viceCaptainId?: number;
  bench: BenchPlan;
}

export type LineupRiskMode = "SAFE" | "BALANCED" | "AGGRESSIVE";

export interface WeeklyLineupInput {
  squad: readonly Player[];
  gameweek: number;
  riskMode: LineupRiskMode;
}

export type OutfieldBenchOrder = [number, number, number];

/** Persist only choices and model metadata; starters are derived from this plan. */
export interface WeeklyLineupPlan {
  gameweek: number;
  starterIds: number[];
  formation: string;
  benchGoalkeeperId: number;
  benchOrder: OutfieldBenchOrder;
  captainId: number;
  viceCaptainId: number;
  projectedXI: number;
  captainBonus: number;
  projectedTotal: number;
  autosubValue: number;
  explanations: string[];
  warnings: string[];
  projectionFingerprint: string;
}
