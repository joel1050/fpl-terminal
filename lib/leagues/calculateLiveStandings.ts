import type {
  ClassicStandingRow,
  EntryPicks,
  FixtureView,
  LiveStandingsResult,
  LiveStandingRow,
} from "@/types/leagues";
import { calculateLiveEntry, type LiveStats } from "./calculateLiveEntry";

/** Above this size a league is treated as partial even if every page loaded. */
export const MAX_STANDINGS_ROWS = 150;

export interface CalculateLiveStandingsInput {
  rows: readonly ClassicStandingRow[];
  userEntryId: number;
  picksByEntry: ReadonlyMap<number, EntryPicks>;
  liveElementsByElement: ReadonlyMap<number, LiveStats>;
  fixtures: readonly FixtureView[];
  teamIdByElement: ReadonlyMap<number, number>;
  /** True when the loaded rows cover the whole league (no further pages). */
  completePopulation: boolean;
}

/**
 * Builds live mini-league standings from official rows plus locally computed
 * Gameweek scores. The current Gameweek is never double-counted: each member's
 * pre-Gameweek total comes from their own picks history as
 * `total_points − points`, so any points FPL has already recorded are replaced,
 * not added again.
 *
 * A league whose population is incomplete (further pages exist) never receives
 * a local live rank; those rows keep their official ordering and totals.
 */
export function calculateLiveStandings(input: CalculateLiveStandingsInput): LiveStandingsResult {
  const { rows, userEntryId, picksByEntry, completePopulation } = input;
  const canCalculateLive = completePopulation
    && rows.length > 0
    && rows.length <= MAX_STANDINGS_ROWS
    && rows.every((row) => picksByEntry.has(row.entryId));

  const officialRows = (): LiveStandingRow[] => rows.map((row) => ({
    entryId: row.entryId,
    entryName: row.entryName,
    playerName: row.playerName,
    officialRank: row.rank,
    lastRank: row.lastRank,
    officialTotal: row.total,
    officialGameweekPoints: row.eventTotal,
    preGameweekTotal: 0,
    gameweekPoints: Number.NaN,
    liveTotal: row.total ?? 0,
    leftToPlay: Number.NaN,
    movement: Number.NaN,
    localRank: row.rank ?? 0,
    isUser: row.entryId === userEntryId,
  }));

  if (!canCalculateLive) {
    return { rows: officialRows(), completePopulation: false, calculatedEntries: 0 };
  }

  const scored = new Map<number, { gameweekPoints: number; leftToPlay: number }>();
  for (const row of rows) {
    const picks = picksByEntry.get(row.entryId);
    if (!picks) continue;
    const calculation = calculateLiveEntry({
      picks,
      liveElementsByElement: input.liveElementsByElement,
      fixtures: input.fixtures,
      teamIdByElement: input.teamIdByElement,
    });
    // Same rule as the Live Gameweek panel: only players FPL is scoring count.
    const leftToPlay = calculation.live + calculation.toPlay;
    scored.set(row.entryId, { gameweekPoints: calculation.netPoints, leftToPlay });
  }

  const enriched: LiveStandingRow[] = rows.map((row) => {
    const picks = picksByEntry.get(row.entryId)!;
    const score = scored.get(row.entryId);
    const history = picks.entryHistory;
    const recordedPoints = history?.points;
    const preGameweekTotal = history?.totalPoints !== undefined && recordedPoints !== undefined
      ? history.totalPoints - recordedPoints
      : row.total !== undefined && recordedPoints !== undefined
        ? row.total - recordedPoints
        : row.total ?? 0;
    return {
      entryId: row.entryId,
      entryName: row.entryName,
      playerName: row.playerName,
      officialRank: row.rank,
      lastRank: row.lastRank,
      officialTotal: row.total,
      officialGameweekPoints: row.eventTotal,
      preGameweekTotal,
      gameweekPoints: score?.gameweekPoints ?? 0,
      liveTotal: preGameweekTotal + (score?.gameweekPoints ?? 0),
      leftToPlay: score?.leftToPlay ?? 0,
      movement: 0,
      localRank: 0,
      isUser: row.entryId === userEntryId,
    };
  });

  enriched.sort((left, right) =>
    right.liveTotal - left.liveTotal
    || right.gameweekPoints - left.gameweekPoints
    || (left.officialRank ?? Number.MAX_SAFE_INTEGER) - (right.officialRank ?? Number.MAX_SAFE_INTEGER)
    || left.entryId - right.entryId);
  enriched.forEach((row, index) => {
    row.localRank = index + 1;
    row.movement = (row.officialRank ?? index + 1) - row.localRank;
  });
  return { rows: enriched, completePopulation: true, calculatedEntries: scored.size };
}
