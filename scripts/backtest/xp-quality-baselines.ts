import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Position } from "@/types/player";
import { deduplicateHistoricalFixtureRows } from "./historicalBacktest";
import { loadSeason } from "./season";
import {
  aggregatePlayerGameweeks,
  errorMetrics,
  recentBaselinePredictions,
  type PlayerFixtureOutcome,
} from "./xp-quality-data";

const SEASONS = ["2024-25", "2025-26"] as const;
const FIRST_GAMEWEEK = 6;
const LAST_GAMEWEEK = 38;
const BOOTSTRAPS = 10_000;
const DATA_ROOT = path.resolve(process.env.BACKTEST_MULTI_DATA_DIR ?? "/tmp/fpl-tier-c-elo-corrected-20261008");
const PREDICTIONS_DIR = path.resolve(process.env.XP_QUALITY_PREDICTIONS_DIR ?? "/tmp/xp-quality-production");
const ROWS_OUTPUT = path.resolve(process.env.XP_QUALITY_ROWS_OUTPUT ?? "output/xp-quality/rows.json");
const SUMMARY_JSON = path.resolve(process.env.XP_QUALITY_SUMMARY_JSON ?? "scripts/backtest/results/xp-quality-baselines.json");
const SUMMARY_MD = path.resolve(process.env.XP_QUALITY_SUMMARY_MD ?? "scripts/backtest/results/xp-quality-baselines.md");

interface ProductionPredictionRow {
  playerId: number;
  gameweek: number;
  position: Position;
  actual: number;
  prediction: number;
  expectedMinutes: number;
  actualMinutes: number;
  fixtureCount: number;
}

interface PredictionFile {
  season: string;
  arm: string;
  fdrDivisor: number;
  ratingSource: string;
  ratingHistorySha256?: string;
  productionHashes: Record<string, string>;
  inputHashes: Record<string, string>;
  coverage: Record<string, number>;
  rows: ProductionPredictionRow[];
}

export interface QualityRow extends ProductionPredictionRow {
  season: string;
  expectedMinutesTotal: number;
  rollingPrediction?: number;
  minutesPrediction?: number;
  priorRecordedGameweeks: number;
  priorFixtureCount: number;
  priorActualMinutes: number;
  previousPrediction?: number;
}

type PredictionKey = "prediction" | "rollingPrediction" | "minutesPrediction" | "previousPrediction";

interface Metrics {
  n: number;
  rmse: number;
  mae: number;
  meanBias: number;
}

interface PairedInterval {
  n: number;
  clusters: number;
  deltaRmse: number;
  ci95: [number, number];
}

interface Coverage {
  productionRows: number;
  zeroMinuteOutcomes: number;
  doubleGameweekRows: number;
  rollingAvailable: number;
  minutesAvailable: number;
  commonBaselineRows: number;
  excludedFromCommonCohort: number;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function predictionValue(row: QualityRow, key: PredictionKey): number | undefined {
  return row[key];
}

function metrics(rows: readonly QualityRow[], key: PredictionKey): Metrics {
  assert.ok(rows.length > 0, `${key} metrics need at least one row.`);
  const predictions = rows.map((row) => {
    const value = predictionValue(row, key);
    assert.ok(value !== undefined && Number.isFinite(value), `${key} is missing or non-finite for ${row.season} GW${row.gameweek} player ${row.playerId}.`);
    return value;
  });
  return errorMetrics(predictions, rows.map((row) => row.actual));
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position);
  const fraction = position - low;
  return sorted[low] * (1 - fraction) + sorted[Math.min(low + 1, sorted.length - 1)] * fraction;
}

function pairedRmseInterval(
  rows: readonly QualityRow[],
  baseline: Exclude<PredictionKey, "prediction">,
  seed: number,
): PairedInterval {
  const clusterMap = new Map<string, QualityRow[]>();
  for (const row of rows) {
    const key = `${row.season}:${row.gameweek}`;
    (clusterMap.get(key) ?? clusterMap.set(key, []).get(key)!).push(row);
  }
  const clustersBySeason = new Map<string, Array<{ modelSse: number; baselineSse: number; n: number }>>();
  for (const season of [...new Set(rows.map((row) => row.season))].sort()) {
    const clusters = [...clusterMap.entries()]
      .filter(([key]) => key.startsWith(`${season}:`))
      .map(([, cluster]) => ({
        modelSse: cluster.reduce((sum, row) => sum + (row.prediction - row.actual) ** 2, 0),
        baselineSse: cluster.reduce((sum, row) => sum + (row[baseline]! - row.actual) ** 2, 0),
        n: cluster.length,
      }));
    assert.ok(clusters.length > 0, `${season} needs at least one Gameweek cluster.`);
    clustersBySeason.set(season, clusters);
  }
  const modelSse = rows.reduce((sum, row) => sum + (row.prediction - row.actual) ** 2, 0);
  const baselineSse = rows.reduce((sum, row) => sum + (row[baseline]! - row.actual) ** 2, 0);
  const observed = Math.sqrt(modelSse / rows.length) - Math.sqrt(baselineSse / rows.length);
  const random = seededRandom(seed);
  const deltas = new Array<number>(BOOTSTRAPS);
  for (let draw = 0; draw < BOOTSTRAPS; draw += 1) {
    let drawModelSse = 0;
    let drawBaselineSse = 0;
    let drawN = 0;
    for (const clusters of clustersBySeason.values()) {
      for (let i = 0; i < clusters.length; i += 1) {
        const cluster = clusters[Math.floor(random() * clusters.length)];
        drawModelSse += cluster.modelSse;
        drawBaselineSse += cluster.baselineSse;
        drawN += cluster.n;
      }
    }
    deltas[draw] = Math.sqrt(drawModelSse / drawN) - Math.sqrt(drawBaselineSse / drawN);
  }
  deltas.sort((a, b) => a - b);
  return {
    n: rows.length,
    clusters: [...clustersBySeason.values()].reduce((sum, seasonClusters) => sum + seasonClusters.length, 0),
    deltaRmse: observed,
    ci95: [quantile(deltas, 0.025), quantile(deltas, 0.975)],
  };
}

function loadOutcomes(seasonName: string): Map<number, PlayerFixtureOutcome[]> {
  const season = loadSeason(path.join(DATA_ROOT, seasonName));
  const sourceRows = [...season.rowsByPlayer.values()].flat();
  const { rows } = deduplicateHistoricalFixtureRows(sourceRows);
  const byPlayer = new Map<number, PlayerFixtureOutcome[]>();
  for (const row of rows) {
    const outcome = {
      gameweek: row.gameweek,
      fixtureId: row.fixtureId,
      totalPoints: row.totalPoints,
      minutes: row.minutes,
    };
    (byPlayer.get(row.historicalPlayerId) ?? byPlayer.set(row.historicalPlayerId, []).get(row.historicalPlayerId)!).push(outcome);
  }
  return byPlayer;
}

function buildSeasonRows(seasonName: string): { rows: QualityRow[]; sourceRows: number; sourceZeroMinuteRows: number } {
  const predictionPath = path.join(PREDICTIONS_DIR, `combined-candidate-${seasonName}.json`);
  const predictionFile = readJson<PredictionFile>(predictionPath);
  assert.equal(predictionFile.season, seasonName);
  assert.equal(predictionFile.arm, "candidate");
  assert.equal(predictionFile.fdrDivisor, 300, "Expected current 300-point production Elo divisor.");
  assert.equal(predictionFile.ratingSource, "historical-clubelo", "Require actual dated ClubElo ratings.");

  const previousFile = readJson<PredictionFile>(path.join(PREDICTIONS_DIR, `combined-main-${seasonName}.json`));
  assert.equal(previousFile.arm, "main");
  assert.equal(previousFile.ratingSource, predictionFile.ratingSource);
  assert.equal(previousFile.ratingHistorySha256, predictionFile.ratingHistorySha256);
  assert.deepEqual(previousFile.inputHashes, predictionFile.inputHashes);
  assert.equal(previousFile.rows.length, predictionFile.rows.length);
  const previousRows = new Map(previousFile.rows.map(row => [`${row.playerId}:${row.gameweek}`, row]));
  const outcomesByPlayer = loadOutcomes(seasonName);
  const rows: QualityRow[] = [];
  for (const forecast of predictionFile.rows) {
    assert.ok(forecast.gameweek >= FIRST_GAMEWEEK && forecast.gameweek <= LAST_GAMEWEEK,
      `${seasonName}: unexpected scored GW${forecast.gameweek}.`);
    const previous = previousRows.get(`${forecast.playerId}:${forecast.gameweek}`);
    assert.ok(previous, "Previous-model forecast missing.");
    assert.equal(previous.actual, forecast.actual);
    assert.equal(previous.actualMinutes, forecast.actualMinutes);
    assert.equal(previous.fixtureCount, forecast.fixtureCount);
    assert.equal(previous.position, forecast.position);
    const outcomes = outcomesByPlayer.get(forecast.playerId) ?? [];
    const observedGameweeks = aggregatePlayerGameweeks(outcomes);
    const actual = observedGameweeks.find((row) => row.gameweek === forecast.gameweek);
    assert.ok(actual, `${seasonName} GW${forecast.gameweek} player ${forecast.playerId}: source outcome missing.`);
    assert.equal(actual.points, forecast.actual, "The exported production outcome must match deduplicated source points.");
    assert.equal(actual.minutes, forecast.actualMinutes, "The exported production minutes must match deduplicated source minutes.");
    assert.equal(actual.fixtureCount, forecast.fixtureCount, "The exported fixture count must match source fixture rows.");
    const baselines = recentBaselinePredictions(
      outcomes,
      forecast.gameweek,
      forecast.fixtureCount,
      forecast.expectedMinutes,
    );
    rows.push({
      ...forecast,
      previousPrediction: previous.prediction,
      season: seasonName,
      expectedMinutesTotal: forecast.expectedMinutes * forecast.fixtureCount,
      ...baselines,
    });
  }
  assert.equal(rows.length, new Set(rows.map((row) => `${row.playerId}:${row.gameweek}`)).size,
    `${seasonName}: duplicate player-GW forecasts.`);
  return {
    rows: rows.sort((a, b) => a.gameweek - b.gameweek || a.playerId - b.playerId),
    sourceRows: predictionFile.coverage.sourceRows,
    sourceZeroMinuteRows: predictionFile.coverage.sourceZeroMinuteRows,
  };
}

function summarizeCoverage(rows: readonly QualityRow[]): Coverage {
  const rollingAvailable = rows.filter((row) => row.rollingPrediction !== undefined).length;
  const minutesAvailable = rows.filter((row) => row.minutesPrediction !== undefined).length;
  const commonBaselineRows = rows.filter((row) =>
    row.rollingPrediction !== undefined && row.minutesPrediction !== undefined).length;
  return {
    productionRows: rows.length,
    zeroMinuteOutcomes: rows.filter((row) => row.actualMinutes === 0).length,
    doubleGameweekRows: rows.filter((row) => row.fixtureCount > 1).length,
    rollingAvailable,
    minutesAvailable,
    commonBaselineRows,
    excludedFromCommonCohort: rows.length - commonBaselineRows,
  };
}

function analyze(rows: readonly QualityRow[], seed: number) {
  const common = rows.filter((row) => row.rollingPrediction !== undefined && row.minutesPrediction !== undefined);
  return {
    coverage: summarizeCoverage(rows),
    productionAllRows: metrics(rows, "prediction"),
    previousAllRows: metrics(rows, "previousPrediction"),
    previousFullDelta: pairedRmseInterval(rows, "previousPrediction", seed + 2),
    commonCohort: {
      production: metrics(common, "prediction"),
      previous: metrics(common, "previousPrediction"),
      rolling: metrics(common, "rollingPrediction"),
      minutes: metrics(common, "minutesPrediction"),
      pairedRmseDelta: {
        previous: pairedRmseInterval(common, "previousPrediction", seed + 2),
        rolling: pairedRmseInterval(common, "rollingPrediction", seed),
        minutes: pairedRmseInterval(common, "minutesPrediction", seed + 1),
      },
    },
  };
}

function f(value: number): string {
  return value.toFixed(4);
}

function renderMarkdown(summary: {
  method: Record<string, unknown>;
  seasons: Record<string, ReturnType<typeof analyze>>;
  pooled: ReturnType<typeof analyze>;
  caveats: string[];
}): string {
  const lines = [
    "# xP quality: simple baseline comparison",
    "",
    "## Results",
    "",
    "Full-row current-model metrics score every eligible production forecast. Baseline comparisons use the identical intersection where both baselines meet their predeclared history gates; negative ΔRMSE favors the current model.",
    "",
    "| Season | All xP rows | Common rows | Predictor | RMSE | MAE | Mean bias |",
    "|---|---:|---:|---|---:|---:|---:|",
  ];
  for (const season of [...Object.keys(summary.seasons).sort(), "Pooled"]) {
    const result = season === "Pooled" ? summary.pooled : summary.seasons[season];
    for (const [label, metric] of [
      ["Production xP", result.commonCohort.production],
      ["Previous model (74ceff2)", result.commonCohort.previous],
      ["Rolling prior points/fixture", result.commonCohort.rolling],
      ["Prior points/90 × forecast minutes", result.commonCohort.minutes],
    ] as const) {
      lines.push(`| ${season} | ${result.productionAllRows.n.toLocaleString()} | ${result.commonCohort.production.n.toLocaleString()} | ${label} | ${f(metric.rmse)} | ${f(metric.mae)} | ${f(metric.meanBias)} |`);
    }
    for (const [label, interval] of [
      ["previous model", result.commonCohort.pairedRmseDelta.previous],
      ["rolling", result.commonCohort.pairedRmseDelta.rolling],
      ["P90", result.commonCohort.pairedRmseDelta.minutes],
    ] as const) {
      lines.push(`| ${season} |  | ${interval.n.toLocaleString()} | Production − ${label} ΔRMSE [95% GW-cluster CI] | ${f(interval.deltaRmse)} [${f(interval.ci95[0])}, ${f(interval.ci95[1])}] |  |  |`);
    }
  }
  lines.push(
    "",
    "## Full archived cohort",
    "",
    "| Model | Player-GWs | RMSE | MAE |",
    "|---|---:|---:|---:|",
    `| Current production | ${summary.pooled.productionAllRows.n} | ${f(summary.pooled.productionAllRows.rmse)} | ${f(summary.pooled.productionAllRows.mae)} |`,
    `| Previous model | ${summary.pooled.previousAllRows.n} | ${f(summary.pooled.previousAllRows.rmse)} | ${f(summary.pooled.previousAllRows.mae)} |`,
    "",
    "The full archive contains many zero-minute outcomes; its lower error is not representative of established starter choices. Use the common cohort above for comparisons against the recent-form baselines.",
    "",
    "## Method",
    "",
    "The current model is the candidate production `projectPlayer()` path with the 300-point continuous Elo FDR and actual dated ClubElo history. It forecasts one Gameweek, sums every scheduled fixture in a double, and is scored against summed historical FPL points, including explicit zero-minute records.",
    "",
    "Both baselines use only the latest five recorded player-GWs before the target. The rolling baseline divides their summed points by their summed player-fixture rows, then multiplies by the target fixture count; this keeps past double gameweeks from changing the per-fixture rate. The minutes baseline divides summed points by summed actual minutes and multiplies by production expected minutes per fixture and the target fixture count. A recorded zero-minute fixture contributes zero points and minutes; absent player-week rows are not treated as zeros. The rolling baseline requires three prior recorded GWs, and the minutes baseline requires 180 prior actual minutes. The paired comparison uses rows where both baselines exist.",
    "",
    "The 95% intervals resample whole Gameweeks within each season and keep each season's number of Gameweeks fixed. They describe variation across these observed weeks; they do not make these seasons pristine holdouts, since earlier model work used them during tuning.",
    "",
    "## Coverage and limits",
    "",
  );
  for (const season of [...Object.keys(summary.seasons).sort(), "Pooled"]) {
    const result = season === "Pooled" ? summary.pooled : summary.seasons[season];
    lines.push(`- ${season}: ${result.coverage.productionRows.toLocaleString()} production rows, ${result.coverage.zeroMinuteOutcomes.toLocaleString()} explicit zero-minute outcomes, ${result.coverage.doubleGameweekRows.toLocaleString()} player-GW rows with multiple fixtures, and ${result.coverage.commonBaselineRows.toLocaleString()} in the common baseline cohort.`);
  }
  lines.push("", ...summary.caveats.map((caveat) => `- ${caveat}`), "");
  return lines.join("\n");
}

function main(): void {
  const seasonRows = Object.fromEntries(SEASONS.map((season) => [season, buildSeasonRows(season)]));
  const allRows = SEASONS.flatMap((season) => seasonRows[season].rows);
  const commonRows = allRows.filter((row) => row.rollingPrediction !== undefined && row.minutesPrediction !== undefined);
  const summary = {
    source: {
      predictionDirectory: PREDICTIONS_DIR,
      preparedDataDirectory: DATA_ROOT,
      seasons: SEASONS,
      gameweeks: [FIRST_GAMEWEEK, LAST_GAMEWEEK],
      predictionFiles: Object.fromEntries(SEASONS.map((season) => [
        season,
        {
          sha256: sha256(path.join(PREDICTIONS_DIR, `combined-candidate-${season}.json`)),
          ratingHistorySha256: readJson<PredictionFile>(path.join(PREDICTIONS_DIR, `combined-candidate-${season}.json`)).ratingHistorySha256,
          previous: {
            sha256: sha256(path.join(PREDICTIONS_DIR, `combined-main-${season}.json`)),
            productionHashes: readJson<PredictionFile>(path.join(PREDICTIONS_DIR, `combined-main-${season}.json`)).productionHashes,
          },
          productionHashes: readJson<PredictionFile>(path.join(PREDICTIONS_DIR, `combined-candidate-${season}.json`)).productionHashes,
          inputHashes: readJson<PredictionFile>(path.join(PREDICTIONS_DIR, `combined-candidate-${season}.json`)).inputHashes,
        },
      ])),
    },
    method: {
      currentModel: "current production projectPlayer() via candidate arm, 300-point Elo FDR and actual dated ClubElo ratings",
      rollingBaseline: "sum of points / sum of recorded player-fixture rows over latest 5 prior recorded player-GWs, multiplied by target fixture count",
      minutesBaseline: "sum of points / sum of actual minutes over latest 5 prior recorded player-GWs, multiplied by production expected minutes per fixture and target fixture count",
      recentWindowGameweeks: 5,
      minimumPriorGameweeksForRolling: 3,
      minimumPriorMinutesForMinutesBaseline: 180,
      zeroMinuteOutcome: "explicit recorded fixture row, zero minutes retained; absent rows are not imputed",
      doubleGameweeks: "points and minutes sum across the player fixtures; forecast expected minutes are multiplied by target fixture count",
      interval: "10,000 paired gameweek-cluster bootstrap draws, stratified by season; delta is production RMSE minus baseline RMSE",
      commonCohortRows: commonRows.length,
      bootstrapSeed: 20261008,
    },
    coverage: {
      seasons: Object.fromEntries(SEASONS.map((season) => [season, summarizeCoverage(seasonRows[season].rows)])),
      pooled: summarizeCoverage(allRows),
      commonBaselineRowsBySeason: Object.fromEntries(SEASONS.map((season) => [
        season,
        seasonRows[season].rows.filter((row) => row.rollingPrediction !== undefined && row.minutesPrediction !== undefined).length,
      ])),
    },
    seasons: Object.fromEntries(SEASONS.map((season, index) => [season, analyze(seasonRows[season].rows, 20261008 + index * 10)])),
    pooled: analyze(allRows, 20261008),
    caveats: [
      "Historical availability is reconstructed: every projected player is marked available, with no archived injury status or RotoWire lineup evidence, so forecast minutes are less informed than live production minutes.",
      "Historical market prices are unavailable; every player receives the common £5.0m price prior.",
      "The corpus does not contain a complete event-time FPL roster. Rows with no recorded player-fixture outcome are not scored or imputed, and incomplete target fixture rows are excluded by the production backtest harness.",
      "The 2024/25 and 2025/26 seasons were used in earlier model tuning, so results are historical validation rather than a new untouched holdout.",
      "The previous model is 74ceff2 rerun using the same actual ClubElo ratings and prepared inputs. Its old clean-sheet helper accepts a club snapshot rather than a ratings map; the temporary runner adapts only that input signature, leaving its production code intact.",
    ],
  };

  const commonRowsFile = {
    metadata: {
      ...summary.method,
      seasons: SEASONS,
      gameweeks: [FIRST_GAMEWEEK, LAST_GAMEWEEK],
      coverage: summary.coverage,
      caveats: summary.caveats,
      predictionSources: summary.source.predictionFiles,
    },
    rows: allRows,
  };
  mkdirSync(path.dirname(ROWS_OUTPUT), { recursive: true });
  mkdirSync(path.dirname(SUMMARY_JSON), { recursive: true });
  mkdirSync(path.dirname(SUMMARY_MD), { recursive: true });
  writeFileSync(ROWS_OUTPUT, `${JSON.stringify(commonRowsFile)}\n`);
  writeFileSync(SUMMARY_JSON, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(SUMMARY_MD, renderMarkdown(summary));
  console.log(`Wrote ${ROWS_OUTPUT} with ${allRows.length} scored rows (${commonRows.length} common-cohort rows).`);
  console.log(`Wrote ${SUMMARY_JSON} and ${SUMMARY_MD}.`);
  console.log(JSON.stringify({ pooled: summary.pooled, coverage: summary.coverage.pooled }));
}

main();
