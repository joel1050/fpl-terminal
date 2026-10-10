/**
 * Evaluate how well current production one-gameweek xP ranks player returns.
 *
 * All arms are scored on the same player-gameweek rows with all three
 * predictions present. Gameweeks receive equal weight; player rows are not
 * treated as independent bootstrap samples.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface XpQualityRow {
  season: string;
  gameweek: number;
  playerId: number | string;
  position: string;
  prediction: number;
  actual: number;
  /** Production expected minutes for one fixture in this gameweek. */
  expectedMinutes: number;
  /** Expected minutes summed across scheduled fixtures, for P90 baseline audit. */
  expectedMinutesTotal?: number;
  rollingPrediction?: number;
  minutesPrediction?: number;
  fixtureCount?: number;
  [key: string]: unknown;
}

export interface XpQualityInput {
  rows: XpQualityRow[];
  metadata?: Record<string, unknown>;
}

export type ArmName = "production" | "rolling" | "minutes";
export type ScopeName = "allPlayers" | "plausibleStarters" | "outfieldStarters";

export const ARM_LABELS: Record<ArmName, string> = {
  production: "Current production xP",
  rolling: "Prior points per fixture",
  minutes: "Prior points per 90 × expected minutes",
};

const ARM_BASELINE_PAIRS: readonly ["rolling" | "minutes", string][] = [
  ["rolling", "productionMinusRolling"],
  ["minutes", "productionMinusMinutes"],
];

const DEFAULT_BOOTSTRAPS = 10_000;
const DEFAULT_SEED = 0x5eed2026;
const REPORT_JSON = "scripts/backtest/results/xp-quality-ranking.json";
const REPORT_MD = "scripts/backtest/results/xp-quality-ranking.md";

interface ClusterRow {
  key: string;
  season: string;
  gameweek: number;
  rows: XpQualityRow[];
}

interface ScopeSummary {
  rowCount: number;
  gameweekCount: number;
  spearman: Record<ArmName, { mean: number | null; definedGameweeks: number; skippedUndefinedVariance: number }>;
  spearmanDeltas: Record<string, PairMetric>;
  topKReturns?: Record<string, Record<ArmName, MeanSummary> & { deltas: Record<string, PairMetric> }>;
}

interface MeanSummary {
  mean: number | null;
  gameweeks: number;
  skippedInsufficientCandidates?: number;
}

interface PairMetric {
  meanDelta: number | null;
  ci95: [number, number] | null;
  matchedGameweeks: number;
  bootstrapDraws: number;
}

interface EvaluationOptions {
  bootstrapDraws?: number;
  seed?: number;
}

interface ScopeEvaluation {
  name: ScopeName;
  bySeason: Record<string, ScopeSummary>;
  pooled: ScopeSummary;
  gameweeks: Array<{
    season: string;
    gameweek: number;
    rows: number;
    spearman: Record<ArmName, number | null>;
    topKReturns?: Record<string, Record<ArmName, number | null>>;
  }>;
}

export interface XpQualityEvaluation {
  methodology: {
    inputUniverse: string;
    ranking: string;
    starterRule: string;
    captainCandidateRule: string;
    weighting: string;
    confidenceIntervals: string;
    baselineDefinitions: string;
    tieBreak: string;
    limitations: string[];
    bootstrapDraws: number;
    seed: number;
  };
  coverage: {
    sourceRows: number;
    rowsWithCurrentPrediction: number;
    pairedRows: number;
    missingEitherBaselineRows: number;
    seasons: string[];
    pairedGameweeks: number;
    rowsBySeason: Record<string, { sourceRows: number; pairedRows: number; gameweeks: number }>;
  };
  scopes: Record<ScopeName, ScopeEvaluation>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isArmRow(row: XpQualityRow, arm: ArmName): boolean {
  if (arm === "production") return isFiniteNumber(row.prediction);
  return isFiniteNumber(arm === "rolling" ? row.rollingPrediction : row.minutesPrediction);
}

function predictionOf(row: XpQualityRow, arm: ArmName): number {
  if (arm === "production") return row.prediction;
  const value = arm === "rolling" ? row.rollingPrediction : row.minutesPrediction;
  if (!isFiniteNumber(value)) throw new Error(`Missing ${arm} prediction on a paired row`);
  return value;
}

/** Ascending average ranks, with tied values assigned their mean rank. */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
    const averageRank = (start + end) / 2 + 1;
    for (let index = start; index <= end; index += 1) ranks[order[index].index] = averageRank;
    start = end + 1;
  }
  return ranks;
}

/** Spearman rho, or null when rank variance makes it undefined. */
export function spearman(prediction: readonly number[], actual: readonly number[]): number | null {
  if (prediction.length !== actual.length || prediction.length < 2) return null;
  const x = averageRanks(prediction);
  const y = averageRanks(actual);
  const xMean = x.reduce((sum, value) => sum + value, 0) / x.length;
  const yMean = y.reduce((sum, value) => sum + value, 0) / y.length;
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;
  for (let index = 0; index < x.length; index += 1) {
    const dx = x[index] - xMean;
    const dy = y[index] - yMean;
    covariance += dx * dy;
    xVariance += dx * dx;
    yVariance += dy * dy;
  }
  if (xVariance === 0 || yVariance === 0) return null;
  return covariance / Math.sqrt(xVariance * yVariance);
}

function comparePlayerId(a: XpQualityRow, b: XpQualityRow): number {
  if (typeof a.playerId === "number" && typeof b.playerId === "number") return a.playerId - b.playerId;
  return String(a.playerId).localeCompare(String(b.playerId), "en", { numeric: true });
}

/** Deterministic ranking for top-k returns; equal xP is ordered by player ID. */
export function topPredicted(rows: readonly XpQualityRow[], arm: ArmName, count: number): XpQualityRow[] {
  return [...rows]
    .sort((a, b) => predictionOf(b, arm) - predictionOf(a, arm) || comparePlayerId(a, b))
    .slice(0, count);
}

function finitePairedRows(rows: readonly XpQualityRow[]): XpQualityRow[] {
  return rows.filter((row) =>
    isFiniteNumber(row.prediction) && isFiniteNumber(row.actual) &&
    isFiniteNumber(row.rollingPrediction) && isFiniteNumber(row.minutesPrediction) &&
    isFiniteNumber(row.expectedMinutes),
  );
}

function validateAndNormalizeRows(rows: readonly XpQualityRow[]): XpQualityRow[] {
  const seen = new Set<string>();
  return rows.map((row, index) => {
    if (!row || typeof row !== "object") throw new Error(`Input row ${index} is not an object`);
    if (!row.season || !Number.isInteger(row.gameweek) || row.gameweek < 1 || row.gameweek > 38) {
      throw new Error(`Input row ${index} has an invalid season or gameweek`);
    }
    if (row.playerId === undefined || row.playerId === null) throw new Error(`Input row ${index} has no playerId`);
    if (!("GK DEF MID FWD".split(" ").includes(row.position.toUpperCase()))) {
      throw new Error(`Input row ${index} has an invalid position`);
    }
    if (!isFiniteNumber(row.prediction) || !isFiniteNumber(row.actual)) {
      throw new Error(`Input row ${index} has a non-finite production prediction or actual points`);
    }
    const key = `${row.season}:${row.gameweek}:${String(row.playerId)}`;
    if (seen.has(key)) throw new Error(`Duplicate player-gameweek row: ${key}`);
    seen.add(key);
    return row;
  });
}

function clusterRows(rows: readonly XpQualityRow[]): ClusterRow[] {
  const byKey = new Map<string, ClusterRow>();
  for (const row of rows) {
    const key = `${row.season}:${row.gameweek}`;
    let cluster = byKey.get(key);
    if (!cluster) {
      cluster = { key, season: row.season, gameweek: row.gameweek, rows: [] };
      byKey.set(key, cluster);
    }
    cluster.rows.push(row);
  }
  return [...byKey.values()].sort((a, b) => a.season.localeCompare(b.season) || a.gameweek - b.gameweek);
}

function scopedRows(rows: readonly XpQualityRow[], scope: ScopeName): XpQualityRow[] {
  if (scope === "allPlayers") return [...rows];
  const plausible = rows.filter((row) => row.expectedMinutes >= 60);
  if (scope === "plausibleStarters") return plausible;
  return plausible.filter((row) => row.position.toUpperCase() !== "GK");
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function summarizeRhos(clusters: readonly ClusterRow[], arm: ArmName): MeanSummary & { skippedUndefinedVariance: number } {
  const values = clusters.map((cluster) => spearman(
    cluster.rows.map((row) => predictionOf(row, arm)),
    cluster.rows.map((row) => row.actual),
  ));
  const defined = values.filter((value): value is number => value !== null);
  return { mean: mean(defined), gameweeks: defined.length, skippedUndefinedVariance: values.length - defined.length };
}

function returnsByCluster(clusters: readonly ClusterRow[], arm: ArmName, k: number): Map<string, number | null> {
  return new Map(clusters.map((cluster) => {
    if (cluster.rows.length < k) return [cluster.key, null];
    const chosen = topPredicted(cluster.rows, arm, k);
    return [cluster.key, chosen.reduce((sum, row) => sum + row.actual, 0) / chosen.length];
  }));
}

function meanFromMap(clusters: readonly ClusterRow[], values: ReadonlyMap<string, number | null>): MeanSummary {
  const selected = clusters.map((cluster) => values.get(cluster.key) ?? null);
  const usable = selected.filter((value): value is number => value !== null);
  return {
    mean: mean(usable),
    gameweeks: usable.length,
    skippedInsufficientCandidates: selected.length - usable.length,
  };
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function pairedClusterDelta(
  clusters: readonly ClusterRow[],
  left: ReadonlyMap<string, number | null>,
  right: ReadonlyMap<string, number | null>,
  draws: number,
  seed: number,
): PairMetric {
  const strata = new Map<string, ClusterRow[]>();
  for (const cluster of clusters) {
    if (left.get(cluster.key) === null || right.get(cluster.key) === null ||
      left.get(cluster.key) === undefined || right.get(cluster.key) === undefined) continue;
    const seasonRows = strata.get(cluster.season) ?? [];
    seasonRows.push(cluster);
    strata.set(cluster.season, seasonRows);
  }
  const matched = [...strata.values()].flat();
  if (!matched.length) return { meanDelta: null, ci95: null, matchedGameweeks: 0, bootstrapDraws: draws };
  const deltas = new Map(matched.map((cluster) => [
    cluster.key,
    (left.get(cluster.key) as number) - (right.get(cluster.key) as number),
  ]));
  const point = matched.reduce((sum, cluster) => sum + deltas.get(cluster.key)!, 0) / matched.length;
  const random = xorshift32(seed);
  const samples: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    let total = 0;
    let n = 0;
    for (const seasonClusters of strata.values()) {
      for (let index = 0; index < seasonClusters.length; index += 1) {
        const sampled = seasonClusters[Math.floor(random() * seasonClusters.length)];
        total += deltas.get(sampled.key)!;
        n += 1;
      }
    }
    samples.push(total / n);
  }
  samples.sort((a, b) => a - b);
  return {
    meanDelta: point,
    ci95: [percentile(samples, 0.025), percentile(samples, 0.975)],
    matchedGameweeks: matched.length,
    bootstrapDraws: draws,
  };
}

function rhosByCluster(clusters: readonly ClusterRow[], arm: ArmName): Map<string, number | null> {
  return new Map(clusters.map((cluster) => [cluster.key, spearman(
    cluster.rows.map((row) => predictionOf(row, arm)),
    cluster.rows.map((row) => row.actual),
  )]));
}

function summarizeScope(
  clusters: readonly ClusterRow[],
  scope: ScopeName,
  draws: number,
  seed: number,
): ScopeSummary {
  const rows = clusters.flatMap((cluster) => cluster.rows);
  const spearmanSummary = Object.fromEntries((Object.keys(ARM_LABELS) as ArmName[]).map((arm) => {
    const summary = summarizeRhos(clusters, arm);
    return [arm, {
      mean: summary.mean,
      definedGameweeks: summary.gameweeks,
      skippedUndefinedVariance: summary.skippedUndefinedVariance,
    }];
  })) as ScopeSummary["spearman"];
  const rhoMaps = Object.fromEntries((Object.keys(ARM_LABELS) as ArmName[]).map((arm) => [arm, rhosByCluster(clusters, arm)])) as Record<ArmName, Map<string, number | null>>;
  const spearmanDeltas = Object.fromEntries(ARM_BASELINE_PAIRS.map(([arm, label], index) => [
    label,
    pairedClusterDelta(clusters, rhoMaps.production, rhoMaps[arm], draws, seed + index + 1),
  ]));
  const summary: ScopeSummary = {
    rowCount: rows.length,
    gameweekCount: clusters.length,
    spearman: spearmanSummary,
    spearmanDeltas,
  };
  if (scope === "outfieldStarters") {
    const topKReturns: NonNullable<ScopeSummary["topKReturns"]> = {};
    for (const k of [1, 5, 10]) {
      const key = `top${k}`;
      const armMaps = Object.fromEntries((Object.keys(ARM_LABELS) as ArmName[]).map((arm) => [
        arm,
        returnsByCluster(clusters, arm, k),
      ])) as Record<ArmName, Map<string, number | null>>;
      const arms = Object.fromEntries((Object.keys(ARM_LABELS) as ArmName[]).map((arm) => [
        arm,
        meanFromMap(clusters, armMaps[arm]),
      ])) as Record<ArmName, MeanSummary>;
      const deltas = Object.fromEntries(ARM_BASELINE_PAIRS.map(([arm, label], index) => [
        label,
        pairedClusterDelta(clusters, armMaps.production, armMaps[arm], draws, seed + 100 + k * 7 + index),
      ]));
      topKReturns[key] = Object.assign(arms, { deltas });
    }
    summary.topKReturns = topKReturns;
  }
  return summary;
}

function groupBySeason(clusters: readonly ClusterRow[]): Map<string, ClusterRow[]> {
  const result = new Map<string, ClusterRow[]>();
  for (const cluster of clusters) {
    const list = result.get(cluster.season) ?? [];
    list.push(cluster);
    result.set(cluster.season, list);
  }
  return result;
}

function summarizeScopeBySeason(
  clusters: readonly ClusterRow[],
  scope: ScopeName,
  draws: number,
  seed: number,
): { bySeason: Record<string, ScopeSummary>; pooled: ScopeSummary } {
  const bySeason: Record<string, ScopeSummary> = {};
  for (const [season, seasonClusters] of groupBySeason(clusters)) {
    bySeason[season] = summarizeScope(seasonClusters, scope, draws, seed + Number(season.slice(0, 4)));
  }
  return { bySeason, pooled: summarizeScope(clusters, scope, draws, seed) };
}

export function evaluateXpRanking(input: XpQualityInput, options: EvaluationOptions = {}): XpQualityEvaluation {
  const bootstrapDraws = options.bootstrapDraws ?? DEFAULT_BOOTSTRAPS;
  const seed = options.seed ?? DEFAULT_SEED;
  if (!Number.isInteger(bootstrapDraws) || bootstrapDraws < 100) throw new Error("bootstrapDraws must be an integer >= 100");
  const sourceRows = validateAndNormalizeRows(input.rows);
  const pairedRows = finitePairedRows(sourceRows);
  if (!pairedRows.length) throw new Error("No rows have all three finite predictions and production expected minutes");
  const scopes: Record<ScopeName, ScopeEvaluation> = {} as Record<ScopeName, ScopeEvaluation>;
  const scopeNames: ScopeName[] = ["allPlayers", "plausibleStarters", "outfieldStarters"];
  for (const scope of scopeNames) {
    const clusters = clusterRows(scopedRows(pairedRows, scope));
    const summaries = summarizeScopeBySeason(clusters, scope, bootstrapDraws, seed + scopeNames.indexOf(scope) * 1000);
    scopes[scope] = {
      name: scope,
      bySeason: summaries.bySeason,
      pooled: summaries.pooled,
      gameweeks: clusters.map((cluster) => {
        const spearmanByArm = Object.fromEntries((Object.keys(ARM_LABELS) as ArmName[]).map((arm) => [
          arm,
          spearman(cluster.rows.map((row) => predictionOf(row, arm)), cluster.rows.map((row) => row.actual)),
        ])) as Record<ArmName, number | null>;
        const gameweek: ScopeEvaluation["gameweeks"][number] = {
          season: cluster.season,
          gameweek: cluster.gameweek,
          rows: cluster.rows.length,
          spearman: spearmanByArm,
        };
        if (scope === "outfieldStarters") {
          gameweek.topKReturns = Object.fromEntries([1, 5, 10].map((k) => [
            `top${k}`,
            Object.fromEntries((Object.keys(ARM_LABELS) as ArmName[]).map((arm) => {
              if (cluster.rows.length < k) return [arm, null];
              const chosen = topPredicted(cluster.rows, arm, k);
              return [arm, chosen.reduce((sum, row) => sum + row.actual, 0) / chosen.length];
            })),
          ])) as Record<string, Record<ArmName, number | null>>;
        }
        return gameweek;
      }),
    };
  }
  const rowsBySeason: XpQualityEvaluation["coverage"]["rowsBySeason"] = {};
  for (const row of sourceRows) {
    const counts = rowsBySeason[row.season] ?? { sourceRows: 0, pairedRows: 0, gameweeks: 0 };
    counts.sourceRows += 1;
    rowsBySeason[row.season] = counts;
  }
  for (const row of pairedRows) rowsBySeason[row.season].pairedRows += 1;
  for (const [season, clusters] of groupBySeason(clusterRows(pairedRows))) rowsBySeason[season].gameweeks = clusters.length;
  const currentRows = sourceRows.filter((row) => isArmRow(row, "production") && isFiniteNumber(row.actual));
  const pairedGws = clusterRows(pairedRows);
  return {
    methodology: {
      inputUniverse: "Only matched source player-gameweeks with all three finite predictions are included in model-to-baseline comparisons; current-production coverage and paired coverage are both reported.",
      ranking: "Within each season/gameweek, Spearman rank correlation compares each model's predicted xP with actual FPL points. Tied prediction and outcome ranks use average ranks.",
      starterRule: "A plausible starter has production per-fixture expectedMinutes >= 60, before target-gameweek outcomes are observed.",
      captainCandidateRule: "The captain candidate pool is plausible DEF/MID/FWD starters (all outfield positions; goalkeepers excluded). Top-1, top-5 and top-10 predicted candidates are evaluated by their mean actual points per gameweek; these are ranking diagnostics, not legal squad or captain decisions.",
      weighting: "Pooled metrics give each eligible gameweek equal weight, then average the season/gameweek values. Per-season summaries use the same equal-gameweek weighting.",
      confidenceIntervals: "95% percentile intervals use a paired bootstrap that resamples whole gameweeks within each season and keeps each season's matched gameweek count fixed. Undefined Spearman gameweeks are excluded from both arms of that paired comparison.",
      baselineDefinitions: "Rolling baseline is prior points divided by prior recorded fixture rows over the latest five recorded player-gameweeks, multiplied by the target gameweek's fixture count. The P90 baseline is prior points divided by prior actual minutes over the same five recorded player-gameweeks, multiplied by production expected minutes summed across target fixtures. DNPs count as zero-point fixture outcomes; missing player-gameweeks are not imputed. Baselines require at least three prior recorded gameweeks and 180 prior actual minutes.",
      tieBreak: "When predicted xP ties at a top-k cutoff, lower playerId is selected first so reruns are deterministic.",
      limitations: [
        "The source archive does not provide complete historical event-time player rosters, so missing players are not inferred and these are not full-market captain or transfer replays.",
        "Historical lineups and availability use reconstructed fallback inputs; this tests ranking on the matched archive, not an exact replay of everything known at each deadline.",
        "2024/25 and 2025/26 have informed earlier model development and are reused evaluation seasons, not a fresh untouched holdout.",
        "Top-k returns are descriptive realized outcomes and remain noisy over the 66 evaluated gameweeks; xP targets expected returns, not exact gameweek scores.",
      ],
      bootstrapDraws,
      seed,
    },
    coverage: {
      sourceRows: sourceRows.length,
      rowsWithCurrentPrediction: currentRows.length,
      pairedRows: pairedRows.length,
      missingEitherBaselineRows: currentRows.length - pairedRows.length,
      seasons: [...new Set(pairedRows.map((row) => row.season))].sort(),
      pairedGameweeks: pairedGws.length,
      rowsBySeason,
    },
    scopes,
  };
}

function formatNumber(value: number | null, digits = 3): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function formatPair(metric: PairMetric, digits = 3): string {
  if (metric.meanDelta === null || !metric.ci95) return "—";
  return `${metric.meanDelta >= 0 ? "+" : ""}${metric.meanDelta.toFixed(digits)} [${metric.ci95[0] >= 0 ? "+" : ""}${metric.ci95[0].toFixed(digits)}, ${metric.ci95[1] >= 0 ? "+" : ""}${metric.ci95[1].toFixed(digits)}]`;
}

function summaryMarkdown(summary: ScopeSummary, heading: string): string[] {
  const lines = [
    `### ${heading}`,
    "",
    `Matched rows: ${summary.rowCount.toLocaleString()} across ${summary.gameweekCount} gameweeks.`,
    "",
    "| Arm | Equal-GW mean Spearman | Defined GWs | Skipped undefined |",
    "|---|---:|---:|---:|",
  ];
  for (const arm of Object.keys(ARM_LABELS) as ArmName[]) {
    const stat = summary.spearman[arm];
    lines.push(`| ${ARM_LABELS[arm]} | ${formatNumber(stat.mean)} | ${stat.definedGameweeks} | ${stat.skippedUndefinedVariance} |`);
  }
  lines.push(
    "",
    "| Paired Spearman difference | Δρ [95% CI] | Matched GWs |",
    "|---|---:|---:|",
    `| Production − rolling | ${formatPair(summary.spearmanDeltas.productionMinusRolling)} | ${summary.spearmanDeltas.productionMinusRolling.matchedGameweeks} |`,
    `| Production − P90 | ${formatPair(summary.spearmanDeltas.productionMinusMinutes)} | ${summary.spearmanDeltas.productionMinusMinutes.matchedGameweeks} |`,
    "",
    "Positive Δρ favors production xP; intervals crossing zero don't resolve a difference.",
  );
  if (summary.topKReturns) {
    lines.push(
      "",
      "| Outfield plausible starters | Production xP mean actual pts | Rolling mean actual pts | P90 mean actual pts | Production − rolling [95% CI] | Production − P90 [95% CI] |",
      "|---|---:|---:|---:|---:|---:|",
    );
    for (const k of [1, 5, 10]) {
      const stat = summary.topKReturns[`top${k}`];
      lines.push(`| Top ${k} | ${formatNumber(stat.production.mean, 2)} | ${formatNumber(stat.rolling.mean, 2)} | ${formatNumber(stat.minutes.mean, 2)} | ${formatPair(stat.deltas.productionMinusRolling, 2)} | ${formatPair(stat.deltas.productionMinusMinutes, 2)} |`);
    }
    lines.push("", "Positive return deltas favor the production xP ranking; each arm selects from the identical eligible gameweek pool.");
  }
  return lines;
}

export function renderMarkdown(result: XpQualityEvaluation, sourcePath: string): string {
  const lines = [
    "# Ranking quality of current production xP",
    "",
    "## Result",
    "",
    `The evaluation matched **${result.coverage.pairedRows.toLocaleString()} of ${result.coverage.rowsWithCurrentPrediction.toLocaleString()} current-production rows** to both baselines across ${result.coverage.pairedGameweeks} season/gameweek clusters. The current-production rank correlations and top-k returns below use those same rows, so the model and simple baselines are compared on the same player pool.`,
    "",
    "A higher Spearman value means the model orders players closer to their realized points within a gameweek. The top-k rows answer a narrower question: how many points the selected high-xP candidates actually returned, on average, over this sample.",
    "",
    "## Overall and per-season metrics",
    "",
  ];
  for (const scope of ["allPlayers", "plausibleStarters", "outfieldStarters"] as ScopeName[]) {
    const title = scope === "allPlayers" ? "All players" : scope === "plausibleStarters" ? "Plausible starters (>=60 expected minutes per fixture)" : "Captain candidate ranking (plausible outfield starters)";
    lines.push(...summaryMarkdown(result.scopes[scope].pooled, `${title}: pooled`), "");
    for (const season of Object.keys(result.scopes[scope].bySeason).sort()) {
      const label = scope === "outfieldStarters" ? `Captain candidate ranking: ${season}` : `${title}: ${season}`;
      lines.push(...summaryMarkdown(result.scopes[scope].bySeason[season], label), "");
    }
  }
  lines.push(
    "## Method and limits",
    "",
    `The input is \`${sourcePath}\`. For each season/gameweek and player cohort, the script calculates Spearman correlation between predicted one-gameweek xP and actual points, using average ranks for ties. It reports an equal-gameweek mean, so rounds with larger player pools do not dominate. Constant prediction or outcome ranks make rho undefined; those gameweeks are counted and skipped.`,
    "",
    "The three arms are current `projectPlayer()` xP, prior points divided by prior recorded fixture rows over the latest five recorded player-gameweeks and scaled by the target fixture count, and prior points per 90 over the same five gameweeks multiplied by the model's expected minutes summed over scheduled fixtures. Baselines require at least three prior recorded gameweeks and 180 actual minutes. DNP fixture rows count as zero points; wholly missing player-gameweeks are not imputed. Starter membership uses the current projection's per-fixture expected minutes, with a threshold of 60, so double gameweeks are not accidentally treated as one 120-minute fixture.",
    "",
    "Top-1, top-5 and top-10 use the predicted order within each game's plausible DEF/MID/FWD candidate pool, with lower player ID breaking exact xP ties. These returns are not legal XI or captain simulations because the archive lacks full event-time roster membership and squad constraints.",
    "",
    `Intervals are paired, season-stratified gameweek-cluster bootstraps with ${result.methodology.bootstrapDraws.toLocaleString()} resamples. The same gameweeks are drawn for both arms, and each season keeps its matched gameweek count. Positive production-minus-baseline deltas favor production xP.`,
    "",
    "The data reconstructs selection with fallback expected minutes and a fixed £5.0m price prior, and does not include complete event-time availability or predicted-lineup inputs. The seasons 2024/25 and 2025/26 have already informed prior model choices, so this is a useful matched historical check, not a fresh independent holdout.",
    "",
    "## Reproduction",
    "",
    "```sh",
    `node --import tsx scripts/backtest/xp-quality-ranking.ts ${sourcePath}`,
    "npx vitest run tests/core/xp-quality-ranking.test.ts",
    "```",
    "",
  );
  return lines.join("\n");
}

export async function runFromFile(inputPath = "output/xp-quality/rows.json"): Promise<XpQualityEvaluation> {
  const resolvedInput = resolve(inputPath);
  const parsed = JSON.parse(await readFile(resolvedInput, "utf8")) as XpQualityInput;
  if (!parsed || !Array.isArray(parsed.rows)) throw new Error(`Expected {rows: [...]} in ${resolvedInput}`);
  const evaluation = evaluateXpRanking(parsed);
  const jsonPath = resolve(REPORT_JSON);
  const markdownPath = resolve(REPORT_MD);
  await mkdir(dirname(jsonPath), { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify({ ...evaluation, input: resolvedInput, inputMetadata: parsed.metadata ?? null }, null, 2)}\n`),
    writeFile(markdownPath, renderMarkdown(evaluation, inputPath)),
  ]);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
  console.log(`Paired rows: ${evaluation.coverage.pairedRows.toLocaleString()} / ${evaluation.coverage.rowsWithCurrentPrediction.toLocaleString()}`);
  for (const scope of ["allPlayers", "plausibleStarters", "outfieldStarters"] as ScopeName[]) {
    const summary = evaluation.scopes[scope].pooled;
    console.log(`${scope}: production rho=${formatNumber(summary.spearman.production.mean)}, rolling=${formatNumber(summary.spearman.rolling.mean)}, P90=${formatNumber(summary.spearman.minutes.mean)}`);
    if (summary.topKReturns) {
      for (const k of [1, 5, 10]) {
        const stat = summary.topKReturns[`top${k}`];
        console.log(`  top${k} actual mean: production=${formatNumber(stat.production.mean, 2)}, rolling=${formatNumber(stat.rolling.mean, 2)}, P90=${formatNumber(stat.minutes.mean, 2)}`);
      }
    }
  }
  return evaluation;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(invokedPath).href) {
  const input = process.argv[2] ?? "output/xp-quality/rows.json";
  runFromFile(input).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
