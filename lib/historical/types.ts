import type { HistoricalStats, PlayerMapping, Position } from "@/types/player";

export interface HistoricalPlayerRecord {
  historicalPlayerId: number;
  code?: number;
  displayName: string;
  teamName?: string;
  position?: Position;
  stats: HistoricalStats;
}

export interface HistoricalMatchStat {
  historicalPlayerId: number;
  gameweek: number;
  fixtureId?: number;
  opponentTeamId?: number;
  minutes: number;
  totalPoints: number;
  goals: number;
  assists: number;
  expectedGoals?: number;
  expectedAssists?: number;
  bonus: number;
  bps: number;
  yellowCards?: number;
  redCards?: number;
  /** Goalkeeper saves in this match. Absent in corpora ingested before 2026-09. */
  saves?: number;
  /** Goals conceded in this match. Absent in corpora ingested before 2026-09. */
  goalsConceded?: number;
  /** Expected goals conceded in this match, for shot-quality diagnostics. */
  expectedGoalsConceded?: number;
  wasHome?: boolean;
}

export interface HistoricalTeamStrength {
  teamId: number;
  name: string;
  shortName: string;
  overallHome?: number;
  overallAway?: number;
  attackHome?: number;
  attackAway?: number;
  defenceHome?: number;
  defenceAway?: number;
}

export interface HistoricalBundle {
  players: HistoricalPlayerRecord[];
  matchStats: HistoricalMatchStat[];
  teamStrength: HistoricalTeamStrength[];
  playerMappings: PlayerMapping[];
  generatedAt?: string;
  sourceSeason: string;
}

export interface HistoricalDataStatus {
  available: boolean;
  sourceSeason: string;
  reason?: string;
}
