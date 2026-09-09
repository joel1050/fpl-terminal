/**
 * Should the attack multiplier read team strength off Elo?
 *
 * `team-level.ts` records Elo as rejected, but every arm it ran with
 * `eloWeight > 0` also carried `levelScale: 1.69` - a widening its own arm 1
 * found harmful on its own. The two changes were never separated, so Elo has
 * not been scored at the shipped level scale. That is what this script does.
 *
 * Four readings of the same idea, plus the clamp control that turned out to
 * matter most:
 *
 *   A  the shipped strengths
 *   B  Elo level at the measured goal-scale slope, xG lean kept - exactly the
 *      transform `deriveCleanSheetStrengths` already ships for clean sheets,
 *      applied to the attack side too
 *   C  Elo's ordering, held to the spread the shipped strengths already have
 *   D  Elo alone, no lean, to price what the lean is worth
 *   A' / B'  the same with the ratio clamp opened, because B roughly doubles
 *      how often the clamp binds and a clamped arm is not a fair test of the
 *      scale underneath it
 *
 * Scored on team xG, the instrument the README names for the attack side, and
 * on the calibration slope of actual xG against predicted. Walk-forward: every
 * strength is fitted only on gameweeks before the one being scored.
 *
 * These are not ClubElo's published ratings - `elo-history.ts` computes them
 * from the corpus, since ClubElo serves no dated history - so a verdict here is
 * a claim about the *transformation*, not about ClubElo's own numbers.
 *
 *   npx tsx scripts/backtest/elo-history.ts <seasonsRoot>
 *   BACKTEST_DATA_DIR=<seasonsRoot>/2025-26 npx tsx scripts/backtest/elo-strength-arms.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TeamStrength } from "@/types/projection";
import { loadSeason, strengthsBefore } from "./season";
import { CLEAN_SHEET_SKEW_WEIGHT, ELO_LEVEL_SLOPE } from "@/lib/projections/cleanSheetStrength";
import {
  AWAY_ATTACK_MULTIPLIER,
  HOME_ATTACK_MULTIPLIER,
  LEAGUE_MEAN_XG,
  continuousDifficultyMultiplier,
} from "@/lib/projections/fixtureAdjustment";

/** Before this the in-season fit has too little to say for the arms to differ. */
const FIRST_GAMEWEEK = 6;
const BOOTSTRAP_DRAWS = 3000;
const SHIPPED_RATIO_CLAMP = [0.7, 1.35] as const;
const SHIPPED_MULTIPLIER_CLAMP = [0.55, 1.6] as const;
const OPEN = [0.001, 1000] as const;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

interface EloRow {
  fixtureId: number;
  homeElo: number;
  awayElo: number;
  leagueMeanElo: number;
  leagueSdElo: number;
}

const dataDir = process.env.BACKTEST_DATA_DIR ?? path.join(path.resolve(__dirname, "../.."), "data/generated");
const eloPath = path.join(dataDir, "backtest-elo.json");
if (!existsSync(eloPath)) {
  console.error(`no backtest-elo.json in ${dataDir}; run scripts/backtest/elo-history.ts first`);
  process.exit(1);
}
const eloByFixture = new Map(
  (JSON.parse(readFileSync(eloPath, "utf8")) as EloRow[]).map((row) => [row.fixtureId, row]),
);

interface Rates { attack: number; defence: number }

interface Arm {
  name: string;
  ratioClamp: readonly [number, number];
  multiplierClamp: readonly [number, number];
  rates(
    strengths: Record<number, TeamStrength>,
    elo: ReadonlyMap<number, number>,
    meanElo: number,
    sdElo: number,
  ): Map<number, Rates>;
}

const averageAttack = (s: TeamStrength) => (s.attackHome + s.attackAway) / 2;
const averageDefence = (s: TeamStrength) => (s.defenceHome + s.defenceAway) / 2;
const leanOf = (s: TeamStrength) => Math.log(averageAttack(s)) - Math.log(averageDefence(s));
const levelOf = (s: TeamStrength) => Math.log(averageAttack(s)) + Math.log(averageDefence(s));

const shippedRates: Arm["rates"] = (strengths) =>
  new Map(Object.entries(strengths).map(([id, s]) => [Number(id), { attack: averageAttack(s), defence: averageDefence(s) }]));

/** Level from Elo on the goal scale, lean from xG. The clean-sheet transform. */
const measuredRates: Arm["rates"] = (strengths, elo, meanElo) => {
  const out = new Map<number, Rates>();
  for (const [key, s] of Object.entries(strengths)) {
    const id = Number(key);
    const rating = elo.get(id);
    if (rating === undefined) continue;
    const level = ELO_LEVEL_SLOPE * (rating - meanElo);
    const skew = CLEAN_SHEET_SKEW_WEIGHT * leanOf(s);
    out.set(id, { attack: Math.exp((level + skew) / 2), defence: Math.exp((level - skew) / 2) });
  }
  return out;
};

/** Elo re-orders the teams but does not widen them. */
const matchedRates: Arm["rates"] = (strengths, elo, meanElo, sdElo) => {
  const ids = Object.keys(strengths).map(Number).filter((id) => elo.has(id));
  const levels = ids.map((id) => levelOf(strengths[id]));
  const meanLevel = mean(levels);
  const sdLevel = Math.sqrt(mean(levels.map((level) => (level - meanLevel) ** 2)));
  const out = new Map<number, Rates>();
  for (const id of ids) {
    const level = ((elo.get(id)! - meanElo) / sdElo) * sdLevel;
    const skew = CLEAN_SHEET_SKEW_WEIGHT * leanOf(strengths[id]);
    out.set(id, { attack: Math.exp((level + skew) / 2), defence: Math.exp((level - skew) / 2) });
  }
  return out;
};

const levelOnlyRates: Arm["rates"] = (strengths, elo, meanElo) => {
  const out = new Map<number, Rates>();
  for (const key of Object.keys(strengths)) {
    const id = Number(key);
    const rating = elo.get(id);
    if (rating === undefined) continue;
    const level = ELO_LEVEL_SLOPE * (rating - meanElo);
    out.set(id, { attack: Math.exp(level / 2), defence: Math.exp(level / 2) });
  }
  return out;
};

const shipped = { ratioClamp: SHIPPED_RATIO_CLAMP, multiplierClamp: SHIPPED_MULTIPLIER_CLAMP };
const opened = { ratioClamp: OPEN, multiplierClamp: OPEN };
const ARMS: Arm[] = [
  { name: "A  shipped strengths", ...shipped, rates: shippedRates },
  { name: "B  Elo level (measured slope) + xG lean", ...shipped, rates: measuredRates },
  { name: "C  Elo level (matched to shipped spread) + xG lean", ...shipped, rates: matchedRates },
  { name: "D  Elo level only, no lean", ...shipped, rates: levelOnlyRates },
  { name: "A' shipped, clamps opened", ...opened, rates: shippedRates },
  { name: "B' Elo measured slope, clamps opened", ...opened, rates: measuredRates },
];

interface Row { gameweek: number; predicted: number[]; bound: boolean[]; actual: number }

const season = loadSeason();
const rows: Row[] = [];
const strengthCache = new Map<number, Record<number, TeamStrength>>();

for (const fixture of season.fixtures) {
  if (fixture.gameweek < FIRST_GAMEWEEK) continue;
  const elo = eloByFixture.get(fixture.fixtureId);
  if (!elo) continue;
  if (!strengthCache.has(fixture.gameweek)) {
    strengthCache.set(fixture.gameweek, strengthsBefore(season, fixture.gameweek));
  }
  const strengths = strengthCache.get(fixture.gameweek)!;
  // Every side's pre-match rating this gameweek, so the mean is league-wide.
  const ratings = new Map<number, number>();
  for (const other of season.fixturesByGameweek.get(fixture.gameweek) ?? []) {
    const row = eloByFixture.get(other.fixtureId);
    if (!row) continue;
    ratings.set(other.homeTeamId, row.homeElo);
    ratings.set(other.awayTeamId, row.awayElo);
  }
  const armRates = ARMS.map((arm) => arm.rates(strengths, ratings, elo.leagueMeanElo, elo.leagueSdElo));
  for (const isHome of [true, false]) {
    const teamId = isHome ? fixture.homeTeamId : fixture.awayTeamId;
    const opponentId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
    const base = continuousDifficultyMultiplier((isHome ? fixture.homeDifficulty : fixture.awayDifficulty) ?? 3);
    const venue = isHome ? HOME_ATTACK_MULTIPLIER : AWAY_ATTACK_MULTIPLIER;
    const predicted: number[] = [];
    const bound: boolean[] = [];
    for (let i = 0; i < ARMS.length; i += 1) {
      const own = armRates[i].get(teamId);
      const opponent = armRates[i].get(opponentId);
      if (!own || !opponent) { predicted.push(Number.NaN); bound.push(false); continue; }
      const ratio = own.attack / opponent.defence;
      const [low, high] = ARMS[i].ratioClamp;
      bound.push(ratio < low || ratio > high);
      const multiplier = clamp(
        base * venue * clamp(ratio, low, high),
        ARMS[i].multiplierClamp[0],
        ARMS[i].multiplierClamp[1],
      );
      predicted.push(LEAGUE_MEAN_XG * multiplier);
    }
    if (predicted.some((value) => !Number.isFinite(value))) continue;
    rows.push({
      gameweek: fixture.gameweek,
      predicted,
      bound,
      actual: Math.max(isHome ? fixture.homeXg : fixture.awayXg, 0.05),
    });
  }
}

const rmse = (sample: readonly Row[], arm: number) =>
  Math.sqrt(mean(sample.map((row) => (row.predicted[arm] - row.actual) ** 2)));

function calibrationSlope(sample: readonly Row[], arm: number): number {
  const x = sample.map((row) => row.predicted[arm]);
  const y = sample.map((row) => row.actual);
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

/**
 * Paired against `baseline`, resampled by gameweek cluster like the rest of the
 * suite. B' has to be paired against A', not A: against A it would bundle the
 * change of scale together with opening the clamps, and only their sum would be
 * readable.
 */
function pairedInterval(arm: number, baseline: number): [number, number] {
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
    draws.push(rmse(sample, arm) - rmse(sample, baseline));
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(draws.length * 0.025)], draws[Math.floor(draws.length * 0.975)]];
}

const signed = (value: number, digits = 5) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

console.log(`n = ${rows.length} team-fixtures, GW${FIRST_GAMEWEEK}-38, walk-forward`);
console.log(`data: ${dataDir}\n`);
/** Each arm is compared against the arm sharing its clamp settings. */
const baselineFor = (arm: number) => (ARMS[arm].ratioClamp === OPEN ? 4 : 0);

console.log("arm                                                  RMSE     dRMSE  95% CI                  vs   slope  multiplier  ratio clamp");
for (let arm = 0; arm < ARMS.length; arm += 1) {
  const baseline = baselineFor(arm);
  const error = rmse(rows, arm);
  const delta = error - rmse(rows, baseline);
  const ci = arm === baseline ? null : pairedInterval(arm, baseline);
  const multipliers = rows.map((row) => row.predicted[arm] / LEAGUE_MEAN_XG);
  const binds = (100 * rows.filter((row) => row.bound[arm]).length) / rows.length;
  console.log(
    ARMS[arm].name.padEnd(52)
    + error.toFixed(5).padStart(7)
    + (arm === baseline ? "         —" : signed(delta).padStart(10))
    + (ci ? `  [${signed(ci[0])}, ${signed(ci[1])}]` : "                        ").padEnd(26)
    + (arm === baseline ? "  — " : `  ${ARMS[baseline].name.slice(0, 2)}`)
    + calibrationSlope(rows, arm).toFixed(3).padStart(6)
    + `  ${Math.min(...multipliers).toFixed(2)}-${Math.max(...multipliers).toFixed(2)}`.padEnd(13)
    + `${binds.toFixed(1)}%`,
  );
}
