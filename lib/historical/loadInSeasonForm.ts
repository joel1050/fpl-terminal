import { z } from "zod";
import { getLiveGameweek } from "@/lib/fpl/client";
import { readSnapshot, writeSnapshot } from "@/lib/fpl/cache";
import type { TeamMatchXG } from "./inSeasonForm";

const GameweekTeamXGSchema = z.array(
  z.object({ teamId: z.number(), xgFor: z.number(), xgAgainst: z.number() }),
);
type GameweekTeamXG = z.infer<typeof GameweekTeamXGSchema>;

export interface InSeasonFormPlayer {
  id: number;
  teamId: number;
}

export interface InSeasonFormFixture {
  gameweek?: number;
  teamHomeId: number;
  teamAwayId: number;
  finished: boolean;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A finished gameweek's team xG never changes, so once it has been fetched
 * and aggregated it is persisted as a tiny per-gameweek snapshot and never
 * fetched from FPL again. Only gameweeks not yet on disk hit the live
 * endpoint, so this stays cheap no matter how far into the season it runs.
 */
async function loadGameweekTeamXG(
  gameweek: number,
  players: readonly InSeasonFormPlayer[],
  fixtures: readonly InSeasonFormFixture[],
): Promise<GameweekTeamXG> {
  const gameweekFixtures = fixtures.filter((fixture) => fixture.gameweek === gameweek);
  const cached = await readSnapshot(`in-season-xg-gw-${gameweek}`, GameweekTeamXGSchema);
  if (cached?.data.length === gameweekFixtures.length * 2) return cached.data;

  const live = await getLiveGameweek(gameweek);
  if (!live.data) return [];

  const playerTeam = new Map(players.map((player) => [player.id, player.teamId]));
  const xgByTeam = new Map<number, number>();
  for (const element of live.data.elements) {
    const teamId = playerTeam.get(element.id);
    if (teamId === undefined) continue;
    const xg = toNumber(element.stats.expected_goals);
    xgByTeam.set(teamId, (xgByTeam.get(teamId) ?? 0) + xg);
  }

  // A full gameweek of real matches never sums to zero total xG. If it does,
  // the upstream stats shape has drifted (e.g. a renamed field) and every
  // team would otherwise be silently recorded as a scoreless shutout. Bail
  // out unresolved rather than caching that corruption for the rest of the
  // season - callers fall back to the preseason prior for this gameweek.
  const hasSignal = live.data.elements.length > 0
    && [...xgByTeam.values()].some((value) => value > 0);
  if (!hasSignal) return [];

  const result: GameweekTeamXG = [];
  for (const fixture of gameweekFixtures) {
    const homeXg = xgByTeam.get(fixture.teamHomeId) ?? 0;
    const awayXg = xgByTeam.get(fixture.teamAwayId) ?? 0;
    result.push({ teamId: fixture.teamHomeId, xgFor: homeXg, xgAgainst: awayXg });
    result.push({ teamId: fixture.teamAwayId, xgFor: awayXg, xgAgainst: homeXg });
  }

  await writeSnapshot(`in-season-xg-gw-${gameweek}`, result);
  return result;
}

/**
 * Builds each team's chronological xG-for/xG-against history for the
 * current season, from finished gameweeks only. Returns an empty history
 * (and callers fall back to the preseason prior) before any gameweek has
 * finished.
 */
export async function loadInSeasonTeamXG(
  players: readonly InSeasonFormPlayer[],
  fixtures: readonly InSeasonFormFixture[],
): Promise<Record<number, TeamMatchXG[]>> {
  const fixturesByGameweek = new Map<number, InSeasonFormFixture[]>();
  for (const fixture of fixtures) {
    if (fixture.gameweek === undefined) continue;
    const gameweekFixtures = fixturesByGameweek.get(fixture.gameweek) ?? [];
    gameweekFixtures.push(fixture);
    fixturesByGameweek.set(fixture.gameweek, gameweekFixtures);
  }

  const finishedGameweeks = [...fixturesByGameweek.entries()]
    .filter(([, gameweekFixtures]) => {
      const teams = gameweekFixtures.flatMap((fixture) => [fixture.teamHomeId, fixture.teamAwayId]);
      // ponytail: event/live xG is per gameweek, so skip doubles until a per-fixture xG source exists.
      return gameweekFixtures.every((fixture) => fixture.finished)
        && new Set(teams).size === teams.length;
    })
    .map(([gameweek]) => gameweek)
    .sort((a, b) => a - b);

  const perGameweek = await Promise.all(
    finishedGameweeks.map((gameweek) => loadGameweekTeamXG(gameweek, players, fixtures)),
  );

  const history: Record<number, TeamMatchXG[]> = {};
  for (const rows of perGameweek) {
    for (const row of rows) {
      (history[row.teamId] ??= []).push({ xgFor: row.xgFor, xgAgainst: row.xgAgainst });
    }
  }
  return history;
}
