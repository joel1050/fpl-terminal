import { describe, expect, it } from "vitest";
import { averageRanks, spearman, topPredicted, type XpQualityRow } from "@/scripts/backtest/xp-quality-ranking";

function row(playerId: number, prediction: number, actual: number): XpQualityRow {
  return {
    season: "2025-26",
    gameweek: 12,
    playerId,
    position: "MID",
    prediction,
    actual,
    expectedMinutes: 80,
    expectedMinutesTotal: 80,
    rollingPrediction: prediction,
    minutesPrediction: prediction,
  };
}

describe("xP ranking quality helpers", () => {
  it("assigns average ranks to tied values", () => {
    expect(averageRanks([30, 10, 10, 20])).toEqual([4, 1.5, 1.5, 3]);
  });

  it("returns a perfect Spearman score for matching tied order", () => {
    expect(spearman([1, 1, 2, 3], [5, 5, 6, 7])).toBeCloseTo(1, 12);
  });

  it("marks Spearman undefined when either ranked vector has no variance", () => {
    expect(spearman([2, 2, 2], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2, 3], [7, 7, 7])).toBeNull();
  });

  it("measures a known reversed ordering as -1", () => {
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
  });

  it("breaks top-k prediction ties by ascending player ID", () => {
    const selected = topPredicted([
      row(19, 5, 1),
      row(8, 5, 2),
      row(3, 6, 3),
      row(11, 5, 4),
    ], "production", 3);

    expect(selected.map((candidate) => candidate.playerId)).toEqual([3, 8, 11]);
  });
});
