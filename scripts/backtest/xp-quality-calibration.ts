import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;
export const BOOTSTRAP_REPLICATES = 2_000;
export const MIN_BAND_ROWS = 30;
export const MIN_BAND_GAMEWEEKS = 10;

const INPUT_DEFAULT = "output/xp-quality/rows.json";
const OUTPUT_DIR = "scripts/backtest/results";
const BOOTSTRAP_SEED = 20261008;
const BIN_COUNT = 11;
const MIN_VALID_BOOTSTRAP_FRACTION = 0.9;

export interface QualityRow {
  season: string;
  gameweek: number;
  playerId: number | string;
  position: (typeof POSITIONS)[number];
  prediction: number;
  actual: number;
  expectedMinutes: number;
  actualMinutes: number;
  rollingPrediction?: number;
  minutesPrediction?: number;
}

export interface RowsFile {
  rows: QualityRow[];
  metadata?: Record<string, unknown>;
}

interface BinSummary {
  label: string;
  lower: number;
  upper: number | null;
  n: number;
  gameweekClusters: number;
  meanPredicted: number | null;
  meanActual: number | null;
  bias: number | null;
  biasCI95: [number, number] | null;
  bootstrapValidReplicates: number;
  sparse: boolean;
  sparseReason: string | null;
}

interface Summary {
  n: number;
  gameweekClusters: number;
  meanPredicted: number | null;
  meanActual: number | null;
  bias: number | null;
  biasCI95: [number, number] | null;
  bootstrapValidReplicates: number;
  weightedCalibrationGap: number | null;
  sparse: boolean;
  bins: BinSummary[];
}

interface CalibrationAnalysis {
  pooled: Summary;
  bySeason: Record<string, Summary>;
  byPosition: Record<(typeof POSITIONS)[number], Summary>;
  plausibleStarters: Summary;
}

interface CalibrationReport {
  metadata: {
  input: string;
  inputSha256: string;
  sourceRowCount: number;
  rowCount: number;
  excludedFromCommonCohort: number;
    seasons: string[];
    sourceMetadata: Record<string, unknown>;
    method: Record<string, unknown>;
  };
  analysis: CalibrationAnalysis;
}

interface Aggregate {
  count: number;
  prediction: number;
  actual: number;
  error: number;
}

interface ClusterAggregate {
  overall: Aggregate;
  bins: Aggregate[];
}

const emptyAggregate = (): Aggregate => ({ count: 0, prediction: 0, actual: 0, error: 0 });
const mean = (sum: number, count: number): number | null => count ? sum / count : null;

export function binIndex(prediction: number): number {
  if (!Number.isFinite(prediction) || prediction < 0) {
    throw new Error(`Prediction must be finite and >= 0; received ${prediction}`);
  }
  return Math.min(Math.floor(prediction), BIN_COUNT - 1);
}

function binLabel(index: number): string {
  return index === BIN_COUNT - 1 ? "10+" : `${index}–<${index + 1}`;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function percentile(values: number[], probability: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower]! + (sorted[Math.min(lower + 1, sorted.length - 1)]! - sorted[lower]!) * fraction;
}

function buildClusters(cohortRows: readonly QualityRow[], rows: readonly QualityRow[]): ClusterAggregate[][] {
  const clustersBySeason = new Map<string, Map<number, ClusterAggregate>>();
  for (const row of cohortRows) {
    const byGameweek = clustersBySeason.get(row.season) ?? new Map<number, ClusterAggregate>();
    clustersBySeason.set(row.season, byGameweek);
    if (!byGameweek.has(row.gameweek)) {
      byGameweek.set(row.gameweek, { overall: emptyAggregate(), bins: Array.from({ length: BIN_COUNT }, emptyAggregate) });
    }
  }
  for (const row of rows) {
    const cluster = clustersBySeason.get(row.season)?.get(row.gameweek);
    if (!cluster) throw new Error(`Bootstrap cohort is missing ${row.season} GW${row.gameweek}`);
    const error = row.prediction - row.actual;
    const bin = cluster.bins[binIndex(row.prediction)]!;
    for (const aggregate of [cluster.overall, bin]) {
      aggregate.count += 1;
      aggregate.prediction += row.prediction;
      aggregate.actual += row.actual;
      aggregate.error += error;
    }
  }
  return [...clustersBySeason.values()].map((byGameweek) => [...byGameweek.values()]);
}

function bootstrapCI(
  strata: readonly ClusterAggregate[][],
  seed: number,
  select: (cluster: ClusterAggregate) => Aggregate,
): { ci: [number, number] | null; validReplicates: number } {
  if (strata.length === 0 || strata.some((clusters) => clusters.length < MIN_BAND_GAMEWEEKS)) {
    return { ci: null, validReplicates: 0 };
  }
  const random = randomGenerator(seed);
  const draws: number[] = [];
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate += 1) {
    let error = 0;
    let count = 0;
    for (const clusters of strata) {
      for (let draw = 0; draw < clusters.length; draw += 1) {
        const aggregate = select(clusters[Math.floor(random() * clusters.length)]!);
        error += aggregate.error;
        count += aggregate.count;
      }
    }
    if (count > 0) draws.push(error / count);
  }
  const enoughValid = draws.length >= BOOTSTRAP_REPLICATES * MIN_VALID_BOOTSTRAP_FRACTION;
  return {
    ci: enoughValid ? [percentile(draws, 0.025), percentile(draws, 0.975)] : null,
    validReplicates: draws.length,
  };
}

function summarize(label: string, rows: readonly QualityRow[], cohortRows: readonly QualityRow[]): Summary {
  const bins: BinSummary[] = [];
  let totalPrediction = 0;
  let totalActual = 0;
  let totalError = 0;
  let totalCount = 0;
  const clusterIds = new Set(rows.map((row) => `${row.season}:${row.gameweek}`));
  const strata = buildClusters(cohortRows, rows);

  for (let index = 0; index < BIN_COUNT; index += 1) {
    const members = rows.filter((row) => binIndex(row.prediction) === index);
    const n = members.length;
    const prediction = members.reduce((sum, row) => sum + row.prediction, 0);
    const actual = members.reduce((sum, row) => sum + row.actual, 0);
    const error = prediction - actual;
    const memberClusters = new Set(members.map((row) => `${row.season}:${row.gameweek}`));
    const sparse = n < MIN_BAND_ROWS || memberClusters.size < MIN_BAND_GAMEWEEKS;
    const sparseReason = n < MIN_BAND_ROWS
      ? `fewer than ${MIN_BAND_ROWS} rows`
      : memberClusters.size < MIN_BAND_GAMEWEEKS
        ? `fewer than ${MIN_BAND_GAMEWEEKS} gameweek clusters`
        : null;
    const bootstrap = sparse
      ? { ci: null, validReplicates: 0 }
      : bootstrapCI(strata, BOOTSTRAP_SEED ^ fnv1a(`${label}:${index}`), (cluster) => cluster.bins[index]!);
    const sparseAfterBootstrap = sparse || bootstrap.ci === null;
    bins.push({
      label: binLabel(index),
      lower: index,
      upper: index === BIN_COUNT - 1 ? null : index + 1,
      n,
      gameweekClusters: memberClusters.size,
      meanPredicted: mean(prediction, n),
      meanActual: mean(actual, n),
      bias: mean(error, n),
      biasCI95: bootstrap.ci,
      bootstrapValidReplicates: bootstrap.validReplicates,
      sparse: sparseAfterBootstrap,
      sparseReason: sparseReason ?? (bootstrap.ci === null ? "too few valid nonempty bootstrap replicates" : null),
    });
    totalPrediction += prediction;
    totalActual += actual;
    totalError += error;
    totalCount += n;
  }

  const weightedCalibrationGap = totalCount === 0 ? null : bins.reduce((sum, bin) =>
    sum + (bin.n / totalCount) * Math.abs(bin.bias ?? 0), 0);
  const overallBootstrap = totalCount >= MIN_BAND_ROWS
    ? bootstrapCI(strata, BOOTSTRAP_SEED ^ fnv1a(`${label}:overall`), (cluster) => cluster.overall)
    : { ci: null, validReplicates: 0 };
  return {
    n: totalCount,
    gameweekClusters: clusterIds.size,
    meanPredicted: mean(totalPrediction, totalCount),
    meanActual: mean(totalActual, totalCount),
    bias: mean(totalError, totalCount),
    biasCI95: overallBootstrap.ci,
    bootstrapValidReplicates: overallBootstrap.validReplicates,
    weightedCalibrationGap,
    sparse: totalCount < MIN_BAND_ROWS,
    bins,
  };
}

export function analyzeCalibration(rows: readonly QualityRow[]): CalibrationAnalysis {
  const pooled = summarize("pooled", rows, rows);
  const seasons = [...new Set(rows.map((row) => row.season))].sort();
  return {
    pooled,
    bySeason: Object.fromEntries(seasons.map((season) => [
      season,
      summarize(`season:${season}`, rows.filter((row) => row.season === season), rows.filter((row) => row.season === season)),
    ])) as Record<string, Summary>,
    byPosition: Object.fromEntries(POSITIONS.map((position) => [
      position,
      summarize(`position:${position}`, rows.filter((row) => row.position === position), rows),
    ])) as Record<(typeof POSITIONS)[number], Summary>,
    plausibleStarters: summarize("plausible-starters", rows.filter((row) => row.expectedMinutes >= 60), rows),
  };
}

export function commonRows(rows: readonly QualityRow[]): QualityRow[] {
  return rows.filter((row) => Number.isFinite(row.rollingPrediction) && Number.isFinite(row.minutesPrediction));
}

export function validateRows(rows: readonly QualityRow[]): void {
  if (rows.length === 0) throw new Error("Input contains no rows");
  const keys = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (!row.season || !Number.isInteger(row.gameweek) || row.gameweek < 1 || row.gameweek > 38) {
      throw new Error(`Row ${index + 1} has an invalid season or gameweek`);
    }
    if (!POSITIONS.includes(row.position)) throw new Error(`Row ${index + 1} has an invalid position`);
    if (row.playerId === undefined || row.playerId === null) throw new Error(`Row ${index + 1} has no playerId`);
    if (!Number.isFinite(row.prediction) || row.prediction < 0 || !Number.isFinite(row.actual)) {
      throw new Error(`Row ${index + 1} has an invalid prediction or actual`);
    }
    if (!Number.isFinite(row.expectedMinutes) || row.expectedMinutes < 0 || row.expectedMinutes > 90) {
      throw new Error(`Row ${index + 1} has invalid expectedMinutes`);
    }
    if (!Number.isFinite(row.actualMinutes) || row.actualMinutes < 0) {
      throw new Error(`Row ${index + 1} has invalid actualMinutes`);
    }
    const key = `${row.season}:${row.gameweek}:${row.playerId}`;
    if (keys.has(key)) throw new Error(`Duplicate player-gameweek row: ${key}`);
    keys.add(key);
  }
}

function renderMarkdown(result: CalibrationReport): string {
  const format = (value: number | null) => value === null ? "—" : value.toFixed(3);
  const show = (label: string, summary: Summary) => {
    const ci = summary.biasCI95 ? ` [${format(summary.biasCI95[0])}, ${format(summary.biasCI95[1])}]` : " (CI unavailable)";
    return `| ${label} | ${summary.n.toLocaleString("en-US")} | ${format(summary.meanPredicted)} | ${format(summary.meanActual)} | ${format(summary.bias)}${ci} | ${format(summary.weightedCalibrationGap)} |`;
  };
  const sections = [
    "# xP calibration quality",
    "",
    `Input: \`${result.metadata.input}\` (${result.metadata.rowCount.toLocaleString("en-US")} common-cohort player-gameweeks from ${result.metadata.sourceRowCount.toLocaleString("en-US")} source rows; SHA-256 \`${result.metadata.inputSha256}\`).`,
    "",
    "Bias is mean predicted xP minus mean actual points, so positive values mean overprediction. The weighted calibration gap is the row-share-weighted absolute bias across fixed integer xP bins. Intervals use a deterministic, season-stratified gameweek-cluster bootstrap with 2,000 replicates, resampling every gameweek in each cohort including weeks with no rows in a given bin; empty replicates are omitted.",
    "",
    "## Overall and slices",
    "",
    "| Slice | Rows | Mean xP | Mean actual | Signed bias (95% CI) | Weighted calibration gap |",
    "|---|---:|---:|---:|---:|---:|",
    show("All rows", result.analysis.pooled),
    ...Object.entries(result.analysis.bySeason).map(([season, summary]) => show(season, summary)),
    ...Object.entries(result.analysis.byPosition).map(([position, summary]) => show(position, summary)),
    show("Plausible starters (expectedMinutes ≥60)", result.analysis.plausibleStarters),
    "",
    "## Pooled calibration bins",
    "",
    "| Predicted xP | Rows | GWs | Mean xP | Mean actual | Bias (95% CI) | Band status |",
    "|---|---:|---:|---:|---:|---:|---|",
    ...result.analysis.pooled.bins.map((bin: BinSummary) => {
      const ci = bin.biasCI95 ? `[${format(bin.biasCI95[0])}, ${format(bin.biasCI95[1])}]` : "—";
      return `| ${bin.label} | ${bin.n.toLocaleString("en-US")} | ${bin.gameweekClusters} | ${format(bin.meanPredicted)} | ${format(bin.meanActual)} | ${format(bin.bias)} ${ci} | ${bin.sparse ? `sparse: ${bin.sparseReason}` : "ok"} |`;
    }),
    "",
    `Sparse bands are defined before analysis as fewer than ${MIN_BAND_ROWS} rows or ${MIN_BAND_GAMEWEEKS} distinct season-gameweek clusters; their interval is withheld. Intervals are also withheld if fewer than ${MIN_VALID_BOOTSTRAP_FRACTION * 100}% of resamples contain at least one row in the band. The plausible-starter slice uses forecast expectedMinutes ≥60 and does not filter on actual minutes.`,
    "",
    "## Scope and limits",
    "",
    "These are reconstructed historical predictions under a fixed £5.0m price prior, with archived injury, lineup, and complete roster inputs unavailable. The evaluated seasons have been used in earlier model work, so these results describe calibration on the available reconstruction and are not a pristine future holdout. They do not establish whether the model beats the rolling-points or minutes-only baselines; that is reported separately.",
    "",
    `Reproduce with: \`node --import tsx scripts/backtest/xp-quality-calibration.ts ${result.metadata.input}\``,
    "",
  ];
  return `${sections.join("\n")}\n`;
}

function main(): void {
  const input = path.resolve(process.argv[2] ?? INPUT_DEFAULT);
  const raw = readFileSync(input, "utf8");
  const parsed = JSON.parse(raw) as RowsFile;
  if (!Array.isArray(parsed.rows)) throw new Error("Input must contain a rows array");
  validateRows(parsed.rows);
  const rows = commonRows(parsed.rows);
  if (rows.length === 0) throw new Error("No rows have finite production, rolling-points, and minutes-only predictions");
  const analysis = analyzeCalibration(rows);
  const result = {
    metadata: {
      input: path.relative(process.cwd(), input),
      inputSha256: createHash("sha256").update(raw).digest("hex"),
      sourceRowCount: parsed.rows.length,
      rowCount: rows.length,
      excludedFromCommonCohort: parsed.rows.length - rows.length,
      seasons: [...new Set(rows.map((row) => row.season))].sort(),
      sourceMetadata: parsed.metadata ?? {},
      method: {
        bias: "mean(prediction - actual)",
        bins: ["0–<1", "1–<2", "2–<3", "3–<4", "4–<5", "5–<6", "6–<7", "7–<8", "8–<9", "9–<10", "10+"],
        starterThreshold: "expectedMinutes >= 60",
        bootstrap: "2,000-replicate season-stratified gameweek-cluster bootstrap over every cohort gameweek including zero-count band clusters; empty replicates omitted; deterministic seed per slice and bin",
        sparseBand: { fewerThanRows: MIN_BAND_ROWS, orFewerThanGameweekClusters: MIN_BAND_GAMEWEEKS },
        weightedCalibrationGap: "sum(bin row share * abs(bin mean prediction - bin mean actual))",
      },
    },
    analysis,
  };
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(path.join(OUTPUT_DIR, "xp-quality-calibration.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(path.join(OUTPUT_DIR, "xp-quality-calibration.md"), renderMarkdown(result));
  console.log(`Wrote ${OUTPUT_DIR}/xp-quality-calibration.md and .json for ${rows.length} common-cohort rows (${parsed.rows.length - rows.length} excluded).`);
}

if (process.argv[1]?.endsWith("xp-quality-calibration.ts")) main();
