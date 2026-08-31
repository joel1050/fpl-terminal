import type { Position } from "./player";

export type LeagueType = "OVERALL" | "CLASSIC" | "H2H" | "CUP";

export interface ClassicLeagueRef {
  id: number;
  name: string;
  /** FPL sends a code: "s" for public leagues, "x" for invitational ones. */
  leagueType?: number | string;
  rank?: number;
  entryRank?: number;
  entryLastRank?: number;
  size?: number;
  entryCount?: number;
  closed?: boolean;
}

export type H2HLeagueRef = ClassicLeagueRef;

export interface CupLeagueRef {
  id: number;
  name: string;
  stage?: string | number;
}

export interface ManagerProfile {
  entryId: number;
  name?: string;
  playerFirstName?: string;
  playerLastName?: string;
  playerRegionId?: number;
  playerRegionName?: string;
  playerRegionIsoCodeShort?: string;
  joinedTime?: string;
  startedEvent?: number;
  yearsActive?: number;
  favouriteTeamId?: number;
  currentEvent?: number;
  summaryOverallPoints?: number;
  summaryOverallRank?: number;
  summaryEventPoints?: number;
  summaryEventRank?: number;
  lastDeadlineBank?: number;
  lastDeadlineValue?: number;
  lastDeadlineTotalTransfers?: number;
  leagues: {
    classic: ClassicLeagueRef[];
    h2h: H2HLeagueRef[];
    cup: CupLeagueRef[];
  };
}

export interface EntryHistoryRow {
  event: number;
  points?: number;
  totalPoints?: number;
  rank?: number;
  rankSort?: number;
  overallRank?: number;
  percentileRank?: number | string;
  bank?: number;
  value?: number;
  eventTransfers?: number;
  eventTransfersCost?: number;
  pointsOnBench?: number;
}

export interface EntrySeasonRow {
  seasonName: string;
  totalPoints?: number;
  rank?: number;
}

export interface EntryChipUsage {
  name: string;
  event?: number;
}

export interface ManagerHistory {
  entryId: number;
  chips: EntryChipUsage[];
  current: EntryHistoryRow[];
  past: EntrySeasonRow[];
}

export interface PickEntryHistory {
  event?: number;
  points?: number;
  totalPoints?: number;
  eventTransfersCost?: number;
  pointsOnBench?: number;
  bank?: number;
  value?: number;
  overallRank?: number;
  rank?: number;
  percentileRank?: number | string;
}

export interface AutomaticSub {
  elementIn: number;
  elementOut: number;
  event?: number;
}

export interface EntryPick {
  element: number;
  position: number;
  elementType: number;
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
}

export interface EntryPicks {
  entryId: number;
  gameweek: number;
  points?: number;
  activeChip?: string | null;
  automaticSubs: AutomaticSub[];
  picks: EntryPick[];
  entryHistory?: PickEntryHistory;
}

export interface ClassicStandingRow {
  entryId: number;
  entryName?: string;
  playerName?: string;
  rank?: number;
  lastRank?: number;
  total?: number;
  /** Official Gameweek points recorded by FPL for this entry. */
  eventTotal?: number;
}

export interface ClassicLeagueStandings {
  league: {
    id: number;
    name?: string;
    shortName?: string;
    leagueType?: number | string;
    closed?: boolean;
  };
  page: number;
  hasNext: boolean;
  results: ClassicStandingRow[];
}

export type PlayerGameweekStatus = "DONE" | "LIVE" | "TO_PLAY";

export type FixtureState = "UPCOMING" | "LIVE" | "FINISHED";

export interface FixtureView {
  id: number;
  kickoffTime?: string | null;
  homeTeamId: number;
  awayTeamId: number;
  homeShortName: string;
  awayShortName: string;
  homeScore: number | null;
  awayScore: number | null;
  state: FixtureState;
  /**
   * FPL confirms bonus after a match ends, so a fixture reports FINISHED while
   * its points can still move. False means the score is not settled yet.
   */
  bonusSettled: boolean;
  minutes?: number;
}

export interface PlayerFixtureStatus {
  fixtureId: number;
  opponentTeamId: number;
  isHome: boolean;
  state: FixtureState;
  minutes?: number;
  kickoffTime?: string | null;
}

export interface LiveEntryPlayer {
  elementId: number;
  position: number;
  elementType: number;
  positionCode: Position;
  onBench: boolean;
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  points: number;
  expectedPoints: number;
  status: PlayerGameweekStatus;
  fixtures: PlayerFixtureStatus[];
}

export interface LiveEntryCalculation {
  grossPoints: number;
  hitCost: number;
  netPoints: number;
  startersPoints: number;
  benchPoints: number;
  playerPoints: LiveEntryPlayer[];
  done: number;
  live: number;
  toPlay: number;
  pointsOnBench?: number;
  activeChip?: string | null;
}

export interface LiveStandingRow {
  entryId: number;
  entryName?: string;
  playerName?: string;
  officialRank?: number;
  lastRank?: number;
  officialTotal?: number;
  /** FPL's own Gameweek points, shown when no live figure can be claimed. */
  officialGameweekPoints?: number;
  preGameweekTotal: number;
  gameweekPoints: number;
  liveTotal: number;
  leftToPlay: number;
  movement: number;
  localRank: number;
  isUser: boolean;
}

export interface LiveStandingsResult {
  rows: LiveStandingRow[];
  completePopulation: boolean;
  calculatedEntries: number;
}

export type FeedEventKind =
  | "GOAL"
  | "ASSIST"
  | "YELLOW CARD"
  | "RED CARD"
  | "OWN GOAL"
  | "PENALTY SAVE"
  | "PENALTY MISS"
  | "SAVE POINT"
  | "CLEAN SHEET"
  | "BONUS CHANGE"
  | "DEFENSIVE CONTRIBUTION"
  | "APPEARANCE"
  | "SIXTY MINUTES"
  | "POINTS CHANGE";

/**
 * What a feed row is about. ROUTINE covers the appearance points every playing
 * squad member banks, which are true but arrive in their hundreds at kickoff,
 * so they stay out of every view except the deliberate one.
 */
export type FeedEventClass = "ATTACKING" | "DEFENSIVE" | "DISCIPLINE" | "BONUS" | "ROUTINE";

export interface LiveFeedEvent {
  /**
   * Stable across polls and reloads: the same real event always produces the
   * same id, so re-reading a Gameweek cannot duplicate its history.
   */
  id: string;
  kind: FeedEventKind;
  eventClass: FeedEventClass;
  playerId: number;
  playerName?: string;
  /** Points this event alone is worth, from FPL's breakdown where it supplies one. */
  pointsDelta: number;
  fixtureId?: number;
  detail?: string;
  minute?: string;
  /** Read back from cumulative stats rather than watched as it happened. */
  seeded: boolean;
  at: number;
}
