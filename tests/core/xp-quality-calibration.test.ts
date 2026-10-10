import { describe, expect, it } from "vitest";
import { analyzeCalibration, binIndex, commonRows, type QualityRow, validateRows } from "@/scripts/backtest/xp-quality-calibration";

function makeRows(): QualityRow[] {
  const rows: QualityRow[] = [];
  let playerId = 1;
  for (const season of ["2023-24", "2024-25"]) {
    for (let gameweek = 1; gameweek <= 12; gameweek += 1) {
      for (const [prediction, offset] of [[0.25, 0.2], [0.75, -0.1], [1.1, 0.4], [1.9, -0.3], [10, 0.5], [11, -0.2]] as const) {
        rows.push({
          season,
          gameweek,
          playerId: playerId++,
          position: "MID",
          prediction,
          actual: prediction - offset - (gameweek % 2 ? 0.1 : -0.1),
          expectedMinutes: 65,
          actualMinutes: gameweek % 3 === 0 ? 0 : 90,
          rollingPrediction: prediction * 0.9,
          minutesPrediction: prediction * 1.1,
        });
      }
    }
  }
  return rows;
}

describe("xP quality calibration", () => {
  it("uses fixed integer bands with inclusive lower boundaries and a 10+ tail", () => {
    expect([0, 0.999, 1, 9.999, 10, 28].map(binIndex)).toEqual([0, 0, 1, 9, 10, 10]);
  });

  it("conserves rows and reconstructs pooled means from the bins", () => {
    const rows = makeRows();
    validateRows(rows);
    const { pooled } = analyzeCalibration(rows);
    const bins = pooled.bins;
    const n = bins.reduce((sum, bin) => sum + bin.n, 0);
    const predicted = bins.reduce((sum, bin) => sum + (bin.meanPredicted ?? 0) * bin.n, 0) / n;
    const actual = bins.reduce((sum, bin) => sum + (bin.meanActual ?? 0) * bin.n, 0) / n;
    const weightedGap = bins.reduce((sum, bin) => sum + (bin.n / n) * Math.abs(bin.bias ?? 0), 0);

    expect(n).toBe(rows.length);
    expect(predicted).toBeCloseTo(pooled.meanPredicted!, 12);
    expect(actual).toBeCloseTo(pooled.meanActual!, 12);
    expect(weightedGap).toBeCloseTo(pooled.weightedCalibrationGap!, 12);
    expect(pooled.bias).toBeCloseTo(pooled.meanPredicted! - pooled.meanActual!, 12);
  });

  it("produces deterministic season-stratified gameweek bootstrap intervals", () => {
    const rows = makeRows();
    const first = analyzeCalibration(rows);
    const second = analyzeCalibration(rows);

    expect(first.pooled.biasCI95).not.toBeNull();
    expect(first.pooled.biasCI95).toEqual(second.pooled.biasCI95);
    expect(first.pooled.bins[0]!.biasCI95).not.toBeNull();
    expect(first.pooled.bins[0]!.biasCI95).toEqual(second.pooled.bins[0]!.biasCI95);
    expect(first.pooled.bins[0]!.bootstrapValidReplicates).toBe(2_000);
    expect(first.bySeason["2023-24"]!.biasCI95).not.toBeNull();
  });

  it("marks small bands sparse and applies the starter cutoff only to forecast minutes", () => {
    const rows = makeRows();
    rows[0] = { ...rows[0]!, expectedMinutes: 59, actualMinutes: 90 };
    const analysis = analyzeCalibration(rows);
    expect(analysis.plausibleStarters.n).toBe(rows.length - 1);
    expect(analysis.pooled.bins[2]!.sparse).toBe(true);
    expect(analysis.pooled.bins[2]!.sparseReason).toContain("fewer than");
  });

  it("uses the shared all-model cohort and accepts summed double-gameweek minutes", () => {
    const rows = makeRows();
    rows[0] = { ...rows[0]!, rollingPrediction: 0.4, minutesPrediction: 0.6, actualMinutes: 180 };
    rows[1] = { ...rows[1]!, rollingPrediction: undefined, minutesPrediction: undefined };
    rows[2] = { ...rows[2]!, rollingPrediction: undefined, minutesPrediction: undefined };

    expect(() => validateRows(rows)).not.toThrow();
    expect(commonRows(rows)).toHaveLength(rows.length - 2);
    expect(commonRows(rows)[0]!.actualMinutes).toBe(180);
  });
});
