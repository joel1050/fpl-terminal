import { z } from "zod";
import { getLiveGameweek } from "@/lib/fpl/client";
import { readSnapshot, writeSnapshot } from "@/lib/fpl/cache";
import type { TeamMatchXG } from "./inSeasonForm";
import type { PlayerMatchRate } from "@/lib/projections/playerForm";

const GameweekTeamXGSchema = z.array(
  z.object({ teamId: z.number(), xgFor: z.number(), xgAgainst: z.number() }),
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
    result.push({ teamId: fixture.teamHomeId, xgFor: homeXg, xgAgainst: awayXg });
    result.push({ teamId: fixture.teamAwayId, xgFor: awayXg, xgAgainst: homeXg });
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
      (history[row.teamId] ??= []).push({ xgFor: row.xgFor, xgAgainst: row.xgAgainst });
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
  const perGameweek = await Promise.all(
    eligibleGameweeks(fixtures).map((eligibility) => loadGameweekPlayerRates(eligibility, teamByPlayer)),
  );

  const history: Record<number, PlayerMatchRate[]> = {};
  for (const rows of perGameweek) {
    for (const row of rows) {
      (history[row.playerId] ??= []).push({ xg: row.xg, xa: row.xa, minutes: row.minutes });
    }
  }
  return history;
}
