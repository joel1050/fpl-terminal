/**
 * Shapes one ingested season into a walk-forward backtest universe.
 *
 * Every value a projection is allowed to see at gameweek `t` comes from
 * gameweeks strictly before `t`, so nothing here leaks the outcome it is
 * scored against. Prepared multi-season inputs also supply opening team and
 * player priors from the preceding season; the legacy single-season corpus
 * retains the named aggregate-rate leaks for backwards-compatible comparisons.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HistoricalStats, Player, PlayerFixture, Position } from "@/types/player";
import type { PlayerMatchRate, TeamStrength } from "@/types/projection";
import { deriveTeamStrengths, type EnrichmentTeam } from "@/lib/historical/enrichPlayers";
import { applyInSeasonForm, type TeamMatchXG } from "@/lib/historical/inSeasonForm";
import {
  buildFixturesFromMatchRows,
  type PreparedFixture,
  type PreparedPlayerAnchor,
} from "./multiSeasonData";

const root = path.resolve(__dirname, "../..");
/** BACKTEST_DATA_DIR points the harness at a scratch ingest; never write to data/generated. */
const dataDir = process.env.BACKTEST_DATA_DIR ?? path.join(root, "data/generated");
export const KNOWN_LEAKS = existsSync(path.join(dataDir, "previous-player-anchors.json"))
  ? []
  : [
      "saves per-90: only a season aggregate exists per player, so it is reused at every gameweek",
      "defensive contributions per-90: same, season aggregate only",
      "card rates per-90: season aggregate only, so they are reused at every gameweek",
    ];
const read = <T,>(file: string): T =>
  JSON.parse(readFileSync(path.join(dataDir, file), "utf8")) as T;
/** Optional inputs: absent for a plain `npm run data:ingest`, so callers degrade. */
const readOptional = <T,>(file: string): T | undefined => {
  try { return read<T>(file); } catch { return undefined; }
};

export interface MatchRow {
  historicalPlayerId: number;
  gameweek: number;
  fixtureId: number;
  opponentTeamId: number;
  minutes: number;
  totalPoints: number;
  goals: number;
  assists: number;
  expectedGoals: number;
  expectedAssists: number;
  bonus: number;
  bps: number;
  yellowCards?: number;
  redCards?: number;
  wasHome: boolean;
}

interface SeasonPlayer {
  historicalPlayerId: number;
  code?: number;
  displayName: string;
  teamName: string;
  position: Position;
  stats: HistoricalStats;
}

interface RawTeamStrength {
  teamId: number;
  name: string;
  shortName: string;
  overallHome: number;
  overallAway: number;
  attackHome: number;
  attackAway: number;
  defenceHome: number;
  defenceAway: number;
}

export type Fixture = PreparedFixture & {
  /** FPL's 1-5 difficulty for each side. Present only when fixture-difficulty.json is. */
  homeDifficulty?: number;
  awayDifficulty?: number;
};

export interface Season {
  players: Map<number, SeasonPlayer>;
  /** Each player's team id, taken as the mode across their appearances. */
  teamOf: Map<number, number>;
  rowsByGameweek: Map<number, MatchRow[]>;
  rowsByPlayer: Map<number, MatchRow[]>;
  fixtures: Fixture[];
  fixturesByGameweek: Map<number, Fixture[]>;
  /** Opening team prior, normalized to ~1.0. */
  priorStrengths: Record<number, TeamStrength>;
  /** Previous-season player evidence keyed to this season's player id. */
  previousStatsByPlayerId: Map<number, HistoricalStats>;
  /** Prepared inputs never fall back to completed target-season aggregates. */
  hasPreparedPriors: boolean;
  leagueAverageXg: number;
}

export function loadSeason(): Season {
  const rows = read<MatchRow[]>("historical-match-stats.json");
  // vaastav's fixtures.csv carries team_h_difficulty / team_a_difficulty for every
  // season; merged_gw.csv does not, which is why FDR was long recorded here as
  // untestable. Ingest it separately and the difficulty arms become runnable.
  const difficulty = readOptional<{ fixtureId: number; homeDifficulty: number; awayDifficulty: number }[]>(
    "fixture-difficulty.json",
  );
  const difficultyById = new Map((difficulty ?? []).map((d) => [d.fixtureId, d]));
  const playerList = read<SeasonPlayer[]>("historical-players.json");
  const priorFile = existsSync(path.join(dataDir, "preseason-team-strength.json"))
    ? "preseason-team-strength.json"
    : "team-strength.json";
  const rawStrengths = read<RawTeamStrength[]>(priorFile);
  const hasPreparedPriors = existsSync(path.join(dataDir, "previous-player-anchors.json"));
  const previousAnchors = hasPreparedPriors
    ? read<PreparedPlayerAnchor[]>("previous-player-anchors.json")
    : [];

  const players = new Map(playerList.map((player) => [player.historicalPlayerId, player]));
  const fixtures: Fixture[] = buildFixturesFromMatchRows(rows).map((fixture) => {
    const d = difficultyById.get(fixture.fixtureId);
    return d ? { ...fixture, homeDifficulty: d.homeDifficulty, awayDifficulty: d.awayDifficulty } : fixture;
  });
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));

  const rowsByGameweek = new Map<number, MatchRow[]>();
  const rowsByPlayer = new Map<number, MatchRow[]>();
  const teamCounts = new Map<number, Map<number, number>>();
  for (const row of rows) {
    const fixture = fixtureById.get(row.fixtureId);
    if (!fixture) continue;
    (rowsByGameweek.get(row.gameweek) ?? rowsByGameweek.set(row.gameweek, []).get(row.gameweek)!).push(row);
    (rowsByPlayer.get(row.historicalPlayerId)
      ?? rowsByPlayer.set(row.historicalPlayerId, []).get(row.historicalPlayerId)!).push(row);
    const teamId = row.wasHome ? fixture.homeTeamId : fixture.awayTeamId;
    const counts = teamCounts.get(row.historicalPlayerId)
      ?? teamCounts.set(row.historicalPlayerId, new Map()).get(row.historicalPlayerId)!;
    counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
  }
  for (const rowList of rowsByPlayer.values()) rowList.sort((a, b) => a.gameweek - b.gameweek);

  const teamOf = new Map<number, number>();
  for (const [playerId, counts] of teamCounts) {
    let best = -1;
    let bestCount = -1;
    for (const [teamId, count] of counts) {
      if (count > bestCount) { best = teamId; bestCount = count; }
    }
    teamOf.set(playerId, best);
  }

  const enrichmentTeams: EnrichmentTeam[] = rawStrengths.map((team) => ({
    id: team.teamId,
    strength: {
      overallHome: team.overallHome,
      overallAway: team.overallAway,
      attackHome: team.attackHome,
      attackAway: team.attackAway,
      defenceHome: team.defenceHome,
      defenceAway: team.defenceAway,
    },
  }));

  const fixturesByGameweek = new Map<number, Fixture[]>();
  for (const fixture of fixtures) {
    (fixturesByGameweek.get(fixture.gameweek)
      ?? fixturesByGameweek.set(fixture.gameweek, []).get(fixture.gameweek)!).push(fixture);
  }

  const totalXg = fixtures.reduce((sum, f) => sum + f.homeXg + f.awayXg, 0);

  return {
    players,
    teamOf,
    rowsByGameweek,
    rowsByPlayer,
    fixtures,
    fixturesByGameweek,
    priorStrengths: deriveTeamStrengths(enrichmentTeams).strengths,
    previousStatsByPlayerId: new Map(previousAnchors.map((anchor) => [anchor.historicalPlayerId, anchor.stats])),
    hasPreparedPriors,
    leagueAverageXg: totalXg / (fixtures.length * 2),
  };
}

/** Team strengths as they would have been known before `gameweek` kicked off. */
export function strengthsBefore(season: Season, gameweek: number): Record<number, TeamStrength> {
  const history: Record<number, TeamMatchXG[]> = {};
  const push = (teamId: number, xgFor: number, xgAgainst: number, opponentTeamId?: number, wasHome?: boolean) => {
    (history[teamId] ??= []).push({ xgFor, xgAgainst, opponentTeamId, wasHome });
  };
  for (const fixture of season.fixtures) {
    if (fixture.gameweek >= gameweek) continue;
    push(fixture.homeTeamId, fixture.homeXg, fixture.awayXg, fixture.awayTeamId, true);
    push(fixture.awayTeamId, fixture.awayXg, fixture.homeXg, fixture.homeTeamId, false);
  }
  return applyInSeasonForm(season.priorStrengths, history);
}

/** One player's chronological xG/xA match history before `gameweek` (§6.3.1 input). */
export function formBefore(season: Season, playerId: number, gameweek: number): PlayerMatchRate[] {
  return (season.rowsByPlayer.get(playerId) ?? [])
    .filter((row) => row.gameweek < gameweek && row.minutes > 0)
    .map((row) => ({ xg: row.expectedGoals ?? 0, xa: row.expectedAssists ?? 0, minutes: row.minutes }));
}

/** Season-to-date totals before `gameweek`, shaped as Player.current (§6.3 input). */
export function currentBefore(season: Season, playerId: number, gameweek: number) {
  const rows = (season.rowsByPlayer.get(playerId) ?? []).filter((row) => row.gameweek < gameweek);
  const sum = (pick: (row: MatchRow) => number) => rows.reduce((total, row) => total + (pick(row) || 0), 0);
  return {
    totalPoints: sum((r) => r.totalPoints),
    goals: sum((r) => r.goals),
    assists: sum((r) => r.assists),
    cleanSheets: 0,
    bonus: sum((r) => r.bonus),
    minutes: sum((r) => r.minutes),
    expectedGoals: sum((r) => r.expectedGoals),
    expectedAssists: sum((r) => r.expectedAssists),
    matches: rows.length,
  };
}

/**
 * Builds the Player the projector sees at `gameweek`, with one upcoming fixture.
 * With prepared inputs, `historical` comes from the preceding season. The
 * legacy corpus keeps its aggregate-rate fallback for comparable old runs.
 */
export function playerAt(
  season: Season,
  playerId: number,
  gameweek: number,
  fixture: Fixture,
  wasHome: boolean,
  /**
   * Emulates the previous-season anchor that production has and a one-season
   * backtest does not. When set, `historical` carries the player's own xG/xA
   * over gameweeks 1..anchorThrough, so basePrior is a real per-player rate
   * instead of the position prior. Backtest only gameweeks after it.
   */
  anchorThrough?: number,
): Player | undefined {
  const source = season.players.get(playerId);
  const teamId = season.teamOf.get(playerId);
  if (!source || teamId === undefined) return undefined;
  const current = currentBefore(season, playerId, gameweek);
  const seasonStats = source.stats;
  const previousStats = anchorThrough === undefined
    ? season.previousStatsByPlayerId.get(playerId)
    : undefined;
  const upcoming: PlayerFixture = {
    gameweek,
    opponentTeamId: wasHome ? fixture.awayTeamId : fixture.homeTeamId,
    opponentShortName: "OPP",
    isHome: wasHome,
    // Real FPL difficulty when fixture-difficulty.json was ingested; otherwise a
    // neutral 3, which keeps `base` at 1.0 and leaves every other arm unchanged.
    difficulty: (wasHome ? fixture.homeDifficulty : fixture.awayDifficulty) ?? 3,
  };
  const anchor = anchorThrough === undefined ? undefined : currentBefore(season, playerId, anchorThrough + 1);
  const mayUseTargetAggregate = anchorThrough !== undefined || !season.hasPreparedPriors;
  const historical: HistoricalStats | undefined = previousStats ?? (mayUseTargetAggregate && seasonStats.minutes > 0
    ? {
        season: seasonStats.season,
        minutes: seasonStats.minutes,
        saves: seasonStats.saves,
        defensiveContribution: seasonStats.defensiveContribution,
        yellowCards: seasonStats.yellowCards,
        redCards: seasonStats.redCards,
        ...(anchor && anchor.minutes > 0
          ? {
              minutes: anchor.minutes,
              expectedGoals: anchor.expectedGoals,
              expectedAssists: anchor.expectedAssists,
              // saves and defensive contributions have no per-match source, so
              // they stay on the season aggregate and are rescaled to match.
              saves: (seasonStats.saves ?? 0) * (anchor.minutes / seasonStats.minutes),
              defensiveContribution: (seasonStats.defensiveContribution ?? 0) * (anchor.minutes / seasonStats.minutes),
            }
          : {}),
      }
    : undefined);
  return {
    id: playerId,
    firstName: source.displayName,
    lastName: "",
    displayName: source.displayName,
    teamId,
    teamName: source.teamName,
    teamShortName: "TST",
    position: source.position,
    priceTenths: 50,
    ownership: 0,
    status: "a",
    current: {
      totalPoints: current.totalPoints,
      goals: current.goals,
      assists: current.assists,
      cleanSheets: current.cleanSheets,
      bonus: current.bonus,
      minutes: current.minutes,
      expectedGoals: current.expectedGoals,
      expectedAssists: current.expectedAssists,
    },
    historical,
    fixtures: [upcoming],
  };
}
