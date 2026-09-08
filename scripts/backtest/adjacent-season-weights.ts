/**
 * Leak-free current-season / previous-season xGI-rate backtest.
 *
 * Prepare adjacent-season inputs first:
 *   npm run backtest:prepare
 *
 * Then point this script at the prepared root:
 *   BACKTEST_MULTI_DATA_DIR=/tmp/fpl-backtest-seasons \
 *     npx tsx scripts/backtest/adjacent-season-weights.ts
 *
 * The two target seasons are evaluated separately (2024/25 and 2025/26) and
 * together. A case is one player at one cutoff. Cutoff GW N means information
 * available after GW N: target features include rows through N, while the
 * future ten-GW rate covers N+1 through N+10.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HistoricalMatchStat, HistoricalPlayerRecord } from "@/lib/historical/types";
import type { HistoricalStats } from "@/types/player";
import { blendPlayerRate } from "@/lib/projections/playerForm";
import { buildPlayerAnchors, type PreparedPlayerAnchor } from "./multiSeasonData";

const CUTOFFS = [3, 5, 8, 12, 16, 20, 24, 28] as const;
const NEXT_GAMEWEEKS = 10;
const PRIOR_MINUTES = 450;
const FUTURE_MINUTES = 180;
const FORM_DECAY = 0.95;
const WINSOR_RATIO = 2.5;
const PRODUCTION_PRIOR_WEIGHT = 10;
const DIRECT_STEP = 5;
const PLATEAU_TOLERANCE = 0.001;

const PAIRS = [
  { priorSeason: "2023-24", targetSeason: "2024-25" },
  { priorSeason: "2024-25", targetSeason: "2025-26" },
] as const;

const DECAYS = [0.80, 0.85, 0.90, 0.93, 0.95, 0.97, 1.00] as const;
const PRIOR_WEIGHTS = [4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48] as const;
const PRODUCTION_CAPS = [20, 25, 30, 35, 40] as const;

interface PairData {
  priorSeason: string;
  targetSeason: string;
  stableMatches: number;
  anchors: PreparedPlayerAnchor[];
  targetRowsByPlayer: Map<number, HistoricalMatchStat[]>;
}

interface Case {
  targetSeason: string;
  cutoff: number;
  priorRate: number;
  currentRates: number[];
  futureRate: number;
  futureMinutes: number;
}

interface Score {
  n: number;
  futureMinutes: number;
  weightedRmse: number;
  unweightedRmse: number;
}

function read<T>(directory: string, file: string): T {
  return JSON.parse(readFileSync(path.join(directory, file), "utf8")) as T;
}

function xgiRate(stats: HistoricalStats): number | undefined {
  if (stats.minutes <= 0 || stats.expectedGoals === undefined || stats.expectedAssists === undefined) return undefined;
  return ((stats.expectedGoals + stats.expectedAssists) / stats.minutes) * 90;
}

function rowRate(row: HistoricalMatchStat): number {
  return (((row.expectedGoals ?? 0) + (row.expectedAssists ?? 0)) / row.minutes) * 90;
}

function loadPair(root: string, priorSeason: string, targetSeason: string): PairData {
  const priorDirectory = path.join(root, priorSeason);
  const targetDirectory = path.join(root, targetSeason);
  const priorPlayers = read<HistoricalPlayerRecord[]>(priorDirectory, "historical-players.json");
  const targetPlayers = read<HistoricalPlayerRecord[]>(targetDirectory, "historical-players.json");
  const anchors = buildPlayerAnchors(targetPlayers, priorPlayers);
  const targetRows = read<HistoricalMatchStat[]>(targetDirectory, "historical-match-stats.json");
  const targetRowsByPlayer = new Map<number, HistoricalMatchStat[]>();
  for (const row of targetRows) {
    const rows = targetRowsByPlayer.get(row.historicalPlayerId) ?? [];
    rows.push(row);
    targetRowsByPlayer.set(row.historicalPlayerId, rows);
  }
  return { priorSeason, targetSeason, stableMatches: anchors.length, anchors, targetRowsByPlayer };
}

function collectCases(pair: PairData): Case[] {
  const cases: Case[] = [];
  for (const cutoff of CUTOFFS) {
    for (const anchor of pair.anchors) {
      const priorRate = xgiRate(anchor.stats);
      if (priorRate === undefined || anchor.stats.minutes < PRIOR_MINUTES) continue;
      const rows = pair.targetRowsByPlayer.get(anchor.historicalPlayerId) ?? [];
      const currentRows = rows.filter((row) => row.gameweek <= cutoff && row.minutes > 0);
      const futureRows = rows.filter(
        (row) => row.gameweek > cutoff && row.gameweek <= cutoff + NEXT_GAMEWEEKS && row.minutes > 0,
      );
      const futureMinutes = futureRows.reduce((sum, row) => sum + row.minutes, 0);
      if (futureMinutes < FUTURE_MINUTES) continue;
      const futureXgi = futureRows.reduce(
        (sum, row) => sum + (row.expectedGoals ?? 0) + (row.expectedAssists ?? 0), 0,
      );
      cases.push({
        targetSeason: pair.targetSeason,
        cutoff,
        priorRate,
        currentRates: currentRows.map(rowRate),
        futureRate: (futureXgi / futureMinutes) * 90,
        futureMinutes,
      });
    }
  }
  return cases;
}

function effectiveMatches(count: number, decay: number): number {
  return count === 0 ? 0 : decay === 1 ? count : (1 - decay ** count) / (1 - decay);
}

function currentSignal(item: Case, decay: number = FORM_DECAY): number {
  return blendPlayerRate(item.currentRates, item.priorRate, decay, 0, WINSOR_RATIO);
}

function productionShare(item: Case): number {
  const effective = effectiveMatches(item.currentRates.length, FORM_DECAY);
  return effective / (effective + PRODUCTION_PRIOR_WEIGHT);
}

function productionRate(item: Case): number {
  return blendPlayerRate(
    item.currentRates,
    item.priorRate,
    FORM_DECAY,
    PRODUCTION_PRIOR_WEIGHT,
    WINSOR_RATIO,
  );
}

function directRate(item: Case, share: number): number {
  return item.priorRate * (1 - share) + currentSignal(item) * share;
}

function continuousDirect(cases: readonly Case[]): { share: number; boundary: string; score: Score } {
  let numerator = 0;
  let denominator = 0;
  for (const item of cases) {
    const delta = currentSignal(item) - item.priorRate;
    numerator += item.futureMinutes * delta * (item.futureRate - item.priorRate);
    denominator += item.futureMinutes * delta ** 2;
  }
  if (denominator <= 0) return { share: 0, boundary: "flat", score: score(cases, (item) => item.priorRate) };
  const raw = numerator / denominator;
  const share = Math.min(1, Math.max(0, raw));
  const boundary = raw <= 0 ? "lower" : raw >= 1 ? "upper" : "none";
  return { share, boundary, score: score(cases, (item) => directRate(item, share)) };
}

function gridRate(item: Case, decay: number, priorWeight: number): number {
  return blendPlayerRate(item.currentRates, item.priorRate, decay, priorWeight, WINSOR_RATIO);
}

function cappedProductionRate(item: Case, capPct: number): number {
  return directRate(item, Math.min(productionShare(item), capPct / 100));
}

function score(cases: readonly Case[], prediction: (item: Case) => number): Score {
  if (cases.length === 0) return { n: 0, futureMinutes: 0, weightedRmse: NaN, unweightedRmse: NaN };
  let weightedSquared = 0;
  let squared = 0;
  let futureMinutes = 0;
  for (const item of cases) {
    const error = prediction(item) - item.futureRate;
    squared += error ** 2;
    weightedSquared += error ** 2 * item.futureMinutes;
    futureMinutes += item.futureMinutes;
  }
  return {
    n: cases.length,
    futureMinutes,
    weightedRmse: Math.sqrt(weightedSquared / futureMinutes),
    unweightedRmse: Math.sqrt(squared / cases.length),
  };
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

function formatShares(shares: readonly number[]): string {
  if (!shares.length) return "-";
  const ranges: string[] = [];
  let start = shares[0];
  let previous = start;
  for (const share of shares.slice(1)) {
    if (share === previous + DIRECT_STEP) {
      previous = share;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = share;
    previous = share;
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(",");
}

function printDirectTable(name: string, cases: readonly Case[]): void {
  console.log(`\nDIRECT_SHARES target=${name} decay=${FORM_DECAY} winsor=${WINSOR_RATIO} plateauTolerance=${PLATEAU_TOLERANCE}`);
  console.log([
    "target", "cutoffGW", "n", "formCases", "meanFormMatches", "futureMinutes",
    "previousOnly_weightedRMSE", "previousOnly_unweightedRMSE",
    "currentOnly_weightedRMSE", "currentOnly_unweightedRMSE",
    "productionMeanCurrentSharePct", "production_weightedRMSE", "production_unweightedRMSE",
    "bestSharePct", "best_weightedRMSE", "best_unweightedRMSE", "nearOptimalSharesPct",
    "continuousBestSharePct", "continuousBoundary", "continuous_weightedRMSE", "continuous_unweightedRMSE",
  ].join("\t"));
  for (const cutoff of CUTOFFS) {
    const subset = cases.filter((item) => item.cutoff === cutoff);
    const previous = score(subset, (item) => item.priorRate);
    const current = score(subset, (item) => currentSignal(item));
    const shipped = score(subset, productionRate);
    const shares = Array.from({ length: 100 / DIRECT_STEP + 1 }, (_, index) => index * DIRECT_STEP);
    const scores = shares.map((share) => ({ share, score: score(subset, (item) => directRate(item, share / 100)) }));
    const best = scores.reduce((left, right) =>
      right.score.weightedRmse < left.score.weightedRmse ? right : left,
    );
    const near = scores
      .filter((entry) => entry.score.weightedRmse <= best.score.weightedRmse + PLATEAU_TOLERANCE)
      .map((entry) => entry.share);
    const continuous = continuousDirect(subset);
    const formCounts = subset.map((item) => item.currentRates.length);
    const productionShares = subset.map(productionShare);
    console.log([
      name,
      cutoff,
      subset.length,
      subset.filter((item) => item.currentRates.length > 0).length,
      mean(formCounts).toFixed(2),
      previous.futureMinutes,
      previous.weightedRmse.toFixed(5),
      previous.unweightedRmse.toFixed(5),
      current.weightedRmse.toFixed(5),
      current.unweightedRmse.toFixed(5),
      (mean(productionShares) * 100).toFixed(2),
      shipped.weightedRmse.toFixed(5),
      shipped.unweightedRmse.toFixed(5),
      best.share,
      best.score.weightedRmse.toFixed(5),
      best.score.unweightedRmse.toFixed(5),
      formatShares(near),
      (continuous.share * 100).toFixed(2),
      continuous.boundary,
      continuous.score.weightedRmse.toFixed(5),
      continuous.score.unweightedRmse.toFixed(5),
    ].join("\t"));
  }
}

function printGrid(
  train: readonly Case[],
  validation: readonly Case[],
  pooled: readonly Case[],
): void {
  console.log(`\nGLOBAL_GRID winsor=${WINSOR_RATIO} metric=next${NEXT_GAMEWEEKS}GW_xGI90`);
  console.log([
    "decay", "priorWeightMatches",
    "train_n", "train_futureMinutes", "train_weightedRMSE", "train_unweightedRMSE",
    "validation_n", "validation_futureMinutes", "validation_weightedRMSE", "validation_unweightedRMSE",
    "pooled_n", "pooled_futureMinutes", "pooled_weightedRMSE", "pooled_unweightedRMSE",
  ].join("\t"));
  const results: {
    decay: number;
    priorWeight: number;
    train: Score;
    validation: Score;
    pooled: Score;
  }[] = [];
  for (const decay of DECAYS) {
    for (const priorWeight of PRIOR_WEIGHTS) {
      const result = {
        decay,
        priorWeight,
        train: score(train, (item) => gridRate(item, decay, priorWeight)),
        validation: score(validation, (item) => gridRate(item, decay, priorWeight)),
        pooled: score(pooled, (item) => gridRate(item, decay, priorWeight)),
      };
      results.push(result);
      console.log([
        decay.toFixed(2),
        priorWeight,
        result.train.n,
        result.train.futureMinutes,
        result.train.weightedRmse.toFixed(5),
        result.train.unweightedRmse.toFixed(5),
        result.validation.n,
        result.validation.futureMinutes,
        result.validation.weightedRmse.toFixed(5),
        result.validation.unweightedRmse.toFixed(5),
        result.pooled.n,
        result.pooled.futureMinutes,
        result.pooled.weightedRmse.toFixed(5),
        result.pooled.unweightedRmse.toFixed(5),
      ].join("\t"));
    }
  }
  const best = (field: "train" | "validation" | "pooled") =>
    results.reduce((left, right) => right[field].weightedRmse < left[field].weightedRmse ? right : left);
  const boundary = (winner: (typeof results)[number]) => [
    winner.decay === DECAYS[0] ? "decay_min" : winner.decay === DECAYS[DECAYS.length - 1] ? "decay_max" : "",
    winner.priorWeight === PRIOR_WEIGHTS[0] ? "prior_min" : winner.priorWeight === PRIOR_WEIGHTS[PRIOR_WEIGHTS.length - 1] ? "prior_max" : "",
  ].filter(Boolean).join(",") || "none";
  for (const field of ["train", "validation", "pooled"] as const) {
    const winner = best(field);
    console.log(
      `GLOBAL_BEST split=${field} decay=${winner.decay.toFixed(2)} priorWeightMatches=${winner.priorWeight}`
      + ` weightedRMSE=${winner[field].weightedRmse.toFixed(5)} unweightedRMSE=${winner[field].unweightedRmse.toFixed(5)}`
      + ` boundary=${boundary(winner)}`,
    );
  }
  const trainWinner = best("train");
  console.log(
    `TRAIN_PICK_ON_VALIDATION decay=${trainWinner.decay.toFixed(2)} priorWeightMatches=${trainWinner.priorWeight}`
    + ` validation_weightedRMSE=${trainWinner.validation.weightedRmse.toFixed(5)}`
    + ` validation_unweightedRMSE=${trainWinner.validation.unweightedRmse.toFixed(5)}`,
  );
}

function printProductionCapSweep(
  train: readonly Case[],
  validation: readonly Case[],
  pooled: readonly Case[],
): void {
  console.log("\nPRODUCTION_CAP_SWEEP curve=.95/10 metric=minute_weighted_next10GW_xGI90");
  console.log("capPct\ttrain_n\ttrain_weightedRMSE\tvalidation_n\tvalidation_weightedRMSE\tpooled_n\tpooled_weightedRMSE");
  const results = PRODUCTION_CAPS.map((capPct) => ({
    capPct,
    train: score(train, (item) => cappedProductionRate(item, capPct)),
    validation: score(validation, (item) => cappedProductionRate(item, capPct)),
    pooled: score(pooled, (item) => cappedProductionRate(item, capPct)),
  }));
  for (const result of results) {
    console.log([
      result.capPct,
      result.train.n,
      result.train.weightedRmse.toFixed(5),
      result.validation.n,
      result.validation.weightedRmse.toFixed(5),
      result.pooled.n,
      result.pooled.weightedRmse.toFixed(5),
    ].join("\t"));
  }
  const trainWinner = results.reduce((left, right) =>
    right.train.weightedRmse < left.train.weightedRmse ? right : left,
  );
  console.log(
    `PRODUCTION_CAP_TRAIN_PICK capPct=${trainWinner.capPct}`
    + ` train_weightedRMSE=${trainWinner.train.weightedRmse.toFixed(5)}`
    + ` validation_weightedRMSE=${trainWinner.validation.weightedRmse.toFixed(5)}`,
  );
}

function main(): void {
  const root = path.resolve(
    process.argv[2] ?? process.env.BACKTEST_MULTI_DATA_DIR ?? path.join("/tmp", "fpl-backtest-seasons"),
  );
  const pairCases = PAIRS.map((pair) => {
    const data = loadPair(root, pair.priorSeason, pair.targetSeason);
    return { ...pair, stableMatches: data.stableMatches, cases: collectCases(data) };
  });
  const allCases = pairCases.flatMap((pair) => pair.cases);

  console.log([
    "CONFIG",
    `root=${root}`,
    `priorMinutes>=${PRIOR_MINUTES}`,
    `futureMinutes>=${FUTURE_MINUTES}`,
    `cutoffMeaning=afterGW`,
    `futureWindow=${NEXT_GAMEWEEKS}GWs_after_cutoff`,
    `cutoffs=${CUTOFFS.join(",")}`,
    `formDecay=${FORM_DECAY}`,
    `winsorRatio=${WINSOR_RATIO}`,
    `directStepPct=${DIRECT_STEP}`,
  ].join("\t"));
  for (const pair of pairCases) {
    console.log(
      `PAIR prior=${pair.priorSeason} target=${pair.targetSeason}`
      + ` stableMatches=${pair.stableMatches}`
      + ` cases=${pair.cases.length} eligibleCutoffCases=${CUTOFFS.map((cutoff) =>
        `${cutoff}:${pair.cases.filter((item) => item.cutoff === cutoff).length}`).join(",")}`,
    );
    printDirectTable(pair.targetSeason, pair.cases);
  }
  printDirectTable("pooled", allCases);

  const train = pairCases.find((pair) => pair.targetSeason === "2024-25")!.cases;
  const validation = pairCases.find((pair) => pair.targetSeason === "2025-26")!.cases;
  printGrid(train, validation, allCases);
  printProductionCapSweep(train, validation, allCases);
}

main();
