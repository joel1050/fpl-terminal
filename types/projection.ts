import type { Position } from "./player";

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
  penalties: number;
  total: number;
}

export interface ProjectionOptions {
  horizon: 1 | 3 | 5;
  currentGameweek: number;
  teamStrength?: TeamStrength;
  teamStrengths?: Record<number, TeamStrength>;
  positionPrior?: Partial<Record<Position, number>>;
  /** Optional explicit minutes are useful for tests and in-progress seasons. */
  expectedMinutes?: number;
}
