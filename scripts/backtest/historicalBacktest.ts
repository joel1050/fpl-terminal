import { isDeepStrictEqual } from "node:util";

export interface HistoricalFixtureRow {
  historicalPlayerId: number;
  gameweek: number;
  fixtureId: number;
  minutes: number;
}

/** Drops exact repeated player-fixture rows and fails on any conflicting copy. */
export function deduplicateHistoricalFixtureRows<T extends HistoricalFixtureRow>(
  rows: readonly T[],
): { rows: T[]; duplicatesRemoved: number } {
  const byKey = new Map<string, T>();
  let duplicatesRemoved = 0;
  for (const row of rows) {
    const key = `${row.historicalPlayerId}:${row.fixtureId}`;
    const previous = byKey.get(key);
    if (previous === undefined) byKey.set(key, row);
    else if (!isDeepStrictEqual(previous, row)) throw new Error(`conflicting prepared duplicate ${key}`);
    else duplicatesRemoved += 1;
  }
  return { rows: [...byKey.values()], duplicatesRemoved };
}

/** Returns only observations available before the target Gameweek began. */
export function rowsBeforeGameweek<T extends { gameweek: number }>(
  rows: readonly T[],
  targetGameweek: number,
): T[] {
  if (!Number.isInteger(targetGameweek) || targetGameweek < 1) throw new Error("target Gameweek must be a positive integer");
  if (rows.some((row) => !Number.isInteger(row.gameweek) || row.gameweek < 1)) {
    throw new Error("historical rows must have positive integer Gameweeks");
  }
  return rows.filter((row) => row.gameweek < targetGameweek);
}

export type RecordedOutcome = "PLAYED" | "DNP" | "NOT_RECORDED";

/** An absent player row is unknown; only an explicit zero-minute row is a DNP. */
export function recordedFixtureOutcome(minutes: number | undefined): RecordedOutcome {
  if (minutes === undefined) return "NOT_RECORDED";
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("recorded minutes must be finite and non-negative");
  return minutes === 0 ? "DNP" : "PLAYED";
}
