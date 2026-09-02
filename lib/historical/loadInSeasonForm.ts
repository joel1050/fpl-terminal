import { z } from "zod";
import { getLiveGameweek } from "@/lib/fpl/client";
import { readSnapshot, writeSnapshot } from "@/lib/fpl/cache";
import type { TeamMatchXG } from "./inSeasonForm";
import type { PlayerMatchRate } from "@/lib/projections/playerForm";
import { MINUTES_FOR_START, type StartObservation } from "@/lib/availability/startRate";

const GameweekTeamXGSchema = z.array(
  z.object({
    teamId: z.number(),
    xgFor: z.number(),
    xgAgainst: z.number(),
    opponentTeamId: z.number().optional(),
    wasHome: z.boolean().optional(),
  }),
);
type GameweekTeamXG = z.infer<typeof GameweekTeamXGSchema>;

const GameweekPlayerRatesSchema = z.array(
  z.object({ playerId: z.number(), xg: z.number(), xa: z.number(), minutes: z.number() }),
);
type GameweekPlayerRates = z.infer<typeof GameweekPlayerRatesSchema>;

export interface InSeasonFormPlayer {
  id: number;
  teamId: number;
}

export interface InSeasonFormFixture {
  gameweek?: number;
  teamHomeId: number;
  teamAwayId: number;
  finished: boolean;
  finishedProvisional?: boolean;
}

interface GameweekEligibility {
  gameweek: number;
  /** Teams whose single fixture in this gameweek has been played. */
  teamIds: Set<number>;
  /** Every fixture played and no team doubled, so the aggregate is final. */
  complete: boolean;
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
  eligibility: GameweekEligibility,
  players: readonly InSeasonFormPlayer[],
  fixtures: readonly InSeasonFormFixture[],
): Promise<GameweekTeamXG> {
  const { gameweek, teamIds, complete } = eligibility;
  const gameweekFixtures = fixtures.filter((fixture) =>
    fixture.gameweek === gameweek && teamIds.has(fixture.teamHomeId) && teamIds.has(fixture.teamAwayId));
  if (complete) {
    const cached = await readSnapshot(`in-season-xg-gw-${gameweek}`, GameweekTeamXGSchema);
    if (cached?.data.length === gameweekFixtures.length * 2) return cached.data;
  }

  const live = await getLiveGameweek(gameweek);
  if (!live.data) return [];

  // Only the teams whose rows are about to be written. A team excluded from
  // this gameweek must not vouch for the signal in data it is not part of.
  const written = new Set(gameweekFixtures.flatMap((fixture) => [fixture.teamHomeId, fixture.teamAwayId]));
  const playerTeam = new Map(players.map((player) => [player.id, player.teamId]));
  const xgByTeam = new Map<number, number>();
  for (const element of live.data.elements) {
    const teamId = playerTeam.get(element.id);
    if (teamId === undefined || !written.has(teamId)) continue;
    const xg = toNumber(element.stats.expected_goals);
    xgByTeam.set(teamId, (xgByTeam.get(teamId) ?? 0) + xg);
  }

  // Real matches never sum to zero total xG. If they do, the upstream stats
  // shape has drifted (e.g. a renamed field) and every team would otherwise be
  // silently recorded as a scoreless shutout. Bail out unresolved rather than
  // caching that corruption for the rest of the season - callers fall back to
  // the preseason prior for this gameweek.
  const hasSignal = live.data.elements.length > 0
    && [...xgByTeam.values()].some((value) => value > 0);
  if (!hasSignal) return [];

  const result: GameweekTeamXG = [];
  for (const fixture of gameweekFixtures) {
    const homeXg = xgByTeam.get(fixture.teamHomeId) ?? 0;
    const awayXg = xgByTeam.get(fixture.teamAwayId) ?? 0;
    result.push({
      teamId: fixture.teamHomeId,
      xgFor: homeXg,
      xgAgainst: awayXg,
      opponentTeamId: fixture.teamAwayId,
      wasHome: true,
    });
    result.push({
      teamId: fixture.teamAwayId,
      xgFor: awayXg,
      xgAgainst: homeXg,
      opponentTeamId: fixture.teamHomeId,
      wasHome: false,
    });
  }

  // Only a finished gameweek is final. Persisting a partial one would freeze
  // the teams that had not kicked off yet out of the season's history.
  if (complete) await writeSnapshot(`in-season-xg-gw-${gameweek}`, result);
  return result;
}

/**
 * Eligibility is per team, not per gameweek. A team qualifies once its own
 * fixture in that gameweek has been played, whatever the rest of the gameweek
 * is doing - waiting for the last kickoff threw away evidence that already
 * existed, and left a projection reading a team's live totals for one stat
 * while ignoring them for another.
 *
 * A team that plays twice in a gameweek is still excluded: event/live xG is a
 * per-gameweek total, so a double gameweek can't be split back out into its two
 * fixtures. That exclusion now costs only the doubled teams rather than every
 * other team sharing their gameweek.
 *
 * `played` accepts a provisional finish. Minutes, xG and xA are match stats and
 * are final at full time; only bonus points are added later, and none of the
 * three fields read here is one.
 */
function played(fixture: InSeasonFormFixture): boolean {
  return fixture.finished || fixture.finishedProvisional === true;
}

function eligibleGameweeks(fixtures: readonly InSeasonFormFixture[]): GameweekEligibility[] {
  const fixturesByGameweek = new Map<number, InSeasonFormFixture[]>();
  for (const fixture of fixtures) {
    if (fixture.gameweek === undefined) continue;
    const gameweekFixtures = fixturesByGameweek.get(fixture.gameweek) ?? [];
    gameweekFixtures.push(fixture);
    fixturesByGameweek.set(fixture.gameweek, gameweekFixtures);
  }

  const eligible: GameweekEligibility[] = [];
  for (const [gameweek, gameweekFixtures] of fixturesByGameweek) {
    const appearances = new Map<number, number>();
    for (const fixture of gameweekFixtures) {
      for (const teamId of [fixture.teamHomeId, fixture.teamAwayId]) {
        appearances.set(teamId, (appearances.get(teamId) ?? 0) + 1);
      }
    }
    const teamIds = new Set<number>();
    for (const fixture of gameweekFixtures) {
      if (!played(fixture)) continue;
      for (const teamId of [fixture.teamHomeId, fixture.teamAwayId]) {
        if (appearances.get(teamId) === 1) teamIds.add(teamId);
      }
    }
    if (teamIds.size === 0) continue;
    const complete = gameweekFixtures.every((fixture) => fixture.finished)
      && [...appearances.values()].every((count) => count === 1);
    eligible.push({ gameweek, teamIds, complete });
  }
  return eligible.sort((a, b) => a.gameweek - b.gameweek);
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
  const perGameweek = await Promise.all(
    eligibleGameweeks(fixtures).map((eligibility) => loadGameweekTeamXG(eligibility, players, fixtures)),
  );

  const history: Record<number, TeamMatchXG[]> = {};
  for (const rows of perGameweek) {
    for (const row of rows) {
      (history[row.teamId] ??= []).push({
        xgFor: row.xgFor,
        xgAgainst: row.xgAgainst,
        opponentTeamId: row.opponentTeamId,
        wasHome: row.wasHome,
      });
    }
  }
  return history;
}

/**
 * Same caching contract as loadGameweekTeamXG: a finished gameweek's player
 * rates are persisted once and never re-fetched. Only players who actually
 * featured (minutes > 0) are recorded, matching how the backtest behind
 * PLAYER_FORM_DECAY/PLAYER_FORM_PRIOR_WEIGHT_MATCHES built its history - a
 * blank gameweek should not count as "a match with zero output."
 */
async function loadGameweekPlayerRates(
  eligibility: GameweekEligibility,
  teamByPlayer: ReadonlyMap<number, number>,
): Promise<GameweekPlayerRates> {
  const { gameweek, teamIds, complete } = eligibility;
  if (complete) {
    const cached = await readSnapshot(`in-season-player-rates-gw-${gameweek}`, GameweekPlayerRatesSchema);
    if (cached && cached.data.length > 0) return cached.data;
  }

  const live = await getLiveGameweek(gameweek);
  if (!live.data) return [];

  const result: GameweekPlayerRates = [];
  let hasSignal = false;
  for (const element of live.data.elements) {
    const minutes = toNumber(element.stats.minutes);
    if (minutes <= 0) continue;
    const teamId = teamByPlayer.get(element.id);
    if (teamId === undefined || !teamIds.has(teamId)) continue;
    const xg = toNumber(element.stats.expected_goals);
    const xa = toNumber(element.stats.expected_assists);
    if (xg > 0 || xa > 0) hasSignal = true;
    result.push({ playerId: element.id, xg, xa, minutes });
  }
  // Same corruption guard as the team loader: a full gameweek of real
  // appearances never sums to zero xG and xA across every player.
  if (!hasSignal) return [];

  if (complete) await writeSnapshot(`in-season-player-rates-gw-${gameweek}`, result);
  return result;
}

/**
 * Builds each player's chronological xG/xA-per-match history for the
 * current season, one entry per match they actually featured in. Returns an
 * empty history (and callers fall back to the historical/prior rate) before
 * any gameweek has finished.
 */
export async function loadInSeasonPlayerRates(
  players: readonly InSeasonFormPlayer[],
  fixtures: readonly InSeasonFormFixture[],
): Promise<Record<number, PlayerMatchRate[]>> {
  const teamByPlayer = new Map(players.map((player) => [player.id, player.teamId]));
  const eligibility = eligibleGameweeks(fixtures);
  const perGameweek = await Promise.all(
    eligibility.map((entry) => loadGameweekPlayerRates(entry, teamByPlayer)),
  );

  const history: Record<number, PlayerMatchRate[]> = {};
  perGameweek.forEach((rows, index) => {
    // A gameweek is only eligible for a team that played exactly one fixture in
    // it, so every recorded appearance maps to one unambiguous opponent and
    // venue. Deriving them here rather than persisting them keeps the cached
    // per-gameweek snapshots on their existing schema.
    const opponents = opponentsForGameweek(fixtures, eligibility[index].gameweek);
    for (const row of rows) {
      const teamId = teamByPlayer.get(row.playerId);
      const against = teamId === undefined ? undefined : opponents.get(teamId);
      (history[row.playerId] ??= []).push({
        xg: row.xg,
        xa: row.xa,
        minutes: row.minutes,
        ...(against ?? {}),
      });
    }
  });
  return history;
}

/** teamId -> who they faced and whether they were at home, for one gameweek. */
function opponentsForGameweek(
  fixtures: readonly InSeasonFormFixture[],
  gameweek: number,
): Map<number, { opponentTeamId: number; wasHome: boolean }> {
  const opponents = new Map<number, { opponentTeamId: number; wasHome: boolean }>();
  for (const fixture of fixtures) {
    if (fixture.gameweek !== gameweek) continue;
    opponents.set(fixture.teamHomeId, { opponentTeamId: fixture.teamAwayId, wasHome: true });
    opponents.set(fixture.teamAwayId, { opponentTeamId: fixture.teamHomeId, wasHome: false });
  }
  return opponents;
}

const GameweekStartsSchema = z.array(
  z.object({ playerId: z.number(), started: z.boolean(), appeared: z.boolean() }),
);
type GameweekStarts = z.infer<typeof GameweekStartsSchema>;

/**
 * Per-gameweek start/appearance rows, on the same caching contract as the
 * loaders above but with one shape difference that carries the whole feature:
 * rows are filtered on team eligibility alone, never on minutes, so a player
 * who was benched is recorded with `appeared: false` rather than dropped.
 *
 * `loadGameweekPlayerRates` drops zero-minute players on purpose - a blank
 * gameweek is not "a match with zero output", and the backtest behind
 * PLAYER_FORM_DECAY built its history that way. A start-rate EWMA needs the
 * opposite: without the zero rows a player who loses his place simply stops
 * being updated and stays nailed forever. Hence a parallel loader and its own
 * snapshot key rather than an extra field on the rates one, which would
 * silently rebase the xG/xA blend.
 */
async function loadGameweekStarts(
  eligibility: GameweekEligibility,
  teamByPlayer: ReadonlyMap<number, number>,
): Promise<GameweekStarts> {
  const { gameweek, teamIds, complete } = eligibility;
  if (complete) {
    const cached = await readSnapshot(`in-season-starts-gw-${gameweek}`, GameweekStartsSchema);
    if (cached && cached.data.length > 0) return cached.data;
  }

  const live = await getLiveGameweek(gameweek);
  if (!live.data) return [];

  const eligibleElements = live.data.elements.filter((element) => {
    const teamId = teamByPlayer.get(element.id);
    return teamId !== undefined && teamIds.has(teamId);
  });

  // Same corruption guard as the loaders above: a played gameweek always has
  // someone on the pitch. Zero minutes across every eligible player means the
  // stats shape has drifted, and caching it would record a whole gameweek of
  // phantom benchings that never expire.
  if (!eligibleElements.some((element) => toNumber(element.stats.minutes) > 0)) return [];

  // A start is 60 minutes played. FPL does publish a per-match `starts` flag,
  // which is exact where this threshold is not - a starter subbed off at 55
  // minutes did start - but the recursion's seed counts a historical start the
  // same 60-minute way, and an estimate whose seed and updates disagree about
  // what it is measuring is worse than one that is uniformly approximate.
  const result: GameweekStarts = eligibleElements.map((element) => {
    const minutes = toNumber(element.stats.minutes);
    return {
      playerId: element.id,
      started: minutes >= MINUTES_FOR_START,
      appeared: minutes > 0,
    };
  });

  if (complete) await writeSnapshot(`in-season-starts-gw-${gameweek}`, result);
  return result;
}

/**
 * Each player's chronological start/appearance history for the current season,
 * one entry per eligible gameweek their team played, oldest first.
 *
 * Eligibility is shared with the xG loaders, so a double gameweek contributes
 * nothing: live stats are a per-gameweek total and cannot be split back into
 * two fixtures, and a doubled team would otherwise read as one match. That
 * costs a few observations. One notion of eligibility across every in-season
 * signal is worth more than those rows. A blank gameweek is likewise no
 * observation rather than a benching, since the team is never eligible.
 */
export async function loadInSeasonStarts(
  players: readonly InSeasonFormPlayer[],
  fixtures: readonly InSeasonFormFixture[],
): Promise<Record<number, StartObservation[]>> {
  const teamByPlayer = new Map(players.map((player) => [player.id, player.teamId]));
  const perGameweek = await Promise.all(
    eligibleGameweeks(fixtures).map((eligibility) => loadGameweekStarts(eligibility, teamByPlayer)),
  );

  const history: Record<number, StartObservation[]> = {};
  for (const rows of perGameweek) {
    for (const row of rows) {
      (history[row.playerId] ??= []).push({ started: row.started, appeared: row.appeared });
    }
  }
  return history;
}
