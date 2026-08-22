import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * One player's minutes in one completed match of the current season.
 *
 * Team selection is a decision somebody makes each week, so a player's role is
 * read from how recently he played rather than from a season-long average. That
 * needs the matches themselves, which the season totals in a bootstrap payload
 * cannot supply.
 */
export interface CurrentMatchStat {
  playerId: number;
  gameweek: number;
  minutes: number;
}

export interface LiveGameweekMinutes {
  gameweek: number;
  elements: readonly { playerId: number; stats: Record<string, number | string | null> }[];
}

function minutesOf(stats: Record<string, number | string | null>): number | undefined {
  const value = stats.minutes;
  const minutes = typeof value === "string" ? Number(value) : value;
  return typeof minutes === "number" && Number.isFinite(minutes) ? Math.max(0, minutes) : undefined;
}

/**
 * Flattens live gameweek payloads into one row per player per match.
 *
 * Only finished gameweeks may be passed in. A gameweek still in progress
 * reports zero minutes for everyone whose match has not kicked off, which would
 * read as a benching.
 */
export function buildCurrentMatchStats(
  gameweeks: readonly LiveGameweekMinutes[],
): CurrentMatchStat[] {
  const rows: CurrentMatchStat[] = [];
  for (const gameweek of gameweeks) {
    for (const element of gameweek.elements) {
      const minutes = minutesOf(element.stats);
      if (minutes === undefined) continue;
      rows.push({ playerId: element.playerId, gameweek: gameweek.gameweek, minutes });
    }
  }
  return rows.sort((a, b) => a.gameweek - b.gameweek || a.playerId - b.playerId);
}

/** Groups rows by player so the selection model can read one timeline per player. */
export function groupCurrentMatchStats(
  rows: readonly CurrentMatchStat[],
): Map<number, CurrentMatchStat[]> {
  const byPlayer = new Map<number, CurrentMatchStat[]>();
  for (const row of rows) {
    const existing = byPlayer.get(row.playerId);
    if (existing) existing.push(row);
    else byPlayer.set(row.playerId, [row]);
  }
  return byPlayer;
}

/** Reads the last generated file without making network requests. */
export function loadCurrentMatchStats(
  generatedDir = path.join(process.cwd(), "data", "generated"),
): CurrentMatchStat[] {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(generatedDir, "current-match-stats.json"), "utf8"),
    ) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : (parsed as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is CurrentMatchStat =>
      row !== null && typeof row === "object" &&
      typeof (row as CurrentMatchStat).playerId === "number" &&
      typeof (row as CurrentMatchStat).gameweek === "number" &&
      typeof (row as CurrentMatchStat).minutes === "number");
  } catch {
    return [];
  }
}
