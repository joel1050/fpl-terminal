import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HistoricalStats, Player, Position } from "@/types/player";
import { projectPlayer } from "@/lib/projections";

/**
 * Scoring-model calibration against 2025/26.
 *
 * Every player is projected from the rates they actually recorded, so nothing
 * here measures how well the model forecasts. It measures whether the scoring
 * rules pay the right amount once the rates are known. A positive bias means
 * the model would rank that position above where it belongs.
 *
 * Points are compared per appearance of 60 minutes or more. Comparing per 90
 * would credit whoever plays the shortest matches, because an appearance point
 * is earned once per match and does not scale with minutes.
 */

interface HistoricalPlayer {
  historicalPlayerId: number;
  displayName: string;
  position: Position;
  stats: HistoricalStats;
}

interface MatchStat {
  historicalPlayerId: number;
  minutes: number;
  totalPoints: number;
}

const root = path.resolve(__dirname, "../..");
const read = <T,>(file: string): T =>
  JSON.parse(readFileSync(path.join(root, "data/generated", file), "utf8")) as T;

const players = read<HistoricalPlayer[]>("historical-players.json");
const matches = read<MatchStat[]>("historical-match-stats.json");

const appearances = new Map<number, MatchStat[]>();
for (const row of matches) {
  if (row.minutes < 60) continue;
  const rows = appearances.get(row.historicalPlayerId) ?? [];
  rows.push(row);
  appearances.set(row.historicalPlayerId, rows);
}

/**
 * Rebuilds a player whose per-90 rates match the season exactly. Minutes are
 * scaled up so the regression toward positional priors is negligible: the
 * point is to isolate the scoring rules from the rate model.
 */
function asPlayer(source: HistoricalPlayer, position: Position): Player {
  const stats = source.stats;
  const scale = 90_000 / Math.max(stats.minutes, 1);
  const scaled = (value: number | undefined): number => (value ?? 0) * scale;
  const historical: HistoricalStats = {
    season: stats.season,
    minutes: 90_000,
    starts: 1_000,
    goals: scaled(stats.goals),
    assists: scaled(stats.assists),
    expectedGoals: scaled(stats.expectedGoals),
    expectedAssists: scaled(stats.expectedAssists),
    saves: scaled(stats.saves),
    bonus: scaled(stats.bonus),
    defensiveContribution: scaled(stats.defensiveContribution),
  };
  return {
    id: source.historicalPlayerId,
    firstName: source.displayName,
    lastName: "",
    displayName: source.displayName,
    teamId: 1,
    teamName: "Test",
    teamShortName: "TST",
    position,
    priceTenths: 50,
    ownership: 0,
    status: "a",
    current: { totalPoints: 0, minutes: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0 },
    historical,
    fixtures: [
      { gameweek: 1, opponentTeamId: 2, opponentShortName: "OPP", isHome: true, difficulty: 3 },
      { gameweek: 2, opponentTeamId: 2, opponentShortName: "OPP", isHome: false, difficulty: 3 },
    ],
  };
}

interface Bias { position: Position; count: number; model: number; actual: number }

function measure(): Bias[] {
  const totals = new Map<Position, Bias>();
  for (const source of players) {
    const stats = source.stats;
    const rows = appearances.get(source.historicalPlayerId) ?? [];
    if (stats.minutes < 900 || (stats.starts ?? 0) < 10 || rows.length < 8) continue;
    const minutes = rows.reduce((sum, row) => sum + row.minutes, 0) / rows.length;
    const actual = rows.reduce((sum, row) => sum + row.totalPoints, 0) / rows.length;
    const projection = projectPlayer(asPlayer(source, source.position), {
      currentGameweek: 1,
      horizon: 1,
      expectedMinutes: minutes,
    });
    // One home and one away fixture, averaged, so venue cancels out.
    const model = (projection.fixtures[0]!.expectedPoints + projection.fixtures[1]!.expectedPoints) / 2;
    const bias = totals.get(source.position)
      ?? { position: source.position, count: 0, model: 0, actual: 0 };
    bias.count += 1;
    bias.model += model;
    bias.actual += actual;
    totals.set(source.position, bias);
  }
  return [...totals.values()];
}

describe("scoring-model calibration on 2025/26", () => {
  const results = measure();
  // CALIBRATION_REPORT=<path> writes the full table, for tuning rather than testing.
  if (process.env.CALIBRATION_REPORT) {
    const lines = ["position  n   model  actual    bias", ...results.map((bias) =>
      [bias.position.padEnd(9), String(bias.count).padStart(3),
        (bias.model / bias.count).toFixed(2).padStart(7),
        (bias.actual / bias.count).toFixed(2).padStart(7),
        ((bias.model - bias.actual) / bias.count).toFixed(3).padStart(8)].join(" "))];
    writeFileSync(process.env.CALIBRATION_REPORT, `${lines.join("\n")}\n`);
  }

  it.each(results.map((bias) => [bias.position, bias] as const))(
    "pays %s within a quarter point of what they actually scored",
    (_position, bias) => {
      const perAppearance = (bias.model - bias.actual) / bias.count;
      expect(bias.count).toBeGreaterThan(20);
      expect(Math.abs(perAppearance)).toBeLessThan(0.25);
    },
  );

  it("does not favour one position over another", () => {
    const gaps = results.map((bias) => (bias.model - bias.actual) / bias.count);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.35);
  });
});
