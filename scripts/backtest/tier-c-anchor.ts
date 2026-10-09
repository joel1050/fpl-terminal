/**
 * Tier C: adjacent-season player-anchor pooling.
 *
 * Run against a prepared target season, with its predecessor in the parent
 * directory. Only 2024/25 and 2025/26 are eligible: their previous seasons have
 * complete xG, and their prepared player anchors use stable FPL codes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HistoricalPlayerRecord } from "@/lib/historical/types";
import type { HistoricalStats, Position } from "@/types/player";
import { priceTieredAttackingPrior } from "@/lib/projections/projectPlayer";
import { regressPer90 } from "@/lib/projections/regression";
import { loadSeason, formBefore, playerAt, strengthsBefore, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";

const TARGET_PRIORS: Record<string, string> = { "2024-25": "2023-24", "2025-26": "2024-25" };
const WEIGHTS = [0, 225, 450, 900, 1800, 3600, 7200, 14400] as const;
const POSITIONS: readonly Position[] = ["GK", "DEF", "MID", "FWD"];
const BOOTSTRAP_DRAWS = 4000;
const REPO_ROOT = path.resolve(__dirname, "../..");
const OUTPUT_DIR = path.join(REPO_ROOT, "output/tier-c");

interface RatePoolTotals { xg: number; xgMinutes: number; xa: number; xaMinutes: number }
interface AnchorRecord {
  historicalPlayerId: number;
  sourceHistoricalPlayerId: number;
  stats: HistoricalStats;
}
interface RateRow {
  gw: number;
  playerId: number;
  minutes: number;
  baseline: number;
  candidate: number;
  actual: number;
}
interface XpRow { gw: number; baseline: number; candidate: number; actual: number }
interface PlayerAnchorCase {
  season: string;
  playerId: number;
  baseline: number;
  candidate: number;
  byGameweek: Array<{ gw: number; xgi: number; minutes: number }>;
}
interface Cluster {
  season: string;
  gw: number;
  rateBaselineSqMinutes: number;
  rateCandidateSqMinutes: number;
  rateMinutes: number;
  rateRows: number;
  xpBaselineSq: number;
  xpCandidateSq: number;
  xpRows: number;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function per90(value: number | undefined, minutes: number): number | undefined {
  return value === undefined || minutes <= 0 ? undefined : (value / minutes) * 90;
}

function addToPool(totals: Map<Position, RatePoolTotals>, record: HistoricalPlayerRecord): void {
  if (!record.position || record.stats.minutes <= 0) return;
  const pool = totals.get(record.position) ?? { xg: 0, xgMinutes: 0, xa: 0, xaMinutes: 0 };
  if (record.stats.expectedGoals !== undefined) {
    pool.xg += record.stats.expectedGoals;
    pool.xgMinutes += record.stats.minutes;
  }
  if (record.stats.expectedAssists !== undefined) {
    pool.xa += record.stats.expectedAssists;
    pool.xaMinutes += record.stats.minutes;
  }
  totals.set(record.position, pool);
}

function poolsForTarget(targetDir: string, priorSeason: string): {
  xg: Record<Position, number>;
  xa: Record<Position, number>;
  sourceById: Map<number, HistoricalPlayerRecord>;
  anchors: AnchorRecord[];
  priorRecords: HistoricalPlayerRecord[];
} {
  const priorDir = path.join(path.dirname(targetDir), priorSeason);
  const priorRecords = readJson<HistoricalPlayerRecord[]>(path.join(priorDir, "historical-players.json"));
  const sourceById = new Map(priorRecords.map((record) => [record.historicalPlayerId, record]));
  const anchors = readJson<AnchorRecord[]>(path.join(targetDir, "previous-player-anchors.json"));
  const totals = new Map<Position, RatePoolTotals>();
  for (const record of priorRecords) addToPool(totals, record);

  const xg = {} as Record<Position, number>;
  const xa = {} as Record<Position, number>;
  for (const position of POSITIONS) {
    const pool = totals.get(position);
    if (!pool || pool.xgMinutes <= 0 || pool.xaMinutes <= 0) {
      throw new Error(`Missing complete prior-season xG/xA pool for ${position} in ${priorSeason}`);
    }
    xg[position] = (pool.xg / pool.xgMinutes) * 90;
    xa[position] = (pool.xa / pool.xaMinutes) * 90;
  }
  return { xg, xa, sourceById, anchors, priorRecords };
}

function leaveOneOutPool(
  position: Position,
  field: "expectedGoals" | "expectedAssists",
  anchor: AnchorRecord,
  totals: Map<Position, RatePoolTotals>,
  sourceById: Map<number, HistoricalPlayerRecord>,
): number {
  const source = sourceById.get(anchor.sourceHistoricalPlayerId);
  const samePosition = source?.position === position;
  const stat = source?.stats[field];
  const hasStat = source !== undefined && stat !== undefined && source.stats.minutes > 0;
  const aggregate = totals.get(position);
  if (!aggregate) throw new Error(`No prior-season pool for ${position}`);
  const total = field === "expectedGoals" ? aggregate.xg : aggregate.xa;
  const minutes = field === "expectedGoals" ? aggregate.xgMinutes : aggregate.xaMinutes;
  const subtract = samePosition && hasStat;
  const adjustedMinutes = minutes - (subtract ? source!.stats.minutes : 0);
  const adjustedTotal = total - (subtract ? stat! : 0);
  if (adjustedMinutes <= 0) throw new Error(`Leave-one-out ${field} pool is empty for ${position}`);
  return (adjustedTotal / adjustedMinutes) * 90;
}

function pointRate(stats: HistoricalStats | undefined, field: "expectedGoals" | "expectedAssists"): number | undefined {
  if (!stats) return undefined;
  return per90(stats[field], stats.minutes);
}

function anchorPrediction(
  observed: number,
  minutes: number,
  productionPrior: number,
  poolRate: number,
  weight: number | undefined,
): number {
  return weight === undefined
    ? regressPer90(observed, minutes, productionPrior, 900)
    : regressPer90(observed, minutes, poolRate, weight);
}

function quantile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function rmseDelta(clusters: readonly Cluster[], metric: "rate" | "xp"): number {
  if (metric === "rate") {
    const denominator = clusters.reduce((sum, cluster) => sum + cluster.rateMinutes, 0);
    if (!denominator) return NaN;
    const baseline = clusters.reduce((sum, cluster) => sum + cluster.rateBaselineSqMinutes, 0);
    const candidate = clusters.reduce((sum, cluster) => sum + cluster.rateCandidateSqMinutes, 0);
    return Math.sqrt(candidate / denominator) - Math.sqrt(baseline / denominator);
  }
  const denominator = clusters.reduce((sum, cluster) => sum + cluster.xpRows, 0);
  if (!denominator) return NaN;
  const baseline = clusters.reduce((sum, cluster) => sum + cluster.xpBaselineSq, 0);
  const candidate = clusters.reduce((sum, cluster) => sum + cluster.xpCandidateSq, 0);
  return Math.sqrt(candidate / denominator) - Math.sqrt(baseline / denominator);
}

function rmseValue(clusters: readonly Cluster[], metric: "rate" | "xp", arm: "baseline" | "candidate"): number {
  if (metric === "rate") {
    const denominator = clusters.reduce((sum, cluster) => sum + cluster.rateMinutes, 0);
    const squared = clusters.reduce((sum, cluster) => sum + (
      arm === "baseline" ? cluster.rateBaselineSqMinutes : cluster.rateCandidateSqMinutes
    ), 0);
    return Math.sqrt(squared / denominator);
  }
  const denominator = clusters.reduce((sum, cluster) => sum + cluster.xpRows, 0);
  const squared = clusters.reduce((sum, cluster) => sum + (
    arm === "baseline" ? cluster.xpBaselineSq : cluster.xpCandidateSq
  ), 0);
  return Math.sqrt(squared / denominator);
}

function pairedCi(clusters: readonly Cluster[], metric: "rate" | "xp", seed: number): [number, number] {
  const random = rng(seed);
  const draws: number[] = [];
  const usable = clusters.filter((cluster) => metric === "rate" ? cluster.rateMinutes > 0 : cluster.xpRows > 0);
  if (usable.length === 0) return [NaN, NaN];
  for (let draw = 0; draw < BOOTSTRAP_DRAWS; draw += 1) {
    const sample: Cluster[] = [];
    for (let i = 0; i < usable.length; i += 1) {
      sample.push(usable[Math.floor(random() * usable.length)]);
    }
    draws.push(rmseDelta(sample, metric));
  }
  return [quantile(draws, 0.025), quantile(draws, 0.975)];
}

function collect(
  season: Season,
  seasonName: string,
  pools: ReturnType<typeof poolsForTarget>,
  targetDir: string,
  weight: number,
  includeXp = true,
): { rateRows: RateRow[]; xpRows: XpRow[] } {
  const poolTotals = new Map<Position, RatePoolTotals>();
  for (const record of pools.priorRecords) addToPool(poolTotals, record);
  const anchorByTarget = new Map(pools.anchors.map((anchor) => [anchor.historicalPlayerId, anchor]));
  const rateRows: RateRow[] = [];
  const xpRows: XpRow[] = [];

  for (let gw = 1; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const fixtureById = new Map((season.fixturesByGameweek.get(gw) ?? []).map((fixture) => [fixture.fixtureId, fixture]));
    for (const row of season.rowsByGameweek.get(gw) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = fixtureById.get(row.fixtureId);
      const anchor = anchorByTarget.get(row.historicalPlayerId);
      if (!fixture || !anchor) continue;
      const player = playerAt(season, row.historicalPlayerId, gw, fixture, row.wasHome);
      if (!player?.historical) continue;
      const priorXg = pointRate(player.historical, "expectedGoals");
      const priorXa = pointRate(player.historical, "expectedAssists");
      if (priorXg === undefined || priorXa === undefined) continue;
      const poolXg = leaveOneOutPool(player.position, "expectedGoals", anchor, poolTotals, pools.sourceById);
      const poolXa = leaveOneOutPool(player.position, "expectedAssists", anchor, poolTotals, pools.sourceById);
      const prior = priceTieredAttackingPrior(player.position, player.priceTenths);
      const baselineAnchor = anchorPrediction(priorXg, player.historical.minutes, prior.xg, poolXg, undefined)
        + anchorPrediction(priorXa, player.historical.minutes, prior.xa, poolXa, undefined);
      const candidateAnchor = anchorPrediction(priorXg, player.historical.minutes, prior.xg, poolXg, weight)
        + anchorPrediction(priorXa, player.historical.minutes, prior.xa, poolXa, weight);
      rateRows.push({
        gw,
        playerId: row.historicalPlayerId,
        minutes: row.minutes,
        baseline: baselineAnchor,
        candidate: candidateAnchor,
        actual: ((row.expectedGoals ?? 0) + (row.expectedAssists ?? 0)) * 90 / row.minutes,
      });

      if (!includeXp) continue;
      const form = formBefore(season, row.historicalPlayerId, gw);
      const baselineRates = playerRates(player, form, gw, {}, strengths);
      const leaveOneOutXg = { ...pools.xg, [player.position]: poolXg };
      const leaveOneOutXa = { ...pools.xa, [player.position]: poolXa };
      const candidateRates = playerRates(player, form, gw, {
        anchorPoolXg: leaveOneOutXg,
        anchorPoolXa: leaveOneOutXa,
        anchorPoolWeightMinutes: weight,
      }, strengths);
      const baselineXp = expectedPoints(
        player, player.fixtures[0], row.minutes, baselineRates, strengths, BASELINE,
      ).total;
      const candidateXp = expectedPoints(
        player, player.fixtures[0], row.minutes, candidateRates, strengths, BASELINE,
      ).total;
      xpRows.push({ gw, baseline: baselineXp, candidate: candidateXp, actual: row.totalPoints });
    }
  }
  if (!rateRows.length) throw new Error(`No valid adjacent-season rate rows for ${seasonName} at ${targetDir}`);
  return { rateRows, xpRows };
}

function clustersFor(seasonName: string, rateRows: readonly RateRow[], xpRows: readonly XpRow[]): Cluster[] {
  const byGw = new Map<number, Cluster>();
  const get = (gw: number) => byGw.get(gw) ?? byGw.set(gw, {
    season: seasonName, gw,
    rateBaselineSqMinutes: 0, rateCandidateSqMinutes: 0, rateMinutes: 0, rateRows: 0,
    xpBaselineSq: 0, xpCandidateSq: 0, xpRows: 0,
  }).get(gw)!;
  for (const row of rateRows) {
    const cluster = get(row.gw);
    cluster.rateBaselineSqMinutes += (row.baseline - row.actual) ** 2 * row.minutes;
    cluster.rateCandidateSqMinutes += (row.candidate - row.actual) ** 2 * row.minutes;
    cluster.rateMinutes += row.minutes;
    cluster.rateRows += 1;
  }
  for (const row of xpRows) {
    const cluster = get(row.gw);
    cluster.xpBaselineSq += (row.baseline - row.actual) ** 2;
    cluster.xpCandidateSq += (row.candidate - row.actual) ** 2;
    cluster.xpRows += 1;
  }
  return [...byGw.values()].sort((a, b) => a.gw - b.gw);
}

function weightedRateRmse(rows: readonly RateRow[], pick: "baseline" | "candidate"): number {
  const minutes = rows.reduce((sum, row) => sum + row.minutes, 0);
  return Math.sqrt(rows.reduce((sum, row) => sum + (row[pick] - row.actual) ** 2 * row.minutes, 0) / minutes);
}

function xpRmse(rows: readonly XpRow[], pick: "baseline" | "candidate"): number {
  return Math.sqrt(rows.reduce((sum, row) => sum + (row[pick] - row.actual) ** 2, 0) / rows.length);
}

function uniquePlayers(rows: readonly RateRow[]): number {
  return new Set(rows.map((row) => row.playerId)).size;
}

function playerAnchorCases(seasonName: string, rows: readonly RateRow[]): PlayerAnchorCase[] {
  const byPlayer = new Map<number, PlayerAnchorCase>();
  for (const row of rows) {
    const item = byPlayer.get(row.playerId) ?? {
      season: seasonName,
      playerId: row.playerId,
      baseline: row.baseline,
      candidate: row.candidate,
      byGameweek: [],
    };
    const gameweek = item.byGameweek.find((entry) => entry.gw === row.gw);
    if (gameweek) {
      gameweek.xgi += row.actual * row.minutes / 90;
      gameweek.minutes += row.minutes;
    } else {
      item.byGameweek.push({ gw: row.gw, xgi: row.actual * row.minutes / 90, minutes: row.minutes });
    }
    byPlayer.set(row.playerId, item);
  }
  return [...byPlayer.values()];
}

function anchorSeasonMetrics(cases: readonly PlayerAnchorCase[]): { n: number; baseline: number; candidate: number; delta: number } {
  let baselineSq = 0;
  let candidateSq = 0;
  let n = 0;
  for (const item of cases) {
    const xgi = item.byGameweek.reduce((sum, row) => sum + row.xgi, 0);
    const minutes = item.byGameweek.reduce((sum, row) => sum + row.minutes, 0);
    if (minutes <= 0) continue;
    const actual = xgi * 90 / minutes;
    baselineSq += (item.baseline - actual) ** 2;
    candidateSq += (item.candidate - actual) ** 2;
    n += 1;
  }
  const baseline = Math.sqrt(baselineSq / n);
  const candidate = Math.sqrt(candidateSq / n);
  return { n, baseline, candidate, delta: candidate - baseline };
}

function anchorSeasonBootstrap(cases: readonly PlayerAnchorCase[], seed: number): [number, number] {
  const random = rng(seed);
  const bySeasonGw = new Map<string, Map<number, Array<{ caseIndex: number; xgi: number; minutes: number }>>>();
  cases.forEach((item, caseIndex) => {
    for (const row of item.byGameweek) {
      const byGw = bySeasonGw.get(item.season) ?? new Map();
      const rows = byGw.get(row.gw) ?? [];
      rows.push({ caseIndex, xgi: row.xgi, minutes: row.minutes });
      byGw.set(row.gw, rows);
      bySeasonGw.set(item.season, byGw);
    }
  });
  const seasonClusters = [...bySeasonGw.entries()].map(([season, byGw]) => ({ season, clusters: [...byGw.values()] }));
  const draws: number[] = [];
  for (let draw = 0; draw < BOOTSTRAP_DRAWS; draw += 1) {
    const totals = new Map<number, { xgi: number; minutes: number }>();
    for (const season of seasonClusters) {
      for (let i = 0; i < season.clusters.length; i += 1) {
        const cluster = season.clusters[Math.floor(random() * season.clusters.length)];
        for (const row of cluster) {
          const total = totals.get(row.caseIndex) ?? { xgi: 0, minutes: 0 };
          total.xgi += row.xgi;
          total.minutes += row.minutes;
          totals.set(row.caseIndex, total);
        }
      }
    }
    let baselineSq = 0;
    let candidateSq = 0;
    let n = 0;
    for (const [caseIndex, total] of totals) {
      if (total.minutes <= 0) continue;
      const item = cases[caseIndex];
      const actual = total.xgi * 90 / total.minutes;
      baselineSq += (item.baseline - actual) ** 2;
      candidateSq += (item.candidate - actual) ** 2;
      n += 1;
    }
    if (n > 0) draws.push(Math.sqrt(candidateSq / n) - Math.sqrt(baselineSq / n));
  }
  return [quantile(draws, 0.025), quantile(draws, 0.975)];
}

function targetInputs(): { seasonName: string; targetDir: string; priorSeason: string } {
  const configuredDir = process.env.BACKTEST_DATA_DIR;
  const targetDir = configuredDir ? path.resolve(configuredDir) : "";
  const seasonName = process.argv[2];
  const priorSeason = TARGET_PRIORS[seasonName];
  if (!targetDir || !priorSeason || path.basename(targetDir) !== seasonName) {
    throw new Error("Usage: BACKTEST_DATA_DIR=<target-season-dir> npx tsx scripts/backtest/tier-c-anchor.ts <2024-25|2025-26> [--sweep|--weight=900]");
  }
  return { seasonName, targetDir, priorSeason };
}

function makeRun(seasonName: string, weight: number): { clusters: Cluster[]; rateRows: RateRow[]; xpRows: XpRow[]; pools: ReturnType<typeof poolsForTarget> } {
  const { targetDir, priorSeason } = targetInputs();
  const pools = poolsForTarget(targetDir, priorSeason);
  const season = loadSeason();
  const { rateRows, xpRows } = collect(season, seasonName, pools, targetDir, weight);
  return { clusters: clustersFor(seasonName, rateRows, xpRows), rateRows, xpRows, pools };
}

function runSweep(seasonName: string): void {
  const { targetDir, priorSeason } = targetInputs();
  const pools = poolsForTarget(targetDir, priorSeason);
  const season = loadSeason();
  const results = WEIGHTS.map((weight) => {
    const { rateRows } = collect(season, seasonName, pools, targetDir, weight, false);
    return {
      weight,
      rmse: anchorSeasonMetrics(playerAnchorCases(seasonName, rateRows)).candidate,
      rows: rateRows.length,
    };
  });
  const baselineRows = collect(season, seasonName, pools, targetDir, 900, false).rateRows;
  const baselineRmse = anchorSeasonMetrics(playerAnchorCases(seasonName, baselineRows)).baseline;
  const winner = results.reduce((best, current) => current.rmse < best.rmse ? current : best);
  console.log(`FIT season=${seasonName} prior=${priorSeason} metric=unweighted player-season xGI/90`);
  console.log(`baseline=shipped price-tier anchor weight=900 rmse=${baselineRmse.toFixed(5)} rows=${baselineRows.length}`);
  console.log("poolWeightMinutes\trows\ttrainRMSE\tdeltaVsShipped");
  for (const result of results) {
    console.log(`${result.weight}\t${result.rows}\t${result.rmse.toFixed(5)}\t${(result.rmse - baselineRmse).toFixed(5)}`);
  }
  console.log(`TRAIN_PICK weightMinutes=${winner.weight} rmse=${winner.rmse.toFixed(5)} deltaVsShipped=${(winner.rmse - baselineRmse).toFixed(5)}`);
}

function runSeason(seasonName: string, weight: number): void {
  const { clusters, rateRows, xpRows, pools } = makeRun(seasonName, weight);
  const anchorCases = playerAnchorCases(seasonName, rateRows);
  const anchorMetrics = anchorSeasonMetrics(anchorCases);
  const anchorCi = anchorSeasonBootstrap(anchorCases, 20261010 + seasonName.charCodeAt(0));
  const rateBaseline = weightedRateRmse(rateRows, "baseline");
  const rateCandidate = weightedRateRmse(rateRows, "candidate");
  const xpBaseline = xpRmse(xpRows, "baseline");
  const xpCandidate = xpRmse(xpRows, "candidate");
  const rateCi = pairedCi(clusters, "rate", 237 + seasonName.charCodeAt(0));
  const xpCi = pairedCi(clusters, "xp", 719 + seasonName.charCodeAt(0));
  console.log(`SEASON=${seasonName} prior=${TARGET_PRIORS[seasonName]} weightMinutes=${weight}`);
  console.log(`POOL xG/90 ${POSITIONS.map((position) => `${position}:${pools.xg[position].toFixed(4)}`).join(" ")}`);
  console.log(`POOL xA/90 ${POSITIONS.map((position) => `${position}:${pools.xa[position].toFixed(4)}`).join(" ")}`);
  console.log(`PLAYER_SEASON_ANCHOR metric=unweighted xGI/90 n=${anchorMetrics.n} gws=${clusters.filter((c) => c.rateRows > 0).length}`);
  console.log(`  shipped=${anchorMetrics.baseline.toFixed(5)} pool=${anchorMetrics.candidate.toFixed(5)} delta=${anchorMetrics.delta.toFixed(5)} CI95=[${anchorCi[0].toFixed(5)},${anchorCi[1].toFixed(5)}]`);
  console.log(`ANCHOR_RATE metric=minute-weighted xGI/90 n=${rateRows.length} playerCount=${uniquePlayers(rateRows)} gws=${clusters.filter((c) => c.rateRows > 0).length}`);
  console.log(`  shipped=${rateBaseline.toFixed(5)} pool=${rateCandidate.toFixed(5)} delta=${(rateCandidate - rateBaseline).toFixed(5)} CI95=[${rateCi[0].toFixed(5)},${rateCi[1].toFixed(5)}]`);
  console.log(`XP metric=player-fixture points, fixed observed minutes n=${xpRows.length} gws=${clusters.filter((c) => c.xpRows > 0).length} adjacentAnchors=true`);
  console.log(`  shipped=${xpBaseline.toFixed(5)} pool=${xpCandidate.toFixed(5)} delta=${(xpCandidate - xpBaseline).toFixed(5)} CI95=[${xpCi[0].toFixed(5)},${xpCi[1].toFixed(5)}]`);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(path.join(OUTPUT_DIR, `paired-${seasonName}.json`), JSON.stringify({ season: seasonName, weight, clusters, anchorCases }, null, 2) + "\n");
}

function runPooled(weight: number): void {
  const a = readJson<{ season: string; weight: number; clusters: Cluster[]; anchorCases: PlayerAnchorCase[] }>(path.join(OUTPUT_DIR, "paired-2024-25.json"));
  const b = readJson<{ season: string; weight: number; clusters: Cluster[]; anchorCases: PlayerAnchorCase[] }>(path.join(OUTPUT_DIR, "paired-2025-26.json"));
  if (a.weight !== weight || b.weight !== weight) throw new Error("Pooled runs must use the same selected weight");
  const clusters = [...a.clusters, ...b.clusters];
  const rateCi = pairedCi(clusters, "rate", 20261008);
  const xpCi = pairedCi(clusters, "xp", 20261009);
  const anchorCases = [...a.anchorCases, ...b.anchorCases];
  const anchorMetrics = anchorSeasonMetrics(anchorCases);
  const anchorCi = anchorSeasonBootstrap(anchorCases, 20261010);
  const rateN = clusters.reduce((sum, cluster) => sum + cluster.rateRows, 0);
  const xpN = clusters.reduce((sum, cluster) => sum + cluster.xpRows, 0);
  console.log(`POOLED seasons=${a.season},${b.season} weightMinutes=${weight} clusters=${clusters.length}`);
  console.log(`PLAYER_SEASON_ANCHOR metric=unweighted xGI/90 n=${anchorMetrics.n} shipped=${anchorMetrics.baseline.toFixed(5)} pool=${anchorMetrics.candidate.toFixed(5)} delta=${anchorMetrics.delta.toFixed(5)} CI95=[${anchorCi[0].toFixed(5)},${anchorCi[1].toFixed(5)}]`);
  console.log(`ANCHOR_RATE metric=minute-weighted xGI/90 n=${rateN} shipped=${rmseValue(clusters, "rate", "baseline").toFixed(5)} pool=${rmseValue(clusters, "rate", "candidate").toFixed(5)} delta=${rmseDelta(clusters, "rate").toFixed(5)} CI95=[${rateCi[0].toFixed(5)},${rateCi[1].toFixed(5)}]`);
  console.log(`XP metric=player-fixture points n=${xpN} shipped=${rmseValue(clusters, "xp", "baseline").toFixed(5)} pool=${rmseValue(clusters, "xp", "candidate").toFixed(5)} delta=${rmseDelta(clusters, "xp").toFixed(5)} CI95=[${xpCi[0].toFixed(5)},${xpCi[1].toFixed(5)}]`);
  console.log("  Pooled includes the fit season 2024/25; the held-out estimate is 2025/26.");
}

function main(): void {
  const mode = process.argv[3] ?? "--sweep";
  if (mode === "--aggregate") {
    const weight = Number(process.argv[4]);
    if (!Number.isFinite(weight) || weight < 0) throw new Error("--aggregate requires a nonnegative weight");
    runPooled(weight);
    return;
  }
  const { seasonName } = targetInputs();
  if (mode === "--sweep") {
    runSweep(seasonName);
    return;
  }
  if (mode.startsWith("--weight=")) {
    const weight = Number(mode.slice("--weight=".length));
    if (!Number.isFinite(weight) || weight < 0) throw new Error("--weight must be nonnegative");
    runSeason(seasonName, weight);
    return;
  }
  throw new Error(`Unknown mode: ${mode}`);
}

main();
