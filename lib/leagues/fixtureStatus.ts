import type { FixtureState, FixtureView, PlayerFixtureStatus, PlayerGameweekStatus } from "@/types/leagues";

export interface TeamFixtureInfo {
  fixtureId: number;
  opponentTeamId: number;
  isHome: boolean;
  state: FixtureState;
  minutes?: number;
  kickoffTime?: string | null;
}

/**
 * Classifies a single gameweek fixture from its live fields. FPL holds
 * `finished` back until it confirms bonus points, so a match that has ended
 * only carries `finished_provisional`; both count as finished here.
 */
export function fixtureStateOf(fixture: {
  finished?: boolean;
  finishedProvisional?: boolean;
  started?: boolean;
  minutes?: number;
}): FixtureState {
  if (fixture.finished || fixture.finishedProvisional) return "FINISHED";
  if (fixture.started) return "LIVE";
  return "UPCOMING";
}

export interface LivePollInput {
  anyFixtureLive: boolean;
  /** A match has ended but FPL has not confirmed its bonus points yet. */
  anyFixtureSettling: boolean;
  waitingForCurrentData: boolean;
}

export const LIVE_POLL_MS = 60_000;
export const SETTLING_POLL_MS = 120_000;

/**
 * How often to ask FPL for the live Gameweek, or null to stop asking.
 *
 * Polling deliberately outlives the final whistle: FPL publishes provisional
 * bonus while a match is still marked unfinished and rewrites it afterwards,
 * and that rewrite is the change managers watch hardest for. A settled
 * Gameweek — every fixture finished and confirmed — is the only quiet one.
 */
export function livePollIntervalMs(input: LivePollInput): number | null {
  if (input.anyFixtureLive || input.waitingForCurrentData) return LIVE_POLL_MS;
  if (input.anyFixtureSettling) return SETTLING_POLL_MS;
  return null;
}

/**
 * Groups the gameweek fixtures by team. Double Gameweeks naturally produce two
 * entries for a club; blank gameweeks produce none.
 */
export function teamFixturesByTeam(
  fixtures: ReadonlyArray<FixtureView>,
): Map<number, TeamFixtureInfo[]> {
  const byTeam = new Map<number, TeamFixtureInfo[]>();
  const push = (teamId: number, info: TeamFixtureInfo) => {
    const existing = byTeam.get(teamId);
    if (existing) existing.push(info);
    else byTeam.set(teamId, [info]);
  };
  for (const fixture of fixtures) {
    const shared = {
      fixtureId: fixture.id,
      state: fixture.state,
      minutes: fixture.minutes,
      kickoffTime: fixture.kickoffTime,
    };
    push(fixture.homeTeamId, { ...shared, opponentTeamId: fixture.awayTeamId, isHome: true });
    push(fixture.awayTeamId, { ...shared, opponentTeamId: fixture.homeTeamId, isHome: false });
  }
  return byTeam;
}

export interface PlayerStatusResult {
  status: PlayerGameweekStatus;
  started: boolean;
  remaining: number;
  finished: number;
  live: number;
}

/**
 * Aggregates every fixture a player's club plays in the gameweek.
 * A player only counts as DONE when all of their fixtures are finished;
 * mixed double headers stay LIVE until the last match ends.
 */
export function aggregatePlayerStatus(
  fixtures: readonly PlayerFixtureStatus[] | undefined,
): PlayerStatusResult {
  const list = fixtures ?? [];
  const finished = list.filter((item) => item.state === "FINISHED").length;
  const live = list.filter((item) => item.state === "LIVE").length;
  const upcoming = list.length - finished - live;
  if (!list.length || list.every((item) => item.state === "UPCOMING")) {
    return { status: "TO_PLAY", started: false, remaining: list.length, finished: 0, live: 0 };
  }
  if (upcoming === 0 && live === 0) {
    return { status: "DONE", started: true, remaining: 0, finished, live: 0 };
  }
  return { status: "LIVE", started: true, remaining: upcoming + live, finished, live };
}
