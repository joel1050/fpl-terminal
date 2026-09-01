import type { HistoricalMatchStat, HistoricalPlayerRecord, HistoricalTeamStrength } from "@/lib/historical/types";
import type { HistoricalStats } from "@/types/player";

export interface PreparedPlayerAnchor {
  historicalPlayerId: number;
  sourceHistoricalPlayerId: number;
  code: number;
  stats: HistoricalStats;
}

export interface PreparedFixture {
  fixtureId: number;
  gameweek: number;
  homeTeamId: number;
  awayTeamId: number;
  homeXg: number;
  awayXg: number;
  homeGoals: number;
  awayGoals: number;
}

function normalizedName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Links adjacent seasons only by FPL's stable player code; names are too easy to mis-map. */
export function buildPlayerAnchors(
  targetPlayers: readonly HistoricalPlayerRecord[],
  previousPlayers: readonly HistoricalPlayerRecord[],
): PreparedPlayerAnchor[] {
  const previousByCode = new Map(
    previousPlayers
      .filter((player): player is HistoricalPlayerRecord & { code: number } =>
        player.code !== undefined && player.stats.minutes > 0)
      .map((player) => [player.code, player]),
  );
  return targetPlayers.flatMap((player) => {
    if (player.code === undefined) return [];
    const previous = previousByCode.get(player.code);
    return previous
      ? [{
          historicalPlayerId: player.historicalPlayerId,
          sourceHistoricalPlayerId: previous.historicalPlayerId,
          code: player.code,
          stats: previous.stats,
        }]
      : [];
  });
}

/** Rebuilds team fixtures from player rows without using a target-season result as a prior. */
export function buildFixturesFromMatchRows(rows: readonly HistoricalMatchStat[]): PreparedFixture[] {
  const byFixture = new Map<number, {
    gameweek: number;
    home: { xg: number; goals: number; opponent: number | null };
    away: { xg: number; goals: number; opponent: number | null };
  }>();
  for (const row of rows) {
    if (row.fixtureId === undefined) continue;
    const entry = byFixture.get(row.fixtureId) ?? {
      gameweek: row.gameweek,
      home: { xg: 0, goals: 0, opponent: null },
      away: { xg: 0, goals: 0, opponent: null },
    };
    const side = row.wasHome ? entry.home : entry.away;
    side.xg += row.expectedGoals ?? 0;
    side.goals += row.goals;
    side.opponent = row.opponentTeamId ?? null;
    byFixture.set(row.fixtureId, entry);
  }

  const fixtures: PreparedFixture[] = [];
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

/** Uses the completed previous season as the target season's opening team prior. */
export function buildPreviousSeasonTeamPriors(
  targetTeams: readonly HistoricalTeamStrength[],
  previousTeams: readonly HistoricalTeamStrength[],
  previousFixtures: readonly PreparedFixture[],
): { priors: HistoricalTeamStrength[]; fallbackTeams: string[] } {
  const totals = new Map<number, { matches: number; xgFor: number; xgAgainst: number }>();
  const add = (teamId: number, xgFor: number, xgAgainst: number) => {
    const total = totals.get(teamId) ?? { matches: 0, xgFor: 0, xgAgainst: 0 };
    total.matches += 1;
    total.xgFor += xgFor;
    total.xgAgainst += xgAgainst;
    totals.set(teamId, total);
  };
  for (const fixture of previousFixtures) {
    add(fixture.homeTeamId, fixture.homeXg, fixture.awayXg);
    add(fixture.awayTeamId, fixture.awayXg, fixture.homeXg);
  }
  const leagueAverage = previousFixtures.length
    ? previousFixtures.reduce((sum, fixture) => sum + fixture.homeXg + fixture.awayXg, 0) / (previousFixtures.length * 2)
    : 1;
  const previousByName = new Map(previousTeams.map((team) => [normalizedName(team.name), team.teamId]));
  const fallbackTeams: string[] = [];
  const priors = targetTeams.map((team) => {
    const previousId = previousByName.get(normalizedName(team.name));
    const total = previousId === undefined ? undefined : totals.get(previousId);
    if (!total || total.matches === 0) fallbackTeams.push(team.name);
    const attack = total ? (total.xgFor / total.matches) / leagueAverage : 1;
    const defence = total ? leagueAverage / Math.max(total.xgAgainst / total.matches, 0.15) : 1;
    const overall = (attack + defence) / 2;
    return {
      teamId: team.teamId,
      name: team.name,
      shortName: team.shortName,
      overallHome: overall,
      overallAway: overall,
      attackHome: attack,
      attackAway: attack,
      defenceHome: defence,
      defenceAway: defence,
    };
  });
  return { priors, fallbackTeams };
}
