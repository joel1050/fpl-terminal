/**
 * Is the attack multiplier calibrated?
 *
 * Every other script here asks which arm predicts best. This one asks a
 * different question: when the model says a fixture is worth `m` times a
 * neutral one, does the team actually produce `m` times the league's mean xG?
 * An arm can win on RMSE and still be systematically over- or under-confident,
 * and nothing in the suite had checked that.
 *
 * Two readings, because they answer different halves of it:
 *
 *   - the *level* slope regresses actual team xG on `LEAGUE_MEAN_XG * m`. A
 *     slope below 1 means the multiplier spreads fixtures further apart than
 *     the outcomes do.
 *   - the *within-team* slope demeans both sides by team first, which removes
 *     team quality and leaves only the swing the fixture is supposed to add.
 *
 * Then the multiplier is taken apart. It is `base * venue * (ownAttack /
 * opponentDefence)`, so in a log regression on actual xG each term should carry
 * a coefficient of 1. Above 1 means the model underweights that term; below 1
 * means it leans on it too hard.
 *
 * Walk-forward throughout: the strengths used for a gameweek are fitted only on
 * gameweeks before it. `validate.ts` gates `projectPlayer()`; nothing here calls
 * it, so its failure at HEAD does not apply.
 *
 *   npx tsx scripts/backtest/multiplier-calibration.ts
 */
import { loadSeason, strengthsBefore, type Season } from "./season";
import {
  calculateFixtureAdjustment,
  continuousDifficultyMultiplier,
  AWAY_ATTACK_MULTIPLIER,
  HOME_ATTACK_MULTIPLIER,
  LEAGUE_MEAN_XG,
} from "@/lib/projections/fixtureAdjustment";
import type { PlayerFixture } from "@/types/player";

const BOOTSTRAP_DRAWS = 2000;
const NEUTRAL_DIFFICULTY = 3;

interface Row {
  gameweek: number;
  teamId: number;
  multiplier: number;
  xg: number;
  logOwnAttack: number;
  logOpponentDefence: number;
  logBase: number;
  logVenue: number;
  logXg: number;
}

/** One row per side of every fixture, with the strengths known before kickoff. */
function buildRows(season: Season, useBase: boolean): Row[] {
  const rows: Row[] = [];
  const byGameweek = new Map<number, ReturnType<typeof strengthsBefore>>();
  for (const fixture of season.fixtures) {
    if (!byGameweek.has(fixture.gameweek)) {
      byGameweek.set(fixture.gameweek, strengthsBefore(season, fixture.gameweek));
    }
    const strengths = byGameweek.get(fixture.gameweek)!;
    for (const isHome of [true, false]) {
      const teamId = isHome ? fixture.homeTeamId : fixture.awayTeamId;
      const opponentId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
      const own = strengths[teamId];
      const opponent = strengths[opponentId];
      if (!own || !opponent) continue;
      const published = (isHome ? fixture.homeDifficulty : fixture.awayDifficulty) ?? NEUTRAL_DIFFICULTY;
      const difficulty = useBase ? published : NEUTRAL_DIFFICULTY;
      const playerFixture: PlayerFixture = {
        gameweek: fixture.gameweek,
        opponentTeamId: opponentId,
        opponentShortName: "",
        isHome,
        difficulty,
      };
      const adjustment = calculateFixtureAdjustment(playerFixture, { ownTeam: own, opponentTeam: opponent });
      const xg = Math.max(isHome ? fixture.homeXg : fixture.awayXg, 0.05);
      rows.push({
        gameweek: fixture.gameweek,
        teamId,
        multiplier: adjustment.attackMultiplier,
        xg,
        logOwnAttack: Math.log(own.attackHome),
        logOpponentDefence: -Math.log(opponent.defenceHome),
        logBase: Math.log(continuousDifficultyMultiplier(difficulty)),
        logVenue: Math.log(isHome ? HOME_ATTACK_MULTIPLIER : AWAY_ATTACK_MULTIPLIER),
        logXg: Math.log(xg),
      });
    }
  }
  return rows;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Slope of y on x with an intercept. */
function slope(x: readonly number[], y: readonly number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < x.length; i += 1) {
    covariance += (x[i] - mx) * (y[i] - my);
    variance += (x[i] - mx) ** 2;
  }
  return covariance / variance;
}

/** Least squares with an intercept, by Gauss-Jordan on the normal equations. */
function fit(design: readonly (readonly number[])[], y: readonly number[]): number[] {
  const width = design[0].length + 1;
  const normal: number[][] = Array.from({ length: width }, () => new Array(width).fill(0));
  const target = new Array(width).fill(0);
  for (let i = 0; i < design.length; i += 1) {
    const row = [1, ...design[i]];
    for (let r = 0; r < width; r += 1) {
      target[r] += row[r] * y[i];
      for (let c = 0; c < width; c += 1) normal[r][c] += row[r] * row[c];
    }
  }
  for (let c = 0; c < width; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < width; r += 1) {
      if (Math.abs(normal[r][c]) > Math.abs(normal[pivot][c])) pivot = r;
    }
    [normal[c], normal[pivot]] = [normal[pivot], normal[c]];
    [target[c], target[pivot]] = [target[pivot], target[c]];
    for (let r = 0; r < width; r += 1) {
      if (r === c) continue;
      const factor = normal[r][c] / normal[c][c];
      for (let j = c; j < width; j += 1) normal[r][j] -= factor * normal[c][j];
      target[r] -= factor * target[c];
    }
  }
  return target.map((value, index) => value / normal[index][index]);
}

/**
 * Paired bootstrap over gameweek clusters. Rows inside one gameweek share
 * opponents and a strength table, so resampling rows would understate the
 * standard error - the same convention the rest of the suite uses.
 */
function interval(rows: readonly Row[], statistic: (sample: Row[]) => number): [number, number] {
  const byGameweek = new Map<number, Row[]>();
  for (const row of rows) {
    (byGameweek.get(row.gameweek) ?? byGameweek.set(row.gameweek, []).get(row.gameweek)!).push(row);
  }
  const gameweeks = [...byGameweek.keys()];
  const draws: number[] = [];
  for (let draw = 0; draw < BOOTSTRAP_DRAWS; draw += 1) {
    const sample: Row[] = [];
    for (let i = 0; i < gameweeks.length; i += 1) {
      sample.push(...byGameweek.get(gameweeks[Math.floor(Math.random() * gameweeks.length)])!);
    }
    const value = statistic(sample);
    if (Number.isFinite(value)) draws.push(value);
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(draws.length * 0.025)], draws[Math.floor(draws.length * 0.975)]];
}

const levelSlope = (rows: Row[]): number =>
  slope(rows.map((row) => LEAGUE_MEAN_XG * row.multiplier), rows.map((row) => row.xg));

/** Team quality removed, so only the fixture swing is left to score. */
function withinTeamSlope(rows: Row[]): number {
  const byTeam = new Map<number, Row[]>();
  for (const row of rows) {
    (byTeam.get(row.teamId) ?? byTeam.set(row.teamId, []).get(row.teamId)!).push(row);
  }
  const x: number[] = [];
  const y: number[] = [];
  for (const list of byTeam.values()) {
    const meanMultiplier = mean(list.map((row) => Math.log(row.multiplier)));
    const meanXg = mean(list.map((row) => row.logXg));
    for (const row of list) {
      x.push(Math.log(row.multiplier) - meanMultiplier);
      y.push(row.logXg - meanXg);
    }
  }
  return slope(x, y);
}

function verdict(low: number, high: number): string {
  if (low > 1) return "too small";
  if (high < 1) return "too large";
  return "unresolved";
}

function reportSlopes(label: string, rows: Row[]): void {
  console.log(`\n### ${label}  (n = ${rows.length} team-fixtures)`);
  const sorted = [...rows].sort((a, b) => a.multiplier - b.multiplier);
  const size = Math.floor(sorted.length / 5);
  console.log("  bucket              n   mean m   predicted   actual   actual/predicted");
  for (let i = 0; i < 5; i += 1) {
    const slice = sorted.slice(i * size, i === 4 ? sorted.length : (i + 1) * size);
    const m = mean(slice.map((row) => row.multiplier));
    const actual = mean(slice.map((row) => row.xg));
    const predicted = LEAGUE_MEAN_XG * m;
    console.log(
      `  ${i + 1} (${slice[0].multiplier.toFixed(2)}-${slice[slice.length - 1].multiplier.toFixed(2)})`.padEnd(20)
      + String(slice.length).padStart(3)
      + m.toFixed(3).padStart(9)
      + predicted.toFixed(3).padStart(12)
      + actual.toFixed(3).padStart(9)
      + (actual / predicted).toFixed(3).padStart(19),
    );
  }
  for (const [name, statistic] of [["level", levelSlope], ["within-team", withinTeamSlope]] as const) {
    const point = statistic(rows);
    const [low, high] = interval(rows, statistic);
    console.log(
      `  ${name.padEnd(12)} slope ${point.toFixed(3).padStart(6)}  95% CI [${low.toFixed(3)}, ${high.toFixed(3)}]`
      + `  spread is ${verdict(low, high) === "too small" ? "too small" : verdict(low, high) === "too large" ? "too large" : "unresolved"}`,
    );
  }
}

type Term = "logOwnAttack" | "logOpponentDefence" | "logBase" | "logVenue";

function reportTerms(label: string, rows: Row[], terms: readonly Term[]): void {
  const design = rows.map((row) => terms.map((term) => row[term]));
  const coefficients = fit(design, rows.map((row) => row.logXg));
  console.log(`\n### ${label}  (n = ${rows.length})`);
  terms.forEach((term, index) => {
    const [low, high] = interval(rows, (sample) =>
      fit(sample.map((row) => terms.map((t) => row[t])), sample.map((row) => row.logXg))[index + 1]);
    console.log(
      `  ${term.padEnd(20)} ${coefficients[index + 1].toFixed(3).padStart(7)}`
      + `  95% CI [${low.toFixed(3)}, ${high.toFixed(3)}]  weight is ${verdict(low, high) === "too small" ? "too small" : verdict(low, high) === "too large" ? "too large" : "unresolved"}`,
    );
  });
}

const season = loadSeason();
const phases: [string, (row: Row) => boolean][] = [
  ["all gameweeks", () => true],
  ["GW1-9, preseason prior dominates", (row) => row.gameweek <= 9],
  ["GW10-24", (row) => row.gameweek >= 10 && row.gameweek <= 24],
  ["GW25-38, in-season fit dominates", (row) => row.gameweek >= 25],
];

for (const useBase of [false, true]) {
  const rows = buildRows(season, useBase);
  console.log(`\n${"=".repeat(74)}`);
  console.log(useBase ? "SHIPPED SHAPE: base x venue x strength ratio" : "WITHOUT THE FDR BASE TERM: venue x strength ratio");
  console.log("=".repeat(74));
  for (const [label, keep] of phases) reportSlopes(label, rows.filter(keep));
}

const rows = buildRows(season, true);
console.log(`\n${"=".repeat(74)}`);
console.log("EACH TERM SCORED SEPARATELY  (a calibrated term carries a coefficient of 1)");
console.log("=".repeat(74));
reportTerms("All four terms, all gameweeks", rows, ["logOwnAttack", "logOpponentDefence", "logBase", "logVenue"]);
reportTerms("Strength terms only, all gameweeks", rows, ["logOwnAttack", "logOpponentDefence"]);
for (const [label, keep] of phases.slice(1)) {
  reportTerms(`Strength terms only, ${label}`, rows.filter(keep), ["logOwnAttack", "logOpponentDefence"]);
}
