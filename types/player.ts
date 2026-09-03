export type Position = "GK" | "DEF" | "MID" | "FWD";
export type ProjectionConfidence = "HIGH" | "MEDIUM" | "LOW";
export type NailedRating = 1 | 2 | 3 | 4 | 5;

export interface SelectionEvidence {
  source: "ROTOWIRE_XI" | "ROTOWIRE_AVAILABILITY" | "HISTORICAL_STARTS" | "CURRENT_SEASON" | "FPL_STATUS";
  detail: string;
}

export interface PlayerSelection {
  startProbability: number;
  cameoProbability: number;
  noAppearanceProbability: number;
  expectedMinutes: number;
  expectedStartMinutes?: number;
  expectedCameoMinutes?: number;
  nailedRating: NailedRating;
  confidence: ProjectionConfidence;
  updatedAt: string;
  evidence: SelectionEvidence[];
}

export type PriceTenths = number;

export interface CurrentStats {
  totalPoints: number;
  pointsPer90?: number;
  pointsPerGame?: number;
  form?: number;
  starts?: number;
  goals: number;
  assists: number;
  cleanSheets: number;
  goalsConceded?: number;
  ownGoals?: number;
  penaltiesSaved?: number;
  penaltiesMissed?: number;
  bonus: number;
  bps?: number;
  minutes: number;
  saves?: number;
  expectedGoals?: number;
  expectedAssists?: number;
  expectedGoalInvolvements?: number;
  expectedGoalsConceded?: number;
  influence?: number;
  creativity?: number;
  threat?: number;
  ictIndex?: number;
  defensiveContribution?: number;
  clearancesBlocksInterceptions?: number;
  recoveries?: number;
  tackles?: number;
  yellowCards?: number;
  redCards?: number;
}

export interface PlayerPerformanceStats extends CurrentStats {
  starts: number;
  goalsConceded: number;
  ownGoals: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  bps: number;
  saves: number;
  yellowCards: number;
  redCards: number;
}

export interface PlayerMatchPerformance {
  fixtureId?: number;
  gameweek: number;
  opponentTeamId?: number;
  opponentShortName: string;
  isHome: boolean;
  kickoffTime?: string;
  teamHomeScore?: number;
  teamAwayScore?: number;
  valueTenths?: number;
  transfersBalance?: number;
  selected?: number;
  stats: PlayerPerformanceStats;
}

export interface PlayerSeasonPerformance {
  season: string;
  startPriceTenths?: number;
  endPriceTenths?: number;
  stats: PlayerPerformanceStats;
}

export interface HistoricalStats {
  season: string;
  minutes: number;
  starts?: number;
  totalPoints?: number;
  goals?: number;
  assists?: number;
  cleanSheets?: number;
  saves?: number;
  bonus?: number;
  bps?: number;
  influence?: number;
  creativity?: number;
  threat?: number;
  expectedGoals?: number;
  expectedAssists?: number;
  xGIPer90?: number;
  pointsPer90?: number;
  defensiveContribution?: number;
  yellowCards?: number;
  redCards?: number;
}

export interface PlayerFixture {
  fixtureId?: number;
  gameweek: number;
  opponentTeamId: number;
  opponentShortName: string;
  isHome: boolean;
  difficulty?: number;
  kickoffTime?: string;
}

export interface ProjectionFactor {
  label: string;
  value: number;
  direction: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
}

export interface FixtureProjection {
  gameweek: number;
  expectedPoints: number;
  expectedMinutes: number;
  fixture: PlayerFixture;
  /**
   * Server-side only. `projectPlayer` fills this and sums it into
   * `PlayerProjection.components`; `withoutFixtureComponents` then strips it
   * before the bootstrap response, so client code never sees it.
   */
  components?: import("./projection").ProjectionComponents;
}

export interface PlayerProjection {
  playerId: number;
  fixtures: FixtureProjection[];
  nextGW: number;
  next3: number;
  next5: number;
  next10: number;
  expectedMinutes: number;
  valueNext5: number;
  riskScore: number;
  confidence: ProjectionConfidence;
  factors: ProjectionFactor[];
  components?: import("./projection").ProjectionComponents;
}

export interface Player {
  id: number;
  code?: number;
  optaCode?: number;
  firstName: string;
  lastName: string;
  displayName: string;
  teamId: number;
  teamName: string;
  teamShortName: string;
  position: Position;
  priceTenths: PriceTenths;
  ownership: number;
  status: string;
  news?: string;
  chanceOfPlaying?: number | null;
  current: CurrentStats;
  historical?: HistoricalStats;
  selection?: PlayerSelection;
  fixtures: PlayerFixture[];
  projection?: PlayerProjection;
}

export interface PlayerProfileData {
  player: Player;
  fixtures: PlayerFixture[];
  history: PlayerMatchPerformance[];
  historyPast: PlayerSeasonPerformance[];
}

export interface PlayerMapping {
  currentPlayerId: number;
  historicalPlayerId?: number;
  confidence: "EXACT" | "LIKELY" | "UNRESOLVED";
}
