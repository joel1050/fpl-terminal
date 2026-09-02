import type { Position } from "./player";

export type Horizon = 1 | 3 | 5 | 10;

export interface PlayerMatchRate {
  xg: number;
  xa: number;
  minutes: number;
  /**
   * Who the player faced, and where. Optional so a caller that has not wired up
   * the fixture context still gets the previous behaviour rather than an error;
   * when present, projectPlayer divides the match out by the fixture it was
   * played in before blending (calculations.md 6.3.2).
   */
  opponentTeamId?: number;
  wasHome?: boolean;
}

export interface TeamStrength {
  teamId: number;
  attackHome: number;
  attackAway: number;
  defenceHome: number;
  defenceAway: number;
  overall: number;
}

export interface ProjectionSummary {
  nextGW: number;
  next3: number;
  next5: number;
  next10: number;
  expectedMinutes: number;
  valueNext5: number;
  riskScore: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

/** Expected-points components kept separate so a projection can be explained. */
export interface ProjectionComponents {
  appearance: number;
  goals: number;
  assists: number;
  cleanSheets: number;
  /** Negative: FPL deducts a point per two goals conceded by a goalkeeper or defender. */
  goalsConceded: number;
  saves: number;
  defensiveContribution: number;
  bonus: number;
  /** Negative: one point off per yellow, three per red. */
  cards: number;
  penalties: number;
  total: number;
}

export interface ProjectionOptions {
  horizon: Horizon;
  currentGameweek: number;
  teamStrength?: TeamStrength;
  teamStrengths?: Record<number, TeamStrength>;
  positionPrior?: Partial<Record<Position, number>>;
  /** Optional explicit minutes are useful for tests and in-progress seasons. */
  expectedMinutes?: number;
  /** Each player's chronological in-season xG/xA match history, keyed by player id. */
  playerForm?: Record<number, readonly PlayerMatchRate[]>;
}
