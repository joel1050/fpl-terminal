import type {
  CurrentStats,
  Player,
  PlayerFixture,
  PlayerPerformanceStats,
  PlayerProfileData,
  Position,
} from "@/types/player";
import type { HistoricalBundle } from "@/lib/historical/types";
import type { RotowireRefreshResult } from "@/lib/availability/refreshLineups";
import {
  enrichPlayersWithHistory,
  type PlayerEnrichmentMetadata,
} from "@/lib/historical/enrichPlayers";
import { loadInSeasonPlayerRates, loadInSeasonStarts, loadInSeasonTeamXG } from "@/lib/historical/loadInSeasonForm";
import { ensureFreshRotowireLineups } from "@/lib/availability/refreshLineups";
import {
  type FplBootstrapPayload,
  type FplFixturePayload,
  FplLiveExplainSchema,
  type FplLiveResponsePayload,
  type FplPlayerSummaryPayload,
} from "./schemas";
import teamStrengthData from "@/data/manual/team-strengths.json";

export type ConsensusTeamStrength = 1 | 2 | 3 | 4 | 5;

const consensusStrengthByTeam = new Map(
  teamStrengthData.teams.map((team) => [
    team.shortName,
    {
      overall: team.strength as ConsensusTeamStrength,
      attack: team.attackStrength as ConsensusTeamStrength | undefined,
      defence: team.defenceStrength as ConsensusTeamStrength | undefined,
    },
  ]),
);

export interface NormalizedTeam {
  id: number;
  name: string;
  shortName: string;
  strength?: {
    rating?: ConsensusTeamStrength;
    attackRating?: ConsensusTeamStrength;
    defenceRating?: ConsensusTeamStrength;
    updatedAt?: string;
    overallHome?: number;
    overallAway?: number;
    attackHome?: number;
    attackAway?: number;
    defenceHome?: number;
    defenceAway?: number;
  };
}

export interface NormalizedEvent {
  id: number;
  name: string;
  deadlineTime?: string;
  finished: boolean;
  isCurrent: boolean;
  isNext: boolean;
}

export interface NormalizedFixture {
  id: number;
  gameweek?: number;
  kickoffTime?: string;
  teamHomeId: number;
  teamAwayId: number;
  teamHomeName?: string;
  teamAwayName?: string;
  homeScore?: number | null;
  awayScore?: number | null;
  finished: boolean;
  finishedProvisional: boolean;
  started: boolean;
  minutes?: number;
  homeDifficulty?: number;
  awayDifficulty?: number;
}

export interface NormalizedBootstrap {
  events: NormalizedEvent[];
  teams: NormalizedTeam[];
  players: Player[];
  fixtures: NormalizedFixture[];
  currentGameweek?: number;
  deadlineTime?: string;
  totalPlayers?: number;
}

export type BootstrapProjectionMetadata = PlayerEnrichmentMetadata & {
  /** Outcome of the automatic RotoWire lineup refresh for this request. */
  lineups?: RotowireRefreshResult;
};

export type NormalizedPlayerDetail = PlayerProfileData;

/** One scoring line from FPL's own points breakdown, e.g. two goals worth ten. */
export interface NormalizedLiveExplainStat {
  identifier: string;
  points: number;
  value: number;
}

export interface NormalizedLiveExplain {
  fixtureId?: number;
  stats: NormalizedLiveExplainStat[];
}

export interface NormalizedLiveElement {
  playerId: number;
  stats: Record<string, number | string | boolean | null>;
  explain: NormalizedLiveExplain[];
}

export interface NormalizedLiveGameweek {
  gameweek: number;
  elements: NormalizedLiveElement[];
}

const POSITION_BY_ELEMENT_TYPE: Record<number, Position> = {
  1: "GK",
  2: "DEF",
  3: "MID",
  4: "FWD",
};

const toNumber = (value: number | string | null | undefined, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const optionalNumber = (
  value: number | string | null | undefined,
): number | undefined => {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function teamMap(teams: FplBootstrapPayload["teams"]): Map<number, NormalizedTeam> {
  return new Map(
    teams.map((team) => {
      const consensus = consensusStrengthByTeam.get(team.short_name);
      return [
      team.id,
      {
        id: team.id,
        name: team.name,
        shortName: team.short_name,
        strength: {
          rating: consensus?.overall,
          attackRating: consensus?.attack,
          defenceRating: consensus?.defence,
          updatedAt: teamStrengthData.updatedAt,
          overallHome: team.strength_overall_home,
          overallAway: team.strength_overall_away,
          attackHome: team.strength_attack_home,
          attackAway: team.strength_attack_away,
          defenceHome: team.strength_defence_home,
          defenceAway: team.strength_defence_away,
        },
      },
      ] as const;
    }),
  );
}

export function normalizeFixtures(
  fixtures: FplFixturePayload,
  teams: FplBootstrapPayload["teams"] = [],
): NormalizedFixture[] {
  const names = new Map(teams.map((team) => [team.id, team.name]));
  return fixtures.map((fixture) => ({
    id: fixture.id,
    gameweek: fixture.event ?? undefined,
    kickoffTime: fixture.kickoff_time ?? undefined,
    teamHomeId: fixture.team_h,
    teamAwayId: fixture.team_a,
    teamHomeName: names.get(fixture.team_h),
    teamAwayName: names.get(fixture.team_a),
    homeScore: fixture.team_h_score,
    awayScore: fixture.team_a_score,
    finished: fixture.finished ?? false,
    finishedProvisional: fixture.finished_provisional ?? false,
    started: fixture.started ?? false,
    minutes: fixture.minutes,
    homeDifficulty: fixture.team_h_difficulty,
    awayDifficulty: fixture.team_a_difficulty,
  }));
}

function playerFixtures(
  playerTeamId: number,
  fixtures: NormalizedFixture[],
  teams: Map<number, NormalizedTeam>,
): PlayerFixture[] {
  return fixtures
    .filter(
      (fixture) =>
        fixture.gameweek !== undefined &&
        (fixture.teamHomeId === playerTeamId || fixture.teamAwayId === playerTeamId),
    )
    .map((fixture) => {
      const isHome = fixture.teamHomeId === playerTeamId;
      const opponentTeamId = isHome ? fixture.teamAwayId : fixture.teamHomeId;
      return {
        gameweek: fixture.gameweek as number,
        opponentTeamId,
        opponentShortName: teams.get(opponentTeamId)?.shortName ?? "UNK",
        isHome,
        difficulty: isHome ? fixture.homeDifficulty : fixture.awayDifficulty,
      };
    });
}

export function normalizePlayer(
  rawPlayer: FplBootstrapPayload["elements"][number],
  teams: Map<number, NormalizedTeam>,
  fixtures: NormalizedFixture[] = [],
  seasonStarted = true,
): Player {
  const position = POSITION_BY_ELEMENT_TYPE[rawPlayer.element_type] ?? "FWD";
  const team = teams.get(rawPlayer.team);
  const firstName = rawPlayer.first_name ?? "";
  const lastName = rawPlayer.second_name ?? "";
  const displayName = rawPlayer.web_name ?? (`${firstName} ${lastName}`.trim() || "Unknown player");
  const current: CurrentStats = seasonStarted ? {
    totalPoints: rawPlayer.total_points ?? 0,
    pointsPer90: rawPlayer.minutes ? (rawPlayer.total_points ?? 0) / (rawPlayer.minutes / 90) : undefined,
    pointsPerGame: optionalNumber(rawPlayer.points_per_game),
    form: optionalNumber(rawPlayer.form),
    starts: rawPlayer.starts ?? 0,
    yellowCards: rawPlayer.yellow_cards ?? 0,
    redCards: rawPlayer.red_cards ?? 0,
    goals: rawPlayer.goals_scored ?? 0,
    assists: rawPlayer.assists ?? 0,
    cleanSheets: rawPlayer.clean_sheets ?? 0,
    goalsConceded: rawPlayer.goals_conceded ?? 0,
    ownGoals: rawPlayer.own_goals ?? 0,
    penaltiesSaved: rawPlayer.penalties_saved ?? 0,
    penaltiesMissed: rawPlayer.penalties_missed ?? 0,
    bonus: rawPlayer.bonus ?? 0,
    bps: rawPlayer.bps ?? 0,
    minutes: rawPlayer.minutes ?? 0,
    saves: rawPlayer.saves,
    influence: optionalNumber(rawPlayer.influence),
    creativity: optionalNumber(rawPlayer.creativity),
    threat: optionalNumber(rawPlayer.threat),
    ictIndex: optionalNumber(rawPlayer.ict_index),
    expectedGoals: optionalNumber(rawPlayer.expected_goals),
    expectedAssists: optionalNumber(rawPlayer.expected_assists),
    expectedGoalInvolvements: optionalNumber(rawPlayer.expected_goal_involvements),
    expectedGoalsConceded: optionalNumber(rawPlayer.expected_goals_conceded),
    defensiveContribution: rawPlayer.defensive_contribution,
    clearancesBlocksInterceptions: rawPlayer.clearances_blocks_interceptions,
    recoveries: rawPlayer.recoveries,
    tackles: rawPlayer.tackles,
  } : {
    totalPoints: 0,
    goals: 0,
    assists: 0,
    cleanSheets: 0,
    bonus: 0,
    minutes: 0,
    saves: 0,
  };

  return {
    id: rawPlayer.id,
    code: rawPlayer.code,
    optaCode: rawPlayer.opta_code
      ? Number(rawPlayer.opta_code.replace(/^p/, "")) || undefined
      : undefined,
    firstName,
    lastName,
    displayName,
    teamId: rawPlayer.team,
    teamName: team?.name ?? "Unknown team",
    teamShortName: team?.shortName ?? "UNK",
    position,
    priceTenths: rawPlayer.now_cost,
    ownership: toNumber(rawPlayer.selected_by_percent),
    status: rawPlayer.status ?? "u",
    news: rawPlayer.news || undefined,
    chanceOfPlaying: optionalNumber(rawPlayer.chance_of_playing_next_round) ?? null,
    current,
    fixtures: playerFixtures(rawPlayer.team, fixtures, teams),
  };
}

export function normalizeBootstrap(
  payload: FplBootstrapPayload,
  fixturesPayload: FplFixturePayload = [],
): NormalizedBootstrap {
  const teams = teamMap(payload.teams);
  const fixtures = normalizeFixtures(fixturesPayload, payload.teams);
  const events = payload.events.map((event) => ({
    id: event.id,
    name: event.name ?? `Gameweek ${event.id}`,
    deadlineTime: event.deadline_time ?? undefined,
    finished: event.finished ?? false,
    isCurrent: event.is_current ?? false,
    isNext: event.is_next ?? false,
  }));
  const markedCurrent = events.find((event) => event.isCurrent) ?? events.find((event) => event.isNext) ?? events.find((event) => !event.finished);
  const markedFixtures = fixtures.filter((fixture) => fixture.gameweek === markedCurrent?.id);
  // Once a gameweek's fixtures have kicked off (in progress or finished) the
  // planning window moves to the next gameweek.
  const currentEvent = markedCurrent && markedFixtures.length > 0 && markedFixtures.some((fixture) => fixture.started || fixture.finished)
    ? events.find((event) => event.id > markedCurrent.id && !event.finished) ?? markedCurrent
    : markedCurrent;
  const seasonStarted = fixtures.some((fixture) => fixture.started || fixture.finished) ||
    payload.events.some((event) => event.finished || event.is_current || event.is_previous);
  return {
    events: events.map((event) => ({ ...event, isCurrent: event.id === currentEvent?.id })),
    teams: [...teams.values()],
    players: payload.elements.map((player) => normalizePlayer(player, teams, fixtures, seasonStarted)),
    fixtures,
    currentGameweek: currentEvent?.id,
    deadlineTime: currentEvent?.deadlineTime,
    totalPlayers: payload.total_players,
  };
}

export async function enrichBootstrapWithProjections(
  bootstrap: NormalizedBootstrap,
  historical: HistoricalBundle | null,
): Promise<{ bootstrap: NormalizedBootstrap; metadata: BootstrapProjectionMetadata }> {
  // All three must settle before enrichPlayersWithHistory, which reads the
  // generated lineup files off disk synchronously. They are independent of each
  // other: the refresh writes data/generated, the two form loaders read the
  // snapshot cache.
  const [inSeasonForm, playerForm, startHistory, lineups] = await Promise.all([
    loadInSeasonTeamXG(bootstrap.players, bootstrap.fixtures),
    loadInSeasonPlayerRates(bootstrap.players, bootstrap.fixtures),
    loadInSeasonStarts(bootstrap.players, bootstrap.fixtures),
    ensureFreshRotowireLineups(bootstrap.players),
  ]);
  if (lineups.reason === "failed") {
    console.warn(`RotoWire auto-refresh failed, keeping the ${lineups.fetchedAt ?? "existing"} snapshot:`, lineups.error);
  }
  const enriched = enrichPlayersWithHistory(
    bootstrap.players,
    bootstrap.teams,
    bootstrap.events,
    historical,
    inSeasonForm,
    playerForm,
    startHistory,
  );
  return {
    bootstrap: { ...bootstrap, players: enriched.players },
    metadata: { ...enriched.metadata, lineups },
  };
}

function normalizePerformanceStats(
  row: FplPlayerSummaryPayload["history"][number] | FplPlayerSummaryPayload["history_past"][number],
): PlayerPerformanceStats {
  return {
    totalPoints: toNumber(row.total_points),
    minutes: toNumber(row.minutes),
    starts: toNumber(row.starts),
    goals: toNumber(row.goals_scored),
    assists: toNumber(row.assists),
    cleanSheets: toNumber(row.clean_sheets),
    goalsConceded: toNumber(row.goals_conceded),
    ownGoals: toNumber(row.own_goals),
    penaltiesSaved: toNumber(row.penalties_saved),
    penaltiesMissed: toNumber(row.penalties_missed),
    yellowCards: toNumber(row.yellow_cards),
    redCards: toNumber(row.red_cards),
    saves: toNumber(row.saves),
    bonus: toNumber(row.bonus),
    bps: toNumber(row.bps),
    influence: optionalNumber(row.influence),
    creativity: optionalNumber(row.creativity),
    threat: optionalNumber(row.threat),
    ictIndex: optionalNumber(row.ict_index),
    clearancesBlocksInterceptions: optionalNumber(row.clearances_blocks_interceptions),
    recoveries: optionalNumber(row.recoveries),
    tackles: optionalNumber(row.tackles),
    defensiveContribution: optionalNumber(row.defensive_contribution),
    expectedGoals: optionalNumber(row.expected_goals),
    expectedAssists: optionalNumber(row.expected_assists),
    expectedGoalInvolvements: optionalNumber(row.expected_goal_involvements),
    expectedGoalsConceded: optionalNumber(row.expected_goals_conceded),
  };
}

export function normalizePlayerDetail(
  player: Player,
  payload: FplPlayerSummaryPayload,
  teams?: Map<number, NormalizedTeam> | ReadonlyMap<number, NormalizedTeam>,
): NormalizedPlayerDetail {
  const fixtures: PlayerFixture[] = payload.fixtures.map((fixture) => ({
    fixtureId: fixture.id,
    gameweek: fixture.event ?? 0,
    opponentTeamId: fixture.is_home ? fixture.team_a : fixture.team_h,
    opponentShortName:
      teams?.get(fixture.is_home ? fixture.team_a : fixture.team_h)?.shortName ??
      String(fixture.is_home ? fixture.team_a : fixture.team_h),
    isHome: fixture.is_home,
    difficulty: fixture.difficulty,
    kickoffTime: fixture.kickoff_time ?? undefined,
  }));
  return {
    player: { ...player, fixtures },
    fixtures,
    history: payload.history.map((row) => ({
      fixtureId: row.fixture,
      gameweek: row.round ?? 0,
      opponentTeamId: row.opponent_team,
      opponentShortName: row.opponent_team === undefined
        ? "—"
        : teams?.get(row.opponent_team)?.shortName ?? String(row.opponent_team),
      isHome: row.was_home ?? false,
      kickoffTime: row.kickoff_time ?? undefined,
      teamHomeScore: optionalNumber(row.team_h_score),
      teamAwayScore: optionalNumber(row.team_a_score),
      valueTenths: optionalNumber(row.value),
      transfersBalance: optionalNumber(row.transfers_balance),
      selected: optionalNumber(row.selected),
      stats: normalizePerformanceStats(row),
    })),
    historyPast: payload.history_past.map((row) => ({
      season: row.season_name,
      startPriceTenths: optionalNumber(row.start_cost),
      endPriceTenths: optionalNumber(row.end_cost),
      stats: normalizePerformanceStats(row),
    })),
  };
}

/**
 * FPL's per-fixture points breakdown, kept only where it parses. An entry we do
 * not recognise is dropped rather than failing the whole live Gameweek, so a
 * changed upstream shape costs exact point attribution and nothing more.
 */
function normalizeLiveExplain(raw: unknown[]): NormalizedLiveExplain[] {
  const explained: NormalizedLiveExplain[] = [];
  for (const entry of raw) {
    const parsed = FplLiveExplainSchema.safeParse(entry);
    if (!parsed.success) continue;
    explained.push({
      fixtureId: optionalNumber(parsed.data.fixture),
      stats: (parsed.data.stats ?? []).map((stat) => ({
        identifier: stat.identifier,
        points: toNumber(stat.points, 0),
        value: toNumber(stat.value, 0),
      })),
    });
  }
  return explained;
}

export function normalizeLiveGameweek(
  gameweek: number,
  payload: FplLiveResponsePayload,
): NormalizedLiveGameweek {
  return {
    gameweek,
    elements: payload.elements.map((element) => ({
      playerId: element.id,
      stats: element.stats,
      explain: normalizeLiveExplain(element.explain ?? []),
    })),
  };
}

export { optionalNumber, toNumber };
