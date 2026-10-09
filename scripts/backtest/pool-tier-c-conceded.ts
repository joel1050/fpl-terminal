/** Pool per-season Tier C outputs and report paired gameweek-cluster intervals. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Position } from "@/types/player";
import { CLEAN_SHEET_DISPERSION } from "@/lib/projections/fixtureAdjustment";

const BOOTSTRAP_DRAWS = 4000;
const ARM_NAMES = [
  "current mix: NB(phi=12) clean sheet / Poisson conceded",
  "consistent Poisson",
  "consistent NB(phi=12)",
  "consistent training-selected distribution",
] as const;

interface EventCase {
  gameweek: number;
  cleanSheet: 0 | 1;
  goalsAgainst: number;
  lambda: number;
  probabilities: number[];
}

interface PlayerCase {
  gameweek: number;
  position: Position;
  actualPoints: number;
  expectedPoints: number[];
  actualConcededPoints?: number;
  concededPoints: number[];
}

interface SeasonResult {
  season: string;
  phase: "reduced" | "training" | "held-out";
  arms: string[];
  firstGameweek: number;
  fitPhi: number | null;
  fitScores: { phi: number; brier: number }[];
  parity: { rows: number; worstTotalGap: number; worstComponentGap: number };
  coverage: {
    teamFixtureSides: number;
    ratedTeamFixtureSides: number;
    playedRows: number;
    goalkeeperDefenderRowsWithConceded: number;
  };
  eventCases: EventCase[];
  playerCases: PlayerCase[];
}

type MetricName = "cs-brier" | "cs-logloss" | "goals-count-nll" | "conceded-rmse" | "xp-rmse" | "gk-def-xp-rmse";
interface Point {
  season: string;
  gameweek: number;
  actual: number;
  predictions: number[];
  lambda?: number;
  phi?: number | null;
}

const positiveLog = (value: number) => Math.log(Math.max(value, 1e-12));

function countLogProbability(lambda: number, count: number, family: "POISSON" | "NEGATIVE_BINOMIAL", phi: number): number {
  if (family === "POISSON") {
    let logFactorial = 0;
    for (let value = 2; value <= count; value += 1) logFactorial += Math.log(value);
    return -lambda + count * positiveLog(lambda) - logFactorial;
  }
  const shape = Math.max(phi, 0.1);
  let result = shape * Math.log(shape / (shape + lambda));
  const eventTerm = Math.log(lambda / (shape + lambda));
  for (let value = 0; value < count; value += 1) {
    result += Math.log(shape + value) - Math.log(value + 1) + eventTerm;
  }
  return result;
}

function pointsFor(bundles: readonly SeasonResult[], metric: MetricName): Point[] {
  const points: Point[] = [];
  for (const bundle of bundles) {
    if (metric === "cs-brier" || metric === "cs-logloss" || metric === "goals-count-nll") {
      for (const item of bundle.eventCases) {
        points.push({
          season: bundle.season,
          gameweek: item.gameweek,
          actual: metric === "goals-count-nll" ? item.goalsAgainst : item.cleanSheet,
          predictions: item.probabilities,
          lambda: item.lambda,
          phi: bundle.fitPhi,
        });
      }
      continue;
    }
    for (const item of bundle.playerCases) {
      if (metric === "conceded-rmse") {
        if (item.actualConcededPoints === undefined) continue;
        points.push({
          season: bundle.season,
          gameweek: item.gameweek,
          actual: item.actualConcededPoints,
          predictions: item.concededPoints,
          phi: bundle.fitPhi,
        });
      } else {
        if (metric === "gk-def-xp-rmse" && item.position !== "GK" && item.position !== "DEF") continue;
        points.push({
          season: bundle.season,
          gameweek: item.gameweek,
          actual: item.actualPoints,
          predictions: item.expectedPoints,
          phi: bundle.fitPhi,
        });
      }
    }
  }
  return points;
}

function loss(point: Point, arm: number, metric: MetricName): number {
  if (metric === "cs-brier") return (point.predictions[arm] - point.actual) ** 2;
  if (metric === "cs-logloss") {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, point.predictions[arm]));
    return point.actual ? -Math.log(p) : -Math.log(1 - p);
  }
  if (metric === "goals-count-nll") {
    const family = arm < 2 || (arm === 3 && point.phi === null) ? "POISSON" : "NEGATIVE_BINOMIAL";
    const phi = arm === 2 ? CLEAN_SHEET_DISPERSION : point.phi ?? CLEAN_SHEET_DISPERSION;
    return -countLogProbability(point.lambda ?? 0, point.actual, family, phi);
  }
  return (point.predictions[arm] - point.actual) ** 2;
}

function aggregateScore(sum: number, count: number, metric: MetricName): number {
  if (count === 0) return Number.NaN;
  const average = sum / count;
  return metric.endsWith("rmse") ? Math.sqrt(average) : average;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

function pairedInterval(points: readonly Point[], metric: MetricName, label: string): [number, number][] {
  const bySeason = new Map<string, Map<number, { count: number; sums: number[] }>>();
  for (const point of points) {
    const weeks = bySeason.get(point.season) ?? new Map<number, { count: number; sums: number[] }>();
    const stat = weeks.get(point.gameweek) ?? { count: 0, sums: Array(ARM_NAMES.length).fill(0) as number[] };
    stat.count += 1;
    for (let arm = 0; arm < ARM_NAMES.length; arm += 1) stat.sums[arm] += loss(point, arm, metric);
    weeks.set(point.gameweek, stat);
    bySeason.set(point.season, weeks);
  }
  const strata = [...bySeason.values()].map((weeks) => [...weeks.values()]);
  const random = seededRandom(hash(label));
  const deltas = Array.from({ length: BOOTSTRAP_DRAWS }, () => {
    const sums = Array(ARM_NAMES.length).fill(0) as number[];
    let count = 0;
    for (const clusters of strata) {
      for (let draw = 0; draw < clusters.length; draw += 1) {
        const cluster = clusters[Math.floor(random() * clusters.length)];
        count += cluster.count;
        for (let arm = 0; arm < ARM_NAMES.length; arm += 1) sums[arm] += cluster.sums[arm];
      }
    }
    return ARM_NAMES.slice(1).map((_, offset) =>
      aggregateScore(sums[offset + 1], count, metric) - aggregateScore(sums[0], count, metric));
  });
  return ARM_NAMES.slice(1).map((_, offset) => {
    const values = deltas.map((draw) => draw[offset]).sort((a, b) => a - b);
    return [
      values[Math.floor((BOOTSTRAP_DRAWS - 1) * 0.025)],
      values[Math.floor((BOOTSTRAP_DRAWS - 1) * 0.975)],
    ];
  });
}

function scores(points: readonly Point[], metric: MetricName): number[] {
  return ARM_NAMES.map((_, arm) => aggregateScore(
    points.reduce((sum, point) => sum + loss(point, arm, metric), 0),
    points.length,
    metric,
  ));
}

function formatDelta(value: number): string { return `${value >= 0 ? "+" : ""}${value.toFixed(5)}`; }

function reportMetric(title: string, bundles: readonly SeasonResult[], metric: MetricName): void {
  const points = pointsFor(bundles, metric);
  if (points.length === 0) {
    console.log(`  ${title}: unavailable (no scored rows)`);
    return;
  }
  const values = scores(points, metric);
  console.log(`  ${title}: n=${points.length}, baseline=${values[0].toFixed(5)}`);
  if (points.length < 2 || new Set(points.map((point) => `${point.season}:${point.gameweek}`)).size < 2) {
    console.log("    insufficient gameweek clusters for uncertainty interval");
    return;
  }
  const intervals = pairedInterval(points, metric, `${title}:${bundles.map((bundle) => bundle.season).join(",")}`);
  for (let arm = 1; arm < ARM_NAMES.length; arm += 1) {
    const [lo, hi] = intervals[arm - 1];
    console.log(`    ${ARM_NAMES[arm]}: ${values[arm].toFixed(5)}; delta ${formatDelta(values[arm] - values[0])} [${formatDelta(lo)}, ${formatDelta(hi)}]`);
  }
}

function reportBundle(bundle: SeasonResult): void {
  console.log(`\n=== ${bundle.season} (${bundle.phase}) ===`);
  console.log(`GW${bundle.firstGameweek}-38; team-fixture sides=${bundle.coverage.teamFixtureSides}; rated=${bundle.coverage.ratedTeamFixtureSides}; xP parity rows=${bundle.parity.rows}; scored xP rows=${bundle.playerCases.length}; GK/DEF conceded rows=${bundle.coverage.goalkeeperDefenderRowsWithConceded}`);
  reportMetric("clean-sheet Brier", [bundle], "cs-brier");
  reportMetric("clean-sheet logloss", [bundle], "cs-logloss");
  reportMetric("full-fixture goals-conceded count NLL", [bundle], "goals-count-nll");
  reportMetric("player goals-conceded deduction RMSE", [bundle], "conceded-rmse");
  reportMetric("whole-xP RMSE", [bundle], "xp-rmse");
  reportMetric("GK/DEF xP RMSE", [bundle], "gk-def-xp-rmse");
}

function main(): void {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error("pass per-season output/tier-c/*.json files");
  const bundles = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as SeasonResult);
  for (const bundle of bundles) {
    assert.deepEqual(bundle.arms, ARM_NAMES);
    assert.equal(bundle.coverage.teamFixtureSides, bundle.coverage.ratedTeamFixtureSides);
  }
  const train = bundles.find((bundle) => bundle.phase === "training");
  if (!train) throw new Error("the 2023/24 training output is required");
  for (const bundle of bundles.filter((item) => item.phase !== "training")) {
    assert.equal(bundle.fitPhi, train.fitPhi, `${bundle.season} used a different training phi`);
  }

  console.log(`training selection: ${train.fitPhi === null ? "Poisson limit" : `NB phi=${train.fitPhi}`} from 2023/24 clean-sheet Brier; production phi=${CLEAN_SHEET_DISPERSION}`);
  console.log(`arms: ${ARM_NAMES.join(" | ")}`);
  for (const bundle of bundles) reportBundle(bundle);
  const heldOut = bundles.filter((bundle) => bundle.phase === "held-out");
  if (heldOut.length !== 2) throw new Error(`expected both held-out seasons; got ${heldOut.map((item) => item.season).join(",")}`);
  console.log("\n=== Pooled held-out 2024/25 + 2025/26 (stratified GW-cluster bootstrap) ===");
  console.log(`team-fixture sides=${heldOut.reduce((sum, bundle) => sum + bundle.eventCases.length, 0)}; xP rows=${heldOut.reduce((sum, bundle) => sum + bundle.playerCases.length, 0)}`);
  reportMetric("clean-sheet Brier", heldOut, "cs-brier");
  reportMetric("clean-sheet logloss", heldOut, "cs-logloss");
  reportMetric("full-fixture goals-conceded count NLL", heldOut, "goals-count-nll");
  reportMetric("player goals-conceded deduction RMSE", heldOut, "conceded-rmse");
  reportMetric("whole-xP RMSE", heldOut, "xp-rmse");
  reportMetric("GK/DEF xP RMSE", heldOut, "gk-def-xp-rmse");
}

main();
