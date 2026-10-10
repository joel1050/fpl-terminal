import { describe, expect, it } from "vitest";
import type { FixtureProjection, PlayerFixture } from "@/types/player";
import type { TeamStrength } from "@/types/projection";
import { CLEAN_SHEET_DISPERSION, calculateFixtureAdjustment } from "@/lib/projections/fixtureAdjustment";
import { aggregateFixturePointsByGameweek } from "@/lib/projections/projectPlayer";
import { deduplicateHistoricalFixtureRows } from "@/scripts/backtest/historicalBacktest";
import { attackdefensemultFixtureAdjustment } from "@/scripts/backtest/attackdefensemult-adjustment";
import {
  BASELINE_ATTACK_DEFENSE_MODEL,
  evaluateDifficultyCurve,
  latestStrictlyPriorElo,
  pairedGameweekClusterBootstrap,
  poissonQuasiDeviance,
  validateDifficultyCurve,
} from "@/scripts/backtest/attackdefensemult-model";

describe("attackdefensemult experiment controls", () => {
  it("selects the latest ClubElo point strictly before the cutoff date", () => {
    const points = [
      { date: "2025-08-01", elo: 1500 },
      { date: "2025-08-05", elo: 1510 },
      { date: "2025-08-09", elo: 1520 },
    ];
    expect(latestStrictlyPriorElo(points, "2025-08-09")).toEqual({ date: "2025-08-05", elo: 1510, daysLag: 4 });
    expect(latestStrictlyPriorElo(points, "2025-07-31")).toBeUndefined();
  });

  it("scores zero xG without adding an arbitrary positive floor", () => {
    expect(poissonQuasiDeviance(0, 2)).toBe(4);
    expect(poissonQuasiDeviance(2, 2)).toBe(0);
    expect(() => poissonQuasiDeviance(0, 0)).toThrow(/mean/);
  });

  it("requires difficulty curves to be anchored and monotone", () => {
    const attack = [1.2, 1.1, 1, 0.9, 0.8] as const;
    validateDifficultyCurve(attack, "decreasing");
    expect(evaluateDifficultyCurve(attack, 2.5)).toBeCloseTo(1.05);
    expect(() => validateDifficultyCurve([1.2, 1.1, 1, 1.01, 0.8], "decreasing")).toThrow(/monotone/);
    expect(() => validateDifficultyCurve([1.2, 1.1, 0.99, 0.9, 0.8], "decreasing")).toThrow(/anchored/);
  });

  it("keeps the baseline experiment adapter exactly on the production rated path", () => {
    const ownTeam: TeamStrength = {
      teamId: 1, overall: 1.1, attackHome: 1.12, attackAway: 0.96, defenceHome: 1.03, defenceAway: 0.91,
    };
    const opponentTeam: TeamStrength = {
      teamId: 2, overall: 0.9, attackHome: 0.88, attackAway: 1.04, defenceHome: 0.94, defenceAway: 1.16,
    };
    const fixture: PlayerFixture = {
      fixtureId: 42, gameweek: 8, opponentTeamId: 2, opponentShortName: "OPP",
      isHome: true, difficulty: 4, exactDifficulty: 4.2,
    };
    const ownCleanSheet = { attack: 0.93, defence: 1.18 };
    const opponentCleanSheet = { attack: 1.12, defence: 0.91 };
    const production = calculateFixtureAdjustment(fixture, { ownTeam, opponentTeam, ownCleanSheet, opponentCleanSheet });
    const adapter = attackdefensemultFixtureAdjustment(fixture, {
      model: BASELINE_ATTACK_DEFENSE_MODEL,
      ownTeam,
      opponentTeam,
      ownCleanSheet,
      opponentCleanSheet,
    });
    expect(adapter).toEqual(production);
    expect(adapter.expectedGoalsAgainst).toBeGreaterThan(0);
    expect(adapter.cleanSheetProbability).toBeCloseTo(
      (CLEAN_SHEET_DISPERSION / (CLEAN_SHEET_DISPERSION + adapter.expectedGoalsAgainst)) ** CLEAN_SHEET_DISPERSION,
    );
  });

  it("drops exact duplicate player-fixture records and rejects conflicts", () => {
    const row = { historicalPlayerId: 7, fixtureId: 10, gameweek: 2, minutes: 0, totalPoints: 0 };
    expect(deduplicateHistoricalFixtureRows([row, { ...row }])).toEqual({ rows: [row], duplicatesRemoved: 1 });
    expect(() => deduplicateHistoricalFixtureRows([row, { ...row, minutes: 1 }])).toThrow(/conflicting/);
  });

  it("sums both fixtures in a double gameweek", () => {
    const fixture = (fixtureId: number, expectedPoints: number): FixtureProjection => ({
      gameweek: 6,
      expectedPoints,
      expectedMinutes: 70,
      fixture: {
        fixtureId,
        gameweek: 6,
        opponentTeamId: fixtureId + 10,
        opponentShortName: "OPP",
        isHome: fixtureId === 1,
        difficulty: 3,
      },
    });
    expect(aggregateFixturePointsByGameweek([fixture(1, 2.25), fixture(2, 3.25)]).get(6)).toBe(5.5);
  });

  it("returns deterministic paired whole-gameweek bootstrap metrics", () => {
    const rows = [
      { season: "2024-25", gameweek: 1, actual: 1, baseline: 0, candidate: 0.5 },
      { season: "2024-25", gameweek: 2, actual: 2, baseline: 1, candidate: 1.5 },
      { season: "2025-26", gameweek: 1, actual: 1, baseline: 1, candidate: 1 },
      { season: "2025-26", gameweek: 2, actual: 3, baseline: 2, candidate: 2.5 },
    ];
    const first = pairedGameweekClusterBootstrap(rows, "rmse", { draws: 500, seed: 1234 });
    const second = pairedGameweekClusterBootstrap(rows, "rmse", { draws: 500, seed: 1234 });
    expect(first).toEqual(second);
    expect(first.rows).toBe(4);
    expect(first.clusters).toBe(4);
    expect(first.difference).toBeLessThan(0);
  });
});
