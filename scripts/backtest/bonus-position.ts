/**
 * Compare the pre-change production rule (fixture-scaled for all positions)
 * with flat MID/FWD bonus while keeping GK/DEF scaling. Run once per prepared
 * season, then pool held-out seasons with --pool for a GW-cluster CI.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProjectionComponents } from "@/types/projection";
import { loadSeason, strengthsBefore, formBefore, playerAt } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";

const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 10_000;
const POSITIONS = ["ALL", "MID+FWD", "GK", "DEF", "MID", "FWD"] as const;
type Group = (typeof POSITIONS)[number];

interface ClusterStats {
  gameweek: number;
  n: number;
  xpBaselineSse: number;
  xpTargetSse: number;
  bonusBaselineSse: number;
  bonusTargetSse: number;
  bonusBaselineError: number;
  bonusTargetError: number;
}

interface SeasonResult {
  season: string;
  role: string;
  positions: Record<Group, ClusterStats[]>;
}

type ClusterMap = Map<string, ClusterStats>;

function roleFor(season: string): string {
  if (season === "2022-23") return "reduced diagnostic; xG starts at GW16; no previous anchor; excluded";
  if (season === "2023-24") return "pre-holdout training diagnostic; no coefficient fit; Elo burn-in";
  if (season === "2024-25" || season === "2025-26") return "held-out evaluation";
  return "unclassified";
}

function clusterFor(groups: Record<Group, ClusterMap>, group: Group, season: string, gameweek: number): ClusterStats {
  const key = `${season}:gw${gameweek}`;
  let stats = groups[group].get(key);
  if (!stats) {
    stats = {
      gameweek,
      n: 0,
      xpBaselineSse: 0,
      xpTargetSse: 0,
      bonusBaselineSse: 0,
      bonusTargetSse: 0,
      bonusBaselineError: 0,
      bonusTargetError: 0,
    };
    groups[group].set(key, stats);
  }
  return stats;
}

function scoreSeason(): SeasonResult {
  const seasonData = loadSeason();
  const seasonName = path.basename(process.env.BACKTEST_DATA_DIR ?? "legacy-generated-corpus");
  const groups = Object.fromEntries(POSITIONS.map((position) => [position, new Map()])) as Record<Group, ClusterMap>;
  let rows = 0;

  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(seasonData, gameweek);
    const fixtureById = new Map((seasonData.fixturesByGameweek.get(gameweek) ?? []).map((fixture) => [fixture.fixtureId, fixture]));
    for (const row of seasonData.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = fixtureById.get(row.fixtureId);
      if (!fixture) continue;
      const player = playerAt(seasonData, row.historicalPlayerId, gameweek, fixture, row.wasHome);
      if (!player) continue;
      const form = formBefore(seasonData, row.historicalPlayerId, gameweek);
      const rates = playerRates(player, form, gameweek, undefined, strengths);
      const upcoming = player.fixtures[0];
      // Explicit true reproduces the production arm at the starting HEAD.
      const baseline = expectedPoints(player, upcoming, row.minutes, rates, strengths, BASELINE, true);
      const target = expectedPoints(
        player,
        upcoming,
        row.minutes,
        rates,
        strengths,
        BASELINE,
        player.position === "GK" || player.position === "DEF",
      );

      for (const key of Object.keys(baseline) as (keyof ProjectionComponents)[]) {
        const changed = Math.abs(baseline[key] - target[key]) > 1e-12;
        assert(
          !changed || key === "bonus" || key === "total",
          `bonus arm changed ${key} for ${player.position} ${player.displayName} GW${gameweek}`,
        );
        if (player.position === "GK" || player.position === "DEF") {
          assert(!changed, `bonus arm changed defensive bonus for ${player.position} ${player.displayName} GW${gameweek}`);
        }
      }

      const bonusBaselineError = baseline.bonus - row.bonus;
      const bonusTargetError = target.bonus - row.bonus;
      const rowGroups: Group[] = ["ALL", player.position];
      if (player.position === "MID" || player.position === "FWD") rowGroups.push("MID+FWD");
      for (const group of rowGroups) {
        const stats = clusterFor(groups, group, seasonName, gameweek);
        stats.n += 1;
        stats.xpBaselineSse += (baseline.total - row.totalPoints) ** 2;
        stats.xpTargetSse += (target.total - row.totalPoints) ** 2;
        stats.bonusBaselineSse += bonusBaselineError ** 2;
        stats.bonusTargetSse += bonusTargetError ** 2;
        stats.bonusBaselineError += bonusBaselineError;
        stats.bonusTargetError += bonusTargetError;
      }
      rows += 1;
    }
  }

  assert(rows > 0, `no scored rows found for ${seasonName}`);
  const positions = Object.fromEntries(
    POSITIONS.map((position) => [position, [...groups[position].values()].sort((a, b) => a.gameweek - b.gameweek)]),
  ) as Record<Group, ClusterStats[]>;
  return { season: seasonName, role: roleFor(seasonName), positions };
}

function seedFor(label: string): number {
  let seed = 20261008;
  for (const char of label) seed = (Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0);
  return seed & 0x7fffffff;
}

function pairedCi(
  clusters: readonly ClusterStats[],
  baseSse: (cluster: ClusterStats) => number,
  targetSse: (cluster: ClusterStats) => number,
  seed: number,
): [number, number, number] {
  const n = clusters.reduce((sum, cluster) => sum + cluster.n, 0);
  const baseTotal = clusters.reduce((sum, cluster) => sum + baseSse(cluster), 0);
  const targetTotal = clusters.reduce((sum, cluster) => sum + targetSse(cluster), 0);
  const baseRmse = Math.sqrt(baseTotal / n);
  const targetRmse = Math.sqrt(targetTotal / n);
  const deltas: number[] = [];
  let state = seed;
  const random = () => {
    state = (Math.imul(1103515245, state) + 12345) & 0x7fffffff;
    return state / 0x80000000;
  };
  for (let sample = 0; sample < BOOTSTRAP; sample += 1) {
    let base = 0;
    let target = 0;
    let sampleN = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      base += baseSse(cluster);
      target += targetSse(cluster);
      sampleN += cluster.n;
    }
    deltas.push(Math.sqrt(target / sampleN) - Math.sqrt(base / sampleN));
  }
  deltas.sort((a, b) => a - b);
  return [targetRmse - baseRmse, deltas[Math.floor(0.025 * BOOTSTRAP)], deltas[Math.floor(0.975 * BOOTSTRAP)]];
}

function printTable(label: string, positions: Record<Group, ClusterStats[]>): void {
  console.log(`\n${label}`);
  console.log("position   rows  GWs   xP RMSE starting-HEAD→flatMID/FWD   ΔxP RMSE [95% GW-cluster CI]     bonus RMSE starting-HEAD→target   Δbonus RMSE [95% CI]      bonus bias starting-HEAD→target");
  console.log("-".repeat(169));
  for (const position of POSITIONS) {
    const clusters = positions[position];
    if (clusters.length === 0) {
      console.log(`${position.padEnd(8)} no rows`);
      continue;
    }
    const n = clusters.reduce((sum, cluster) => sum + cluster.n, 0);
    const xpBase = Math.sqrt(clusters.reduce((sum, cluster) => sum + cluster.xpBaselineSse, 0) / n);
    const xpTarget = Math.sqrt(clusters.reduce((sum, cluster) => sum + cluster.xpTargetSse, 0) / n);
    const bonusBase = Math.sqrt(clusters.reduce((sum, cluster) => sum + cluster.bonusBaselineSse, 0) / n);
    const bonusTarget = Math.sqrt(clusters.reduce((sum, cluster) => sum + cluster.bonusTargetSse, 0) / n);
    const baseBias = clusters.reduce((sum, cluster) => sum + cluster.bonusBaselineError, 0) / n;
    const targetBias = clusters.reduce((sum, cluster) => sum + cluster.bonusTargetError, 0) / n;
    const [xpDelta, xpLo, xpHi] = pairedCi(
      clusters, (cluster) => cluster.xpBaselineSse, (cluster) => cluster.xpTargetSse,
      seedFor(`${label}:${position}:xp`),
    );
    const [bonusDelta, bonusLo, bonusHi] = pairedCi(
      clusters, (cluster) => cluster.bonusBaselineSse, (cluster) => cluster.bonusTargetSse,
      seedFor(`${label}:${position}:bonus`),
    );
    console.log(
      `${position.padEnd(8)} ${String(n).padStart(5)} ${String(clusters.length).padStart(4)}   `
      + `${xpBase.toFixed(4)}→${xpTarget.toFixed(4)}             `
      + `${signed(xpDelta)} [${signed(xpLo)}, ${signed(xpHi)}]      `
      + `${bonusBase.toFixed(4)}→${bonusTarget.toFixed(4)}          `
      + `${signed(bonusDelta)} [${signed(bonusLo)}, ${signed(bonusHi)}]       `
      + `${signed(baseBias)}→${signed(targetBias)}`,
    );
  }
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;
}

function runSeason(outputPath: string): void {
  const result = scoreSeason();
  const rows = result.positions.ALL.reduce((sum, cluster) => sum + cluster.n, 0);
  console.log(`Season ${result.season}: ${result.role}`);
  console.log(`walk-forward rows: ${rows.toLocaleString()}; gameweeks ${FIRST_GAMEWEEK}-38; paired bootstrap: ${BOOTSTRAP.toLocaleString()} GW-cluster resamples`);
  printTable(`SEASON ${result.season}`, result.positions);
  mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\ncluster summary: ${outputPath}`);
}

function runPool(label: string, inputPaths: string[]): void {
  assert(inputPaths.length > 0, "--pool requires at least one season summary JSON");
  const seasons = new Set<string>();
  const positions = {} as Record<Group, ClusterStats[]>;
  for (const position of POSITIONS) positions[position] = [];
  for (const inputPath of inputPaths) {
    const result = JSON.parse(readFileSync(inputPath, "utf8")) as SeasonResult;
    assert(result.season && result.positions, `invalid season summary: ${inputPath}`);
    assert(!seasons.has(result.season), `duplicate season in pool: ${result.season}`);
    seasons.add(result.season);
    for (const position of POSITIONS) {
      positions[position].push(...result.positions[position]);
    }
  }
  const seasonLabel = [...seasons].sort().join(", ");
  printTable(`POOLED ${label} (${seasonLabel})`, positions);
}

const args = process.argv.slice(2);
if (args[0] === "--pool") {
  const [label, ...paths] = args.slice(1);
  assert(label, "--pool requires a label, such as held-out");
  runPool(label, paths);
} else {
  const outputFlag = args.indexOf("--output");
  assert(outputFlag >= 0 && args[outputFlag + 1], "provide --output <summary.json>");
  runSeason(args[outputFlag + 1]);
}
