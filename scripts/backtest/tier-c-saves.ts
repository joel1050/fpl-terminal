/**
 * Walk-forward denominator experiment for the shipped goalkeeper save-volume
 * adjustment. Run once per season with BACKTEST_CASE_OUT, then pool those
 * immutable cases with --pool so each held-out season gets a denominator fitted
 * only on earlier seasons.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectPlayer } from "@/lib/projections/projectPlayer";
import { expectedFloorDivision } from "@/lib/projections/distributions";
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { adjust, BASELINE } from "./variants";

const FIRST_EVALUATION_GAMEWEEK = 6;
const FIRST_TRAINING_GAMEWEEK = 11;
const SHIPPED_DENOMINATOR = 1.35;
const LEAGUE_MEAN_XG_REFERENCE = 1.408;
const SAVES_PER_POINT = 3;
const BOOTSTRAP_DRAWS = 4_000;
const FIT_MIN = 0.5;
const FIT_MAX = 3.0;
const FIT_STEP = 0.001;
const TOLERANCE = 1e-9;

interface SaveCase {
  season: string;
  gameweek: number;
  actualSaves: number;
  actualPoints: number;
  rawSaveVolume: number;
  expectedGoalsAgainst: number;
  baselineSavesPoints: number;
  baselineTotal: number;
}

interface SeasonCases {
  label: string;
  cases: SaveCase[];
  eligibleGoalkeeperAppearances: number;
  missingSaves: number;
  parityRows: number;
  worstTotalGap: number;
  worstSavesGap: number;
}

type Metric = "saves" | "gkXp";
type Denominator = (item: SaveCase) => number;

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const rmse = (values: readonly number[]) => Math.sqrt(mean(values.map((value) => value * value)));

function collect(season: Season, label: string): SeasonCases {
  const result: SeasonCases = {
    label,
    cases: [],
    eligibleGoalkeeperAppearances: 0,
    missingSaves: 0,
    parityRows: 0,
    worstTotalGap: 0,
    worstSavesGap: 0,
  };

  for (let gameweek = FIRST_EVALUATION_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(season, gameweek);
    const fixtureById = new Map(
      (season.fixturesByGameweek.get(gameweek) ?? []).map((fixture) => [fixture.fixtureId, fixture]),
    );

    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = fixtureById.get(row.fixtureId);
      if (!fixture) continue;
      const player = playerAt(season, row.historicalPlayerId, gameweek, fixture, row.wasHome);
      if (!player || player.position !== "GK") continue;
      result.eligibleGoalkeeperAppearances += 1;
      if (row.saves === undefined) {
        result.missingSaves += 1;
        continue;
      }

      const upcoming = player.fixtures[0];
      const form = formBefore(season, row.historicalPlayerId, gameweek);
      const rates = playerRates(player, form, gameweek, undefined, strengths);
      const baseline = expectedPoints(
        player,
        upcoming,
        row.minutes,
        rates,
        strengths,
        BASELINE,
      );
      const production = projectPlayer(player, {
        currentGameweek: gameweek,
        horizon: 1,
        teamStrengths: strengths,
        playerForm: { [player.id]: form },
        expectedMinutes: row.minutes,
      }).fixtures[0]?.components;
      if (!production) throw new Error(`${label} GW${gameweek}: production returned no components for ${player.displayName}`);

      result.parityRows += 1;
      result.worstTotalGap = Math.max(result.worstTotalGap, Math.abs(baseline.total - production.total));
      result.worstSavesGap = Math.max(result.worstSavesGap, Math.abs(baseline.saves - production.saves));
      if (result.worstTotalGap > TOLERANCE || result.worstSavesGap > TOLERANCE) {
        throw new Error(
          `${label} GW${gameweek}: xP parity failed for ${player.displayName}; ` +
          `total gap ${result.worstTotalGap}, saves gap ${result.worstSavesGap}`,
        );
      }

      const adjustment = adjust(upcoming, {
        ownTeam: strengths[player.teamId],
        opponentTeam: strengths[upcoming.opponentTeamId],
      }, BASELINE);
      const minutesShare = clamp(row.minutes, 0, 90) / 90;
      const rawSaveVolume = rates.saves * minutesShare;
      const shippedSavePoints = expectedFloorDivision(
        rawSaveVolume * clamp(adjustment.expectedGoalsAgainst / SHIPPED_DENOMINATOR, 0.7, 1.4),
        SAVES_PER_POINT,
      );
      if (Math.abs(shippedSavePoints - baseline.saves) > TOLERANCE) {
        throw new Error(`${label} GW${gameweek}: direct denominator path does not match shipped saves xP`);
      }

      result.cases.push({
        season: label,
        gameweek,
        actualSaves: row.saves,
        actualPoints: row.totalPoints,
        rawSaveVolume,
        expectedGoalsAgainst: adjustment.expectedGoalsAgainst,
        baselineSavesPoints: baseline.saves,
        baselineTotal: baseline.total,
      });
    }
  }
  return result;
}

function savePrediction(item: SaveCase, denominator: number): number {
  const environment = clamp(item.expectedGoalsAgainst / denominator, 0.7, 1.4);
  return item.rawSaveVolume * environment;
}

function metricError(item: SaveCase, denominator: number, metric: Metric): number {
  if (metric === "saves") return savePrediction(item, denominator) - item.actualSaves;
  const savePoints = expectedFloorDivision(savePrediction(item, denominator), SAVES_PER_POINT);
  return item.baselineTotal - item.baselineSavesPoints + savePoints - item.actualPoints;
}

function score(cases: readonly SaveCase[], denominator: Denominator, metric: Metric): number {
  return rmse(cases.map((item) => metricError(item, denominator(item), metric)));
}

function fitDenominator(cases: readonly SaveCase[]): number {
  if (cases.length === 0) throw new Error("cannot fit a denominator with no training goalkeeper appearances");
  let best = FIT_MIN;
  let bestScore = Number.POSITIVE_INFINITY;
  const steps = Math.round((FIT_MAX - FIT_MIN) / FIT_STEP);
  for (let index = 0; index <= steps; index += 1) {
    const candidate = FIT_MIN + index * FIT_STEP;
    const candidateRmse = score(cases, () => candidate, "saves");
    if (candidateRmse < bestScore) {
      best = candidate;
      bestScore = candidateRmse;
    }
  }
  return best;
}

function pairedInterval(
  cases: readonly SaveCase[],
  candidate: Denominator,
  metric: Metric,
  seed: number,
): { low: number; high: number } {
  const bySeason = new Map<string, Map<number, SaveCase[]>>();
  for (const item of cases) {
    const weeks = bySeason.get(item.season) ?? new Map<number, SaveCase[]>();
    const cluster = weeks.get(item.gameweek) ?? [];
    cluster.push(item);
    weeks.set(item.gameweek, cluster);
    bySeason.set(item.season, weeks);
  }
  const strata = [...bySeason.values()].map((weeks) => [...weeks.values()]);
  let state = seed | 0;
  const random = () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) & 0x7fffffff;
    return state / 0x80000000;
  };
  const deltas: number[] = [];

  for (let draw = 0; draw < BOOTSTRAP_DRAWS; draw += 1) {
    const sample: SaveCase[] = [];
    for (const clusters of strata) {
      for (let index = 0; index < clusters.length; index += 1) {
        sample.push(...clusters[Math.floor(random() * clusters.length)]);
      }
    }
    const base = score(sample, () => SHIPPED_DENOMINATOR, metric);
    deltas.push(score(sample, candidate, metric) - base);
  }

  deltas.sort((a, b) => a - b);
  return {
    low: deltas[Math.floor(BOOTSTRAP_DRAWS * 0.025)],
    high: deltas[Math.floor(BOOTSTRAP_DRAWS * 0.975)],
  };
}

function fmt(value: number, places = 5): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(places)}`;
}

function printMetric(
  label: string,
  cases: readonly SaveCase[],
  candidate: Denominator,
  metric: Metric,
  seed: number,
): void {
  const baseline = score(cases, () => SHIPPED_DENOMINATOR, metric);
  const candidateScore = score(cases, candidate, metric);
  const interval = pairedInterval(cases, candidate, metric, seed);
  console.log(
    `  ${label.padEnd(23)} ${candidateScore.toFixed(5)}  ${fmt(candidateScore - baseline)}  ` +
    `[${fmt(interval.low)}, ${fmt(interval.high)}]`,
  );
}

function priorCases(all: readonly SaveCase[], targetSeason: string): SaveCase[] {
  return all.filter((item) =>
    item.season < targetSeason && item.season !== "2022-23" && item.gameweek >= FIRST_TRAINING_GAMEWEEK,
  );
}

function analyze(seasons: readonly SeasonCases[]): void {
  const eligibleTargets = ["2024-25", "2025-26"];
  const allCases = seasons.flatMap((item) => item.cases);
  const evaluationBySeason = new Map<string, SaveCase[]>();
  const fittedBySeason = new Map<string, number>();

  console.log("Tier C save-volume denominator experiment");
  console.log(`fit range: ${FIT_MIN.toFixed(2)}-${FIT_MAX.toFixed(2)} by ${FIT_STEP.toFixed(3)}, optimizing saves RMSE`);
  console.log(`evaluation rows: GW${FIRST_EVALUATION_GAMEWEEK}-38; training rows: GW${FIRST_TRAINING_GAMEWEEK}-38`);
  for (const item of seasons) {
    console.log(
      `${item.label}: ${item.cases.length} GK appearances with saves, ` +
      `${item.missingSaves}/${item.eligibleGoalkeeperAppearances} eligible rows missing saves, ` +
      `parity ${item.parityRows} rows (worst total ${item.worstTotalGap.toExponential(2)}, ` +
      `saves ${item.worstSavesGap.toExponential(2)})`,
    );
  }

  for (const targetSeason of eligibleTargets) {
    const target = seasons.find((item) => item.label === targetSeason);
    if (!target || target.cases.length === 0) throw new Error(`missing held-out data for ${targetSeason}`);
    const training = priorCases(allCases, targetSeason);
    const fitted = fitDenominator(training);
    fittedBySeason.set(targetSeason, fitted);
    evaluationBySeason.set(targetSeason, target.cases);
    const trainingSeasons = [...new Set(training.map((item) => item.season))].join(", ");
    console.log(
      `\n${targetSeason}: train on ${trainingSeasons || "none"} (${training.length} appearances); ` +
      `fitted denominator ${fitted.toFixed(3)}; held out ${target.cases.length} appearances`,
    );
    console.log("  metric                 RMSE       Δ vs 1.35   paired 95% GW-cluster CI");
    console.log(`  saves, shipped 1.35     ${score(target.cases, () => SHIPPED_DENOMINATOR, "saves").toFixed(5)}       —            —`);
    console.log(`  GK xP, shipped 1.35     ${score(target.cases, () => SHIPPED_DENOMINATOR, "gkXp").toFixed(5)}       —            —`);
    printMetric("saves, 1.408 reference", target.cases, () => LEAGUE_MEAN_XG_REFERENCE, "saves", 20261008);
    printMetric("GK xP, 1.408 reference", target.cases, () => LEAGUE_MEAN_XG_REFERENCE, "gkXp", 20261009);
    printMetric("saves, fitted", target.cases, () => fitted, "saves", 20261010);
    printMetric("GK xP, fitted", target.cases, () => fitted, "gkXp", 20261011);
  }

  const pooled = eligibleTargets.flatMap((season) => evaluationBySeason.get(season) ?? []);
  const fittedCandidate: Denominator = (item) => {
    const fitted = fittedBySeason.get(item.season);
    if (fitted === undefined) throw new Error(`no training-only denominator recorded for ${item.season}`);
    return fitted;
  };
  console.log(`\nPooled held-out seasons: ${eligibleTargets.join(" + ")} (${pooled.length} GK appearances)`);
  console.log(`  metric                 RMSE       Δ vs 1.35   paired 95% GW-cluster CI`);
  console.log(`  saves, shipped 1.35     ${score(pooled, () => SHIPPED_DENOMINATOR, "saves").toFixed(5)}       —            —`);
  console.log(`  GK xP, shipped 1.35     ${score(pooled, () => SHIPPED_DENOMINATOR, "gkXp").toFixed(5)}       —            —`);
  printMetric("saves, 1.408 reference", pooled, () => LEAGUE_MEAN_XG_REFERENCE, "saves", 20261012);
  printMetric("GK xP, 1.408 reference", pooled, () => LEAGUE_MEAN_XG_REFERENCE, "gkXp", 20261013);
  printMetric("saves, fitted", pooled, fittedCandidate, "saves", 20261014);
  printMetric("GK xP, fitted", pooled, fittedCandidate, "gkXp", 20261015);
  console.log(`\nfitted denominator by held-out season: ${[...fittedBySeason].map(([season, value]) => `${season}=${value.toFixed(3)}`).join(", ")}`);
}

function main(): void {
  const poolIndex = process.argv.indexOf("--pool");
  if (poolIndex >= 0) {
    const files = process.argv.slice(poolIndex + 1);
    if (files.length === 0) throw new Error("--pool requires one or more collected case files");
    const seasons = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as SeasonCases);
    analyze(seasons);
    return;
  }

  const dataDir = process.env.BACKTEST_DATA_DIR ?? path.join(path.resolve(__dirname, "../.."), "data/generated");
  const label = path.basename(dataDir);
  const cases = collect(loadSeason(), label);
  if (cases.cases.length === 0) throw new Error(`${label}: no goalkeeper rows with per-match saves`);
  const out = process.env.BACKTEST_CASE_OUT;
  if (!out) throw new Error("set BACKTEST_CASE_OUT to save the read-only season cases for pooling");
  writeFileSync(out, JSON.stringify(cases));
  console.log(`${label}: collected ${cases.cases.length} GK appearances; parity passed on ${cases.parityRows} rows`);
  console.log(`case data written to ${out}`);
}

main();
