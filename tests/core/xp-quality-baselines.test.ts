import { describe, expect, it } from "vitest";
import {
  aggregatePlayerGameweeks,
  errorMetrics,
  recentBaselinePredictions,
  type PlayerFixtureOutcome,
} from "@/scripts/backtest/xp-quality-data";

function fixture(
  gameweek: number,
  fixtureId: number,
  totalPoints: number,
  minutes: number,
): PlayerFixtureOutcome {
  return { gameweek, fixtureId, totalPoints, minutes };
}

describe("xP quality baseline data", () => {
  it("sums double-gameweek fixtures and retains explicit zero-minute outcomes", () => {
    expect(aggregatePlayerGameweeks([
      fixture(1, 10, 2, 90),
      fixture(2, 11, 0, 0),
      fixture(2, 12, 4, 60),
    ])).toEqual([
      { gameweek: 1, points: 2, minutes: 90, fixtureCount: 1 },
      { gameweek: 2, points: 4, minutes: 60, fixtureCount: 2 },
    ]);
  });

  it("uses only the latest five prior recorded GWs and scores DGWs per fixture", () => {
    const outcomes = [
      fixture(1, 1, 100, 90),
      fixture(2, 2, 1, 90),
      fixture(3, 3, 0, 0),
      fixture(4, 4, 2, 90),
      fixture(5, 5, 3, 90),
      fixture(6, 6, 4, 90),
      fixture(7, 7, 2, 45),
      fixture(7, 8, 3, 45),
      fixture(8, 9, 1000, 90),
      fixture(9, 10, 2000, 90),
    ];

    const baseline = recentBaselinePredictions(outcomes, 8, 2, 75);
    expect(baseline).toEqual({
      rollingPrediction: (14 / 6) * 2,
      minutesPrediction: (14 / 360) * 150,
      priorRecordedGameweeks: 5,
      priorFixtureCount: 6,
      priorActualMinutes: 360,
    });
  });

  it("applies separate history gates and does not let target or future outcomes change a forecast", () => {
    const prior = [fixture(1, 1, 2, 89), fixture(2, 2, 0, 89), fixture(3, 3, 3, 0)];
    const before = recentBaselinePredictions(prior, 4, 1, 90);
    const afterAddingFuture = recentBaselinePredictions([
      ...prior,
      fixture(4, 4, 999, 90),
      fixture(5, 5, 9999, 90),
    ], 4, 1, 90);
    expect(afterAddingFuture).toEqual(before);
    expect(before.rollingPrediction).toBe(5 / 3);
    expect(before.minutesPrediction).toBeUndefined();

    const twoPriorWeeks = recentBaselinePredictions([
      fixture(1, 1, 4, 120),
      fixture(2, 2, 0, 120),
    ], 3, 1, 90);
    expect(twoPriorWeeks.rollingPrediction).toBeUndefined();
    expect(twoPriorWeeks.minutesPrediction).toBe(1.5);
  });

  it("computes RMSE, MAE, and signed mean bias in points", () => {
    expect(errorMetrics([2, 4], [1, 2])).toEqual({
      n: 2,
      rmse: Math.sqrt(2.5),
      mae: 1.5,
      meanBias: 1.5,
    });
    expect(() => errorMetrics([1], [])).toThrow("same non-zero row count");
    expect(() => errorMetrics([Number.NaN], [0])).toThrow("must be finite");
  });
});
