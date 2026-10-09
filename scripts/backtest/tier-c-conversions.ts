import { readFileSync } from "node:fs";
import path from "node:path";
import type { Position } from "@/types/player";
import { loadSeason, strengthsBefore, formBefore, playerAt } from "./season";
import {
  ASSIST_CONVERSION,
  expectedPoints,
  GOAL_CONVERSION,
  playerRates,
} from "./xp";
import { BASELINE } from "./variants";

const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];
const ONE: Record<Position, number> = { GK: 1, DEF: 1, MID: 1, FWD: 1 };
const FIRST_PARITY_GAMEWEEK = 6;
const TRAINING_SEASONS = ["2023-24", "2024-25"];
const HELD_OUT = ["2024-25", "2025-26"];
const BOOTSTRAPS = 4000;

interface Observation {
  season: string;
  gameweek: number;
  position: Position;
  actual: number;
  base: number;
  goalUnit: number;
  assistUnit: number;
  eventXg: number;
  eventXa: number;
  goals: number;
  assists: number;
}

interface SeasonRows { season: string; rows: Observation[] }
interface Factors { goal: Record<Position, number>; assist: Record<Position, number> }
type Arm = "shipped" | "neutral" | "pooled fit";

const SHIPPED: Factors = { goal: GOAL_CONVERSION, assist: ASSIST_CONVERSION };
const NEUTRAL: Factors = { goal: ONE, assist: ONE };
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;

function collect(): SeasonRows {
  const season = loadSeason();
  const seasonName = path.basename(process.env.BACKTEST_DATA_DIR ?? "");
  if (!seasonName) throw new Error("BACKTEST_DATA_DIR must name a prepared season");
  const rows: Observation[] = [];
  let largestBaselineGap = 0;

  for (let gameweek = FIRST_PARITY_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(season, gameweek);
    const fixtureById = new Map((season.fixturesByGameweek.get(gameweek) ?? []).map((fixture) => [fixture.fixtureId, fixture]));
    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = fixtureById.get(row.fixtureId);
      if (!fixture) continue;
      const player = playerAt(season, row.historicalPlayerId, gameweek, fixture, row.wasHome);
      if (!player) continue;
      const form = formBefore(season, row.historicalPlayerId, gameweek);
      const rates = playerRates(player, form, gameweek, undefined, strengths);
      const neutral = expectedPoints(
        player, player.fixtures[0], row.minutes, rates, strengths, BASELINE,
        undefined, true, ONE, ONE,
      );
      const shipped = expectedPoints(player, player.fixtures[0], row.minutes, rates, strengths, BASELINE);
      const base = neutral.total - neutral.goals - neutral.assists;
      const reconstructed = base
        + GOAL_CONVERSION[player.position] * neutral.goals
        + ASSIST_CONVERSION[player.position] * neutral.assists;
      largestBaselineGap = Math.max(largestBaselineGap, Math.abs(reconstructed - shipped.total));
      rows.push({
        season: seasonName,
        gameweek,
        position: player.position,
        actual: row.totalPoints,
        base,
        goalUnit: neutral.goals,
        assistUnit: neutral.assists,
        eventXg: row.expectedGoals ?? 0,
        eventXa: row.expectedAssists ?? 0,
        goals: row.goals ?? 0,
        assists: row.assists ?? 0,
      });
    }
  }

  if (rows.length === 0) throw new Error("No played rows collected for " + seasonName);
  if (largestBaselineGap > 1e-9) {
    throw new Error("Neutral components do not reconstruct the shipped harness baseline: " + largestBaselineGap);
  }
  console.error(seasonName + ": " + rows.length + " played rows, shipped reconstruction gap " + largestBaselineGap.toExponential(2));
  return { season: seasonName, rows };
}

function fitOne(rows: Observation[], kind: "goal" | "assist", position: Position): number {
  // Keep goalkeeper factors neutral: no goals and too few assists identify a stable slope.
  if (position === "GK") return 1;
  let xy = 0;
  let xx = 0;
  for (const row of rows) {
    if (row.position !== position) continue;
    const x = kind === "goal" ? row.eventXg : row.eventXa;
    const y = kind === "goal" ? row.goals : row.assists;
    xy += x * y;
    xx += x * x;
  }
  return xx > 1e-12 ? xy / xx : 1;
}

function fit(rows: Observation[]): Factors {
  return {
    goal: Object.fromEntries(POSITIONS.map((position) => [position, fitOne(rows, "goal", position)])) as Record<Position, number>,
    assist: Object.fromEntries(POSITIONS.map((position) => [position, fitOne(rows, "assist", position)])) as Record<Position, number>,
  };
}

function error(row: Observation, factors: Factors): number {
  return row.base + factors.goal[row.position] * row.goalUnit
    + factors.assist[row.position] * row.assistUnit - row.actual;
}

function rmse(rows: Observation[], factorsFor: (row: Observation) => Factors): number {
  return Math.sqrt(mean(rows.map((row) => error(row, factorsFor(row)) ** 2)));
}

function bias(rows: Observation[], factorsFor: (row: Observation) => Factors): number {
  return mean(rows.map((row) => error(row, factorsFor(row))));
}

function factorsFor(arm: Arm, fitted: Map<string, Factors>): (row: Observation) => Factors {
  if (arm === "shipped") return () => SHIPPED;
  if (arm === "neutral") return () => NEUTRAL;
  return (row) => {
    const value = fitted.get(row.season);
    if (!value) throw new Error("No walk-forward fit for " + row.season);
    return value;
  };
}

function makeClusterSums(
  rows: Observation[],
  fitted: Map<string, Factors>,
): Map<number, { count: number; errors: Record<Arm, number> }> {
  const result = new Map<number, { count: number; errors: Record<Arm, number> }>();
  for (const row of rows) {
    let value = result.get(row.gameweek);
    if (!value) {
      value = { count: 0, errors: { shipped: 0, neutral: 0, "pooled fit": 0 } };
      result.set(row.gameweek, value);
    }
    value.count += 1;
    for (const arm of ["shipped", "neutral", "pooled fit"] as const) {
      value.errors[arm] += error(row, factorsFor(arm, fitted)(row)) ** 2;
    }
  }
  return result;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.floor(p * (sorted.length - 1))];
}

function bootstrapDelta(evaluations: SeasonRows[], arm: Exclude<Arm, "shipped">, fitted: Map<string, Factors>): [number, number] {
  const clusters = evaluations.map((evaluation) => makeClusterSums(evaluation.rows, fitted));
  let seed = 20261008;
  const randomIndex = (length: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % length;
  };
  const deltas: number[] = [];
  for (let sample = 0; sample < BOOTSTRAPS; sample += 1) {
    let shippedSse = 0;
    let armSse = 0;
    let count = 0;
    for (const seasonClusters of clusters) {
      const gameweeks = [...seasonClusters.keys()];
      for (let draw = 0; draw < gameweeks.length; draw += 1) {
        const cluster = seasonClusters.get(gameweeks[randomIndex(gameweeks.length)])!;
        shippedSse += cluster.errors.shipped;
        armSse += cluster.errors[arm];
        count += cluster.count;
      }
    }
    deltas.push(Math.sqrt(armSse / count) - Math.sqrt(shippedSse / count));
  }
  deltas.sort((a, b) => a - b);
  return [percentile(deltas, 0.025), percentile(deltas, 0.975)];
}

function score(files: string[]): void {
  if (files.length !== 3) throw new Error("score requires row files for 2023-24, 2024-25, and 2025-26");
  const data = files.map((file) => JSON.parse(readFileSync(path.resolve(file), "utf8")) as SeasonRows);
  const expected = ["2023-24", "2024-25", "2025-26"];
  if (data.some((item, index) => item.season !== expected[index])) {
    throw new Error("Expected season files in order: " + expected.join(", "));
  }
  if (data.some((item) => item.season === "2022-23")) throw new Error("Incomplete 2022-23 must not enter conversion fitting");
  const bySeason = new Map(data.map((item) => [item.season, item]));
  const evaluations: SeasonRows[] = [];
  const fitted = new Map<string, Factors>();

  for (const season of HELD_OUT) {
    const priorSeasons = TRAINING_SEASONS.filter((training) => training < season);
    const trainingRows = priorSeasons.flatMap((training) => bySeason.get(training)!.rows);
    const evaluation = bySeason.get(season)!;
    if (trainingRows.length === 0 || evaluation.rows.length === 0) {
      throw new Error("Missing training or held-out observations for " + season);
    }
    const model = fit(trainingRows);
    fitted.set(season, model);
    evaluations.push(evaluation);
    const support = POSITIONS.map((position) => {
      const rows = trainingRows.filter((row) => row.position === position);
      const goalsXg = rows.reduce((sum, row) => sum + row.eventXg, 0);
      const goals = rows.reduce((sum, row) => sum + row.goals, 0);
      const assistsXa = rows.reduce((sum, row) => sum + row.eventXa, 0);
      const assists = rows.reduce((sum, row) => sum + row.assists, 0);
      return position + " " + goals + "/" + goalsXg.toFixed(1) + " G, " + assists + "/" + assistsXa.toFixed(1) + " A";
    });
    console.log("fit " + season + " from " + priorSeasons.join(" + ") + ": "
      + trainingRows.length + " earlier appearances; evaluate " + evaluation.rows.length
      + " appearances across " + new Set(evaluation.rows.map((row) => row.gameweek)).size + " GWs");
    console.log("  fitted goals: " + POSITIONS.map((position) => position + " " + model.goal[position].toFixed(3)).join(", "));
    console.log("  fitted assists: " + POSITIONS.map((position) => position + " " + model.assist[position].toFixed(3)).join(", "));
    console.log("  train observed xG / goals, xA / assists: " + support.join("; "));
  }

  const arms: Arm[] = ["shipped", "neutral", "pooled fit"];
  const report = (label: string, rows: Observation[], evals: SeasonRows[]) => {
    const factorFor = new Map<string, Factors>(fitted);
    const clusterCount = evals.reduce((sum, evaluation) => sum
      + new Set(evaluation.rows.map((row) => row.gameweek)).size, 0);
    console.log("\n" + label + ": " + rows.length + " appearances, " + clusterCount + " season-GW clusters");
    console.log("arm          RMSE      bias      delta vs shipped [paired GW bootstrap 95% CI]");
    for (const arm of arms) {
      const value = rmse(rows, factorsFor(arm, factorFor));
      const meanError = bias(rows, factorsFor(arm, factorFor));
      if (arm === "shipped") {
        console.log(arm.padEnd(12) + value.toFixed(4) + "   " + (meanError >= 0 ? "+" : "") + meanError.toFixed(4) + "   reference");
      } else {
        const [low, high] = bootstrapDelta(evals, arm, factorFor);
        const delta = value - rmse(rows, factorsFor("shipped", factorFor));
        console.log(arm.padEnd(12) + value.toFixed(4) + "   " + (meanError >= 0 ? "+" : "") + meanError.toFixed(4)
          + "   " + (delta >= 0 ? "+" : "") + delta.toFixed(4) + " [" + low.toFixed(4) + ", " + high.toFixed(4) + "]");
      }
    }
  };

  console.log("Baseline factors from scripts/backtest/xp.ts; validate.ts passed against projectPlayer() at HEAD.");
  console.log("shipped goals: " + POSITIONS.map((position) => position + " " + SHIPPED.goal[position]).join(", "));
  console.log("shipped assists: " + POSITIONS.map((position) => position + " " + SHIPPED.assist[position]).join(", "));
  console.log("neutral factors: 1.000 for every position");
  console.log("2022-23 excluded from fitting and evaluation because xG starts at GW16.");

  for (const evaluation of evaluations) {
    report(evaluation.season, evaluation.rows, [evaluation]);
  }
  report("pooled held-out", evaluations.flatMap((evaluation) => evaluation.rows), evaluations);
}

const mode = process.argv[2];
if (mode === "collect") {
  process.stdout.write(JSON.stringify(collect()));
} else if (mode === "score") {
  score(process.argv.slice(3));
} else {
  throw new Error("Use collect with BACKTEST_DATA_DIR set, or score with the three clean-season row files");
}
