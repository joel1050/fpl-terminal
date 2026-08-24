/**
 * Shapes the ingested 2025/26 season into a walk-forward backtest universe.
 *
 * Every value a projection is allowed to see at gameweek `t` comes from
 * gameweeks strictly before `t`, so nothing here leaks the outcome it is
 * scored against. The two exceptions are named in `KNOWN_LEAKS` and are held
 * identical across every arm, so they cancel in a paired comparison.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HistoricalStats, Player, PlayerFixture, Position } from "@/types/player";
import type { PlayerMatchRate, TeamStrength } from "@/types/projection";
import { deriveTeamStrengths, type EnrichmentTeam } from "@/lib/historical/enrichPlayers";
import { applyInSeasonForm, type TeamMatchXG } from "@/lib/historical/inSeasonForm";

export const KNOWN_LEAKS = [
  "saves per-90: only a season aggregate exists per player, so it is reused at every gameweek",
  "defensive contributions per-90: same, season aggregate only",
] as const;

const root = path.resolve(__dirname, "../..");
const read = <T,>(file: string): T =>
  JSON.parse(readFileSync(path.join(root, "data/generated", file), "utf8")) as T;

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
  wasHome: boolean;
}

interface SeasonPlayer {
  historicalPlayerId: number;
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

export interface Fixture {
  fixtureId: number;
  gameweek: number;
  homeTeamId: number;
  awayTeamId: number;
  homeXg: number;
  awayXg: number;
  homeGoals: number;
  awayGoals: number;
}

export interface Season {
  players: Map<number, SeasonPlayer>;
  /** Each player's team id, taken as the mode across their appearances. */
  teamOf: Map<number, number>;
  rowsByGameweek: Map<number, MatchRow[]>;
  rowsByPlayer: Map<number, MatchRow[]>;
  fixtures: Fixture[];
  fixturesByGameweek: Map<number, Fixture[]>;
  /** Preseason prior: the real FPL 2025/26 strength ratings, normalized to ~1.0. */
  priorStrengths: Record<number, TeamStrength>;
  leagueAverageXg: number;
}

/** Rebuilds fixtures from player rows: each side reports the *other* team's id. */
function buildFixtures(rows: readonly MatchRow[]): Fixture[] {
  const byFixture = new Map<number, {
    gameweek: number;
    home: { xg: number; goals: number; opponent: number | null };
    away: { xg: number; goals: number; opponent: number | null };
  }>();
  for (const row of rows) {
    let entry = byFixture.get(row.fixtureId);
    if (!entry) {
      entry = {
        gameweek: row.gameweek,
        home: { xg: 0, goals: 0, opponent: null },
        away: { xg: 0, goals: 0, opponent: null },
      };
      byFixture.set(row.fixtureId, entry);
    }
    const side = row.wasHome ? entry.home : entry.away;
    side.xg += row.expectedGoals ?? 0;
    side.goals += row.goals ?? 0;
    side.opponent = row.opponentTeamId;
  }
  const fixtures: Fixture[] = [];
  for (const [fixtureId, entry] of byFixture) {
    if (entry.home.opponent === null || entry.away.opponent === null) continue;
    fixtures.push({
      fixtureId,
      gameweek: entry.gameweek,
      homeTeamId: entry.away.opponent,
      awayTeamId: entry.home.opponent,
      homeXg: entry.home.xg,
      awayXg: entry.away.xg,
      homeGoals: entry.home.goals,
      awayGoals: entry.away.goals,
    });
  }
  return fixtures.sort((a, b) => a.gameweek - b.gameweek || a.fixtureId - b.fixtureId);
}

export function loadSeason(): Season {
  const rows = read<MatchRow[]>("historical-match-stats.json");
  const playerList = read<SeasonPlayer[]>("historical-players.json");
  const rawStrengths = read<RawTeamStrength[]>("team-strength.json");

  const players = new Map(playerList.map((player) => [player.historicalPlayerId, player]));
  const fixtures = buildFixtures(rows);
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
    leagueAverageXg: totalXg / (fixtures.length * 2),
  };
}

/** Team strengths as they would have been known before `gameweek` kicked off. */
export function strengthsBefore(season: Season, gameweek: number): Record<number, TeamStrength> {
  const history: Record<number, TeamMatchXG[]> = {};
  const push = (teamId: number, xgFor: number, xgAgainst: number) => {
    (history[teamId] ??= []).push({ xgFor, xgAgainst });
  };
  for (const fixture of season.fixtures) {
    if (fixture.gameweek >= gameweek) continue;
    push(fixture.homeTeamId, fixture.homeXg, fixture.awayXg);
    push(fixture.awayTeamId, fixture.awayXg, fixture.homeXg);
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
 * `historical` carries only the two season-aggregate rates listed in KNOWN_LEAKS;
 * every other input is season-to-date.
 */
export function playerAt(
  season: Season,
  playerId: number,
  gameweek: number,
  fixture: Fixture,
  wasHome: boolean,
): Player | undefined {
  const source = season.players.get(playerId);
  const teamId = season.teamOf.get(playerId);
  if (!source || teamId === undefined) return undefined;
  const current = currentBefore(season, playerId, gameweek);
  const seasonStats = source.stats;
  const upcoming: PlayerFixture = {
    gameweek,
    opponentTeamId: wasHome ? fixture.awayTeamId : fixture.homeTeamId,
    opponentShortName: "OPP",
    isHome: wasHome,
    // No FDR exists for this season; a neutral 3 keeps `base` at 1.0 so the
    // arms differ only in the parts of section 7 that are actually testable.
    difficulty: 3,
  };
  const historical: HistoricalStats | undefined = seasonStats.minutes > 0
    ? {
        season: seasonStats.season,
        minutes: seasonStats.minutes,
        saves: seasonStats.saves,
        defensiveContribution: seasonStats.defensiveContribution,
      }
    : undefined;
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
