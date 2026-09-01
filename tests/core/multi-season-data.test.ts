import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HistoricalMatchStat, HistoricalPlayerRecord, HistoricalTeamStrength } from "@/lib/historical/types";
import {
  buildFixturesFromMatchRows,
  buildPlayerAnchors,
  buildPreviousSeasonTeamPriors,
} from "@/scripts/backtest/multiSeasonData";

describe("multi-season backtest inputs", () => {
  it("uses only previous-season player codes and team xG for target-season priors", () => {
    const previousPlayers = [{
      historicalPlayerId: 1,
      code: 100,
      displayName: "Returning",
      stats: { season: "2022/23", minutes: 1800, expectedGoals: 4 },
    }] satisfies HistoricalPlayerRecord[];
    const targetPlayers = [
      { historicalPlayerId: 10, code: 100, displayName: "Returning", stats: { season: "2023/24", minutes: 900, expectedGoals: 99 } },
      { historicalPlayerId: 11, code: 200, displayName: "New", stats: { season: "2023/24", minutes: 900, expectedGoals: 99 } },
    ] satisfies HistoricalPlayerRecord[];
    expect(buildPlayerAnchors(targetPlayers, previousPlayers)).toEqual([{
      historicalPlayerId: 10,
      sourceHistoricalPlayerId: 1,
      code: 100,
      stats: previousPlayers[0].stats,
    }]);

    const rows = [
      { historicalPlayerId: 1, gameweek: 1, fixtureId: 50, opponentTeamId: 2, minutes: 90, totalPoints: 2, goals: 1, assists: 0, expectedGoals: 1, expectedAssists: 0, bonus: 0, bps: 0, wasHome: true },
      { historicalPlayerId: 2, gameweek: 1, fixtureId: 50, opponentTeamId: 1, minutes: 90, totalPoints: 2, goals: 0, assists: 0, expectedGoals: 0.5, expectedAssists: 0, bonus: 0, bps: 0, wasHome: false },
    ] satisfies HistoricalMatchStat[];
    const fixtures = buildFixturesFromMatchRows(rows);
    const previousTeams = [
      { teamId: 1, name: "Alpha", shortName: "ALP" },
      { teamId: 2, name: "Beta", shortName: "BET" },
    ] satisfies HistoricalTeamStrength[];
    const targetTeams = [
      { teamId: 21, name: "Alpha", shortName: "ALP" },
      { teamId: 22, name: "Promoted", shortName: "PRO" },
    ] satisfies HistoricalTeamStrength[];
    const { priors, fallbackTeams } = buildPreviousSeasonTeamPriors(targetTeams, previousTeams, fixtures);
    expect(priors[0]).toMatchObject({ teamId: 21, attackHome: 4 / 3, defenceHome: 1.5 });
    expect(priors[1]).toMatchObject({ teamId: 22, attackHome: 1, defenceHome: 1 });
    expect(fallbackTeams).toEqual(["Promoted"]);
  });

  it("does not fall back to target-season totals for an unanchored player", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fpl-multi-season-test-"));
    const previousDirectory = process.env.BACKTEST_DATA_DIR;
    const row = (historicalPlayerId: number, opponentTeamId: number, wasHome: boolean) => ({
      historicalPlayerId, gameweek: 1, fixtureId: 50, opponentTeamId, minutes: 90,
      totalPoints: 2, goals: 0, assists: 0, expectedGoals: 0.1, expectedAssists: 0,
      bonus: 0, bps: 0, wasHome,
    });
    try {
      await Promise.all([
        writeFile(path.join(directory, "historical-match-stats.json"), JSON.stringify([
          row(10, 2, true), row(11, 1, false),
        ])),
        writeFile(path.join(directory, "historical-players.json"), JSON.stringify([
          { historicalPlayerId: 10, code: 100, displayName: "Anchored", teamName: "Alpha", position: "MID", stats: { season: "2023/24", minutes: 90, expectedGoals: 99 } },
          { historicalPlayerId: 11, code: 200, displayName: "New", teamName: "Beta", position: "MID", stats: { season: "2023/24", minutes: 90, expectedGoals: 99 } },
        ])),
        writeFile(path.join(directory, "preseason-team-strength.json"), JSON.stringify([
          { teamId: 1, name: "Alpha", shortName: "ALP", overallHome: 1, overallAway: 1, attackHome: 1, attackAway: 1, defenceHome: 1, defenceAway: 1 },
          { teamId: 2, name: "Beta", shortName: "BET", overallHome: 1, overallAway: 1, attackHome: 1, attackAway: 1, defenceHome: 1, defenceAway: 1 },
        ])),
        writeFile(path.join(directory, "previous-player-anchors.json"), JSON.stringify([
          { historicalPlayerId: 10, sourceHistoricalPlayerId: 1, code: 100, stats: { season: "2022/23", minutes: 1800, expectedGoals: 4 } },
        ])),
      ]);
      process.env.BACKTEST_DATA_DIR = directory;
      const { loadSeason, playerAt } = await import("@/scripts/backtest/season");
      const season = loadSeason();
      const fixture = season.fixtures[0];
      expect(playerAt(season, 10, 1, fixture, true)?.historical?.season).toBe("2022/23");
      expect(playerAt(season, 11, 1, fixture, false)?.historical).toBeUndefined();
    } finally {
      if (previousDirectory === undefined) delete process.env.BACKTEST_DATA_DIR;
      else process.env.BACKTEST_DATA_DIR = previousDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
