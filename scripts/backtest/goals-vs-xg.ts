/**
 * Should the in-season team form signal be goals instead of, or as well as, xG?
 *
 * `calculations.md` §3.3 records goals as tested and beaten - "goals are
 * dominated by finishing variance" - but no script in this directory defines a
 * goals arm, so the claim is prose with nothing behind it, and it predates the
 * parity repair of `316d270`. This rebuilds it.
 *
 * The arms change one thing: what `applyInSeasonForm` is fed. Production feeds
 * it each team's xG for and against; an arm feeds a convex blend
 *
 *   signal = goalsWeight * goals + (1 - goalsWeight) * xG
 *
 * so `goalsWeight = 0` is production and `goalsWeight = 1` is the old rejected
 * arm. Everything downstream is untouched, which means the blend is also the
 * only arm the old test never ran: it pitted goals *against* xG rather than
 * mixing them.
 *
 * The decay and the prior weight are swept on the same axis, because a noisier
 * signal ought to want a longer memory and a heavier prior - if goals help at
 * all, that is where it would show.
 *
 * The clean-sheet read is the shipped rated path, not the 5x5 fallback: team
 * strengths are re-levelled against walk-forward Elo exactly as
 * `deriveCleanSheetStrengths` does, then read as a negative binomial by
 * `cleanSheetFromRates`. Scoring is against realized clean sheets, where the
 * power is; §7.4 records that the bookmaker market has misled this project
 * twice, so it is not used.
 *
 * Walk-forward throughout: every strength is fitted only on gameweeks before
 * the one being scored.
 *
 *   BACKTEST_MULTI_DATA_DIR=$ROOT npx tsx scripts/backtest/prepare-seasons.ts
 *   BACKTEST_MULTI_DATA_DIR=$ROOT npx tsx scripts/backtest/elo-history.ts
 *   BACKTEST_DATA_DIR=$ROOT/2024-25 npx tsx scripts/backtest/goals-vs-xg.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TeamStrength } from "@/types/projection";
import { applyInSeasonForm, type TeamMatchXG } from "@/lib/historical/inSeasonForm";
import {
  CLEAN_SHEET_SKEW_WEIGHT,
  ELO_LEVEL_SLOPE,
  type CleanSheetStrength,
} from "@/lib/projections/cleanSheetStrength";
import {
  AWAY_ATTACK_MULTIPLIER,
  CLEAN_SHEET_DISPERSION,
  HOME_ATTACK_MULTIPLIER,
  LEAGUE_MEAN_XG,
  cleanSheetFromRates,
} from "@/lib/projections/fixtureAdjustment";
import { loadSeason, formBefore, playerAt, type Fixture, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";

/** Before this the in-season fit has too little to say for the arms to differ. */
const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 4000;
const SHIPPED_DECAY = 0.9;
const SHIPPED_PRIOR_WEIGHT = 12;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

// ---------------------------------------------------------------------------
// Walk-forward Elo, the level the clean-sheet read is built on.
// ---------------------------------------------------------------------------

interface EloRow {
  fixtureId: number;
  homeElo: number;
  awayElo: number;
  leagueMeanElo: number;
}

const dataDir = process.env.BACKTEST_DATA_DIR ?? path.join(path.resolve(__dirname, "../.."), "data/generated");
const eloPath = path.join(dataDir, "backtest-elo.json");
/** Pooling reads dumped cases only, so it needs no season corpus and no ratings. */
const POOLING = process.argv.includes("--pool");
if (!POOLING && !existsSync(eloPath)) {
  console.error(`no backtest-elo.json in ${dataDir}; run scripts/backtest/elo-history.ts first`);
  process.exit(1);
}
const eloRows = POOLING || !existsSync(eloPath)
  ? []
  : (JSON.parse(readFileSync(eloPath, "utf8")) as EloRow[]);
const eloByFixture = new Map(eloRows.map((row) => [row.fixtureId, row]));

/**
 * Each team's pre-match Elo as of `gameweek`, taken from its most recent
 * earlier fixture. Reading the rating off the fixture being scored would leak
 * that fixture's own result into the prediction of it.
 */
function eloBefore(season: Season, gameweek: number): { byTeam: Map<number, number>; leagueMean: number } {
  const byTeam = new Map<number, number>();
  let leagueMean = 0;
  const earlier = season.fixtures
    .filter((fixture) => fixture.gameweek < gameweek && eloByFixture.has(fixture.fixtureId))
    .sort((a, b) => a.gameweek - b.gameweek);
  for (const fixture of earlier) {
    const row = eloByFixture.get(fixture.fixtureId)!;
    byTeam.set(fixture.homeTeamId, row.homeElo);
    byTeam.set(fixture.awayTeamId, row.awayElo);
    leagueMean = row.leagueMeanElo;
  }
  return { byTeam, leagueMean };
}

/**
 * `deriveCleanSheetStrengths` without the ClubElo snapshot lookup: the ratings
 * come from the corpus instead, so a verdict here is about the transformation
 * rather than about ClubElo's published numbers.
 */
function cleanSheetStrengths(
  strengths: Record<number, TeamStrength>,
  elo: { byTeam: Map<number, number>; leagueMean: number },
): Record<number, CleanSheetStrength> {
  const result: Record<number, CleanSheetStrength> = {};
  for (const [key, strength] of Object.entries(strengths)) {
    const teamId = Number(key);
    const rating = elo.byTeam.get(teamId);
    if (rating === undefined) continue;
    const attack = (strength.attackHome + strength.attackAway) / 2;
    const defence = (strength.defenceHome + strength.defenceAway) / 2;
    if (!(attack > 0) || !(defence > 0)) continue;
    const level = ELO_LEVEL_SLOPE * (rating - elo.leagueMean);
    const skew = CLEAN_SHEET_SKEW_WEIGHT * (Math.log(attack) - Math.log(defence));
    result[teamId] = { attack: Math.exp((level + skew) / 2), defence: Math.exp((level - skew) / 2) };
  }
  return result;
}

// ---------------------------------------------------------------------------
// The arms.
// ---------------------------------------------------------------------------

interface Arm {
  name: string;
  /** Share of the form signal taken from goals rather than xG. 0 is shipped. */
  goalsWeight: number;
  decay: number;
  priorWeight: number;
  /** Exponent on the opponent-attack / own-defence ratio. 1 is shipped. */
  gamma: number;
  /**
   * Flat multiplier on the goals-against mean. 1 is shipped.
   *
   * The confound control for `gamma`. A gamma below 1 does two things at once:
   * it flattens the fixture and it lifts the average goals-against, because the
   * ratio sits below 1 more often than above it. The shipped read predicts a
   * 0.274 clean-sheet rate against an actual 0.241, so part of any gain from a
   * flatter fixture could be that recalibration and nothing to do with the
   * fixture at all. These arms move the level alone.
   */
  scale: number;
  /**
   * Shrinks the read toward the long-run clean-sheet rate: `base + k * (p - base)`.
   * 1 is shipped.
   *
   * The control that tells a fixture finding from an overconfidence finding. An
   * exponent below 1 leaves AUC untouched, so it is not reordering fixtures - it
   * is narrowing the spread. If a plain shrink buys the same Brier, then the
   * exponent is measuring that the rated path skips the compression the table
   * path gets from CLEAN_SHEET_RETAINED_WEIGHT, and not that the opponent
   * multiplier is too steep.
   */
  shrink: number;
}

const arm = (over: Partial<Arm> & { name: string }): Arm => ({
  goalsWeight: 0,
  decay: SHIPPED_DECAY,
  priorWeight: SHIPPED_PRIOR_WEIGHT,
  gamma: 1,
  scale: 1,
  shrink: 1,
  ...over,
});

const SIGNAL_WEIGHTS = [0, 0.25, 0.5, 0.75, 1];
const GAMMAS = [0.6, 0.7, 0.8, 0.9, 1.2, 1.4];
const SCALES = [1.05, 1.1, 1.15];
const SHRINKS = [0.85, 0.9, 0.95];
/** Long-run league clean-sheet rate, the shrinkage target (lib CS_SHRINK_BASE). */
const SHRINK_BASE = 0.25;
const DECAYS = [0.85, 0.9, 0.95, 1];
const PRIOR_WEIGHTS = [6, 12, 20, 30];

/** Arm 0 must be shipped behaviour, or every delta below has the wrong reference. */
const ARMS: Arm[] = [
  arm({ name: "shipped (xG only)" }),
  ...SIGNAL_WEIGHTS.slice(1).map((goalsWeight) =>
    arm({ name: `goals ${(goalsWeight * 100).toFixed(0)}% / xG ${((1 - goalsWeight) * 100).toFixed(0)}%`, goalsWeight })),
  ...GAMMAS.map((gamma) => arm({ name: `xG only, opponent^${gamma}`, gamma })),
  ...SCALES.map((scale) => arm({ name: `xG only, level x${scale}`, scale })),
  ...SHRINKS.map((shrink) => arm({ name: `xG only, shrink to base ${shrink}`, shrink })),
  ...SHRINKS.map((shrink) => arm({ name: `opponent^0.8 + shrink ${shrink}`, gamma: 0.8, shrink })),
  // Does the fixture exponent add anything on top of the level, or is it just
  // moving the level by another route? If the two stack, the pair beats either
  // alone; if they are the same effect, it does not.
  ...SCALES.flatMap((scale) => [0.8, 0.9].map((gamma) =>
    arm({ name: `opponent^${gamma} + level x${scale}`, gamma, scale }))),
  ...GAMMAS.map((gamma) => arm({ name: `goals 50%, opponent^${gamma}`, goalsWeight: 0.5, gamma })),
];

/** The (weight x decay x prior) surface, reported separately and read sceptically. */
const GRID: Arm[] = SIGNAL_WEIGHTS.flatMap((goalsWeight) =>
  DECAYS.flatMap((decay) =>
    PRIOR_WEIGHTS.map((priorWeight) =>
      arm({ name: `w${goalsWeight} d${decay} p${priorWeight}`, goalsWeight, decay, priorWeight }))));

// ---------------------------------------------------------------------------
// Prediction.
// ---------------------------------------------------------------------------

/** Team match history before `gameweek`, with the arm's signal in place of xG. */
function historyBefore(season: Season, gameweek: number, goalsWeight: number): Record<number, TeamMatchXG[]> {
  const history: Record<number, TeamMatchXG[]> = {};
  const blend = (xg: number, goals: number) => goalsWeight * goals + (1 - goalsWeight) * xg;
  for (const fixture of season.fixtures) {
    if (fixture.gameweek >= gameweek) continue;
    const home = blend(fixture.homeXg, fixture.homeGoals);
    const away = blend(fixture.awayXg, fixture.awayGoals);
    (history[fixture.homeTeamId] ??= []).push({
      xgFor: home, xgAgainst: away, opponentTeamId: fixture.awayTeamId, wasHome: true, gameweek: fixture.gameweek,
    });
    (history[fixture.awayTeamId] ??= []).push({
      xgFor: away, xgAgainst: home, opponentTeamId: fixture.homeTeamId, wasHome: false, gameweek: fixture.gameweek,
    });
  }
  return history;
}

/**
 * `cleanSheetFromRates` with the opponent ratio raised to `gamma`. At gamma 1
 * this is the shipped function; an assertion below holds it to that.
 */
function cleanSheetRead(
  isHome: boolean, ownDefence: number, opponentAttack: number, gamma: number, scale: number, shrink: number,
): { cleanSheetProbability: number; goalsAgainst: number } {
  if (gamma === 1 && scale === 1 && shrink === 1) return cleanSheetFromRates(isHome, ownDefence, opponentAttack);
  const venue = isHome ? AWAY_ATTACK_MULTIPLIER : HOME_ATTACK_MULTIPLIER;
  const goalsAgainst = LEAGUE_MEAN_XG * scale * Math.pow(opponentAttack / ownDefence, gamma) * venue;
  const phi = CLEAN_SHEET_DISPERSION;
  const raw = clamp(Math.pow(phi / (phi + goalsAgainst), phi), 0.02, 0.9);
  const shrunk = SHRINK_BASE + shrink * (raw - SHRINK_BASE);
  return {
    cleanSheetProbability: clamp(shrunk, 0.02, 0.9),
    // The concede deduction has to descend from the probability that was
    // actually used, or the two halves of the fixture disagree.
    goalsAgainst: shrink === 1 ? goalsAgainst : phi * (Math.pow(clamp(shrunk, 0.02, 0.9), -1 / phi) - 1),
  };
}

interface TeamCase {
  gameweek: number;
  cleanSheet: number;
  goalsAgainst: number;
  predictions: { cleanSheet: number; goalsAgainst: number }[];
}

interface PlayerCase {
  gameweek: number;
  actual: number;
  predictions: number[];
}

/** Strength and clean-sheet rates for one arm at one gameweek, memoised per (weight, decay, prior). */
function armStrengths(season: Season, gameweek: number, arms: readonly Arm[]) {
  const cache = new Map<string, { strengths: Record<number, TeamStrength>; rates: Record<number, CleanSheetStrength> }>();
  const elo = eloBefore(season, gameweek);
  const historyCache = new Map<number, Record<number, TeamMatchXG[]>>();
  return arms.map((item) => {
    const key = `${item.goalsWeight}|${item.decay}|${item.priorWeight}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const history = historyCache.get(item.goalsWeight)
      ?? historyCache.set(item.goalsWeight, historyBefore(season, gameweek, item.goalsWeight)).get(item.goalsWeight)!;
    const strengths = applyInSeasonForm(season.priorStrengths, history, item.decay, item.priorWeight);
    const built = { strengths, rates: cleanSheetStrengths(strengths, elo) };
    cache.set(key, built);
    return built;
  });
}

function collectTeamCases(season: Season, arms: readonly Arm[]): TeamCase[] {
  const cases: TeamCase[] = [];
  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const built = armStrengths(season, gameweek, arms);
    for (const fixture of season.fixturesByGameweek.get(gameweek) ?? []) {
      for (const isHome of [true, false]) {
        const ownId = isHome ? fixture.homeTeamId : fixture.awayTeamId;
        const opponentId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
        const conceded = isHome ? fixture.awayGoals : fixture.homeGoals;
        const predictions = built.map((state, index) => {
          const own = state.rates[ownId];
          const opponent = state.rates[opponentId];
          if (!own || !opponent) return undefined;
          return cleanSheetRead(isHome, own.defence, opponent.attack, arms[index].gamma, arms[index].scale, arms[index].shrink);
        });
        if (predictions.some((p) => p === undefined)) continue;
        cases.push({
          gameweek,
          cleanSheet: conceded === 0 ? 1 : 0,
          goalsAgainst: conceded,
          predictions: predictions.map((p) => ({
            cleanSheet: p!.cleanSheetProbability,
            goalsAgainst: p!.goalsAgainst,
          })),
        });
      }
    }
  }
  return cases;
}

/**
 * Whole-model xP for the signal arms.
 *
 * Caveat, and it is not small: `xp.ts` carries no rated clean-sheet path, so
 * this scores the 5x5 fallback read rather than the Elo-levelled one above. The
 * arms still differ here - the strengths drive the attack multiplier, the saves
 * environment and the concede deduction as well - but a clean-sheet verdict
 * belongs to the team-level table, not to this one. Minutes are actual, as in
 * `run.ts`, so the >=60 gate is exact and the minutes model does not bury the
 * signal.
 */
function collectPlayerCases(season: Season, arms: readonly Arm[]): PlayerCase[] {
  const cases: PlayerCase[] = [];
  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const built = armStrengths(season, gameweek, arms);
    const fixtureById = new Map((season.fixturesByGameweek.get(gameweek) ?? []).map((f) => [f.fixtureId, f]));
    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = fixtureById.get(row.fixtureId) as Fixture | undefined;
      if (!fixture) continue;
      const player = playerAt(season, row.historicalPlayerId, gameweek, fixture, row.wasHome);
      if (!player) continue;
      const form = formBefore(season, row.historicalPlayerId, gameweek);
      const upcoming = player.fixtures[0];
      const predictions = built.map((state) => {
        const rates = playerRates(player, form, gameweek, {}, state.strengths);
        return expectedPoints(player, upcoming, row.minutes, rates, state.strengths, BASELINE).total;
      });
      cases.push({ gameweek, actual: row.totalPoints, predictions });
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Scoring.
// ---------------------------------------------------------------------------

const brier = (list: readonly TeamCase[], index: number) =>
  mean(list.map((c) => (c.predictions[index].cleanSheet - c.cleanSheet) ** 2));

const logloss = (list: readonly TeamCase[], index: number) =>
  -mean(list.map((c) => {
    const p = clamp(c.predictions[index].cleanSheet, 1e-6, 1 - 1e-6);
    return c.cleanSheet ? Math.log(p) : Math.log(1 - p);
  }));

const goalsRmse = (list: readonly TeamCase[], index: number) =>
  Math.sqrt(mean(list.map((c) => (c.predictions[index].goalsAgainst - c.goalsAgainst) ** 2)));

const xpRmse = (list: readonly PlayerCase[], index: number) =>
  Math.sqrt(mean(list.map((c) => (c.predictions[index] - c.actual) ** 2)));

function auc(list: readonly TeamCase[], index: number): number {
  const sorted = list
    .map((c) => ({ score: c.predictions[index].cleanSheet, actual: c.cleanSheet }))
    .sort((a, b) => a.score - b.score);
  let rankSum = 0;
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].score === sorted[start].score) end += 1;
    const averageRank = (start + 1 + end) / 2;
    for (let i = start; i < end; i += 1) if (sorted[i].actual) rankSum += averageRank;
    start = end;
  }
  const positives = sorted.reduce((sum, item) => sum + item.actual, 0);
  const negatives = sorted.length - positives;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/**
 * Paired bootstrap over gameweek clusters, not rows: two rows in one fixture
 * share a team and a lambda, so resampling rows would understate the error.
 */
function clusteredInterval<T extends { gameweek: number }>(
  cases: readonly T[], index: number, score: (list: readonly T[], i: number) => number, seed: number,
): { lo: number; hi: number } {
  const byGameweek = new Map<number, T[]>();
  for (const item of cases) (byGameweek.get(item.gameweek) ?? byGameweek.set(item.gameweek, []).get(item.gameweek)!).push(item);
  const gameweeks = [...byGameweek.keys()];
  let state = seed;
  const random = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const deltas: number[] = [];
  for (let draw = 0; draw < BOOTSTRAP; draw += 1) {
    const rows: T[] = [];
    for (let i = 0; i < gameweeks.length; i += 1) rows.push(...byGameweek.get(gameweeks[Math.floor(random() * gameweeks.length)])!);
    deltas.push(score(rows, index) - score(rows, 0));
  }
  deltas.sort((a, b) => a - b);
  return { lo: deltas[Math.floor(BOOTSTRAP * 0.025)], hi: deltas[Math.floor(BOOTSTRAP * 0.975)] };
}

const verdictOf = (lo: number, hi: number) => (hi < 0 ? "BETTER" : lo > 0 ? "WORSE " : "  ns  ");

/**
 * Team cases for one season, written out so the seasons can be pooled.
 *
 * One season resolves almost nothing at this Brier scale, and the arms below
 * come back the same sign in every season while no single season's interval
 * excludes zero - exactly the shape a pooled test exists for. Gameweek cluster
 * ids are made season-unique so a resample cannot mix two seasons' gameweek 9.
 */
function dumpCases(label: string, cases: readonly TeamCase[], file: string): void {
  const offset = Number(label.slice(0, 4)) * 100;
  writeFileSync(file, JSON.stringify({
    label,
    arms: ARMS.map((item) => item.name),
    cases: cases.map((c) => ({ ...c, gameweek: offset + c.gameweek })),
  }));
  console.log(`\nteam cases written to ${file}`);
}

function pool(files: readonly string[]): void {
  const loaded = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as {
    label: string; arms: string[]; cases: TeamCase[];
  });
  const names = loaded[0].arms;
  for (const item of loaded) {
    if (item.arms.join("|") !== names.join("|")) throw new Error(`arm sets differ: ${item.label}`);
  }
  const cases = loaded.flatMap((item) => item.cases);
  const base = brier(cases, 0);
  console.log(`\n=== pooled: ${loaded.map((l) => l.label).join(", ")} ===`);
  console.log(`${cases.length} team-fixtures, actual clean-sheet rate ${mean(cases.map((c) => c.cleanSheet)).toFixed(3)}\n`);
  console.log("arm                             Brier    dBrier   95% CI (gw clusters)     verdict  logloss   AUC    GA RMSE");
  console.log("-".repeat(112));
  names.forEach((name, index) => {
    const score = brier(cases, index);
    const tail = `${logloss(cases, index).toFixed(4)}  ${auc(cases, index).toFixed(3)}  ${goalsRmse(cases, index).toFixed(4)}`;
    if (index === 0) {
      console.log(`${name.padEnd(31)} ${score.toFixed(5)}       -                             -       ${tail}`);
      return;
    }
    const { lo, hi } = clusteredInterval(cases, index, brier, 20260912 + index);
    console.log(`${name.padEnd(31)} ${score.toFixed(5)}  ${score - base >= 0 ? "+" : ""}${(score - base).toFixed(5)}  [${lo >= 0 ? "+" : ""}${lo.toFixed(5)}, ${hi >= 0 ? "+" : ""}${hi.toFixed(5)}]  ${verdictOf(lo, hi)}  ${tail}`);
  });
}

function main(): void {
  const poolIndex = process.argv.indexOf("--pool");
  if (poolIndex >= 0) {
    pool(process.argv.slice(poolIndex + 1));
    return;
  }
  // The gamma-1 path must be the shipped function, or the gamma arms are not
  // measured against production.
  const shipped = cleanSheetFromRates(true, 1.1, 0.95);
  const replica = cleanSheetRead(true, 1.1, 0.95, 1, 1, 1);
  if (Math.abs(shipped.cleanSheetProbability - replica.cleanSheetProbability) > 1e-12) {
    throw new Error("gamma-1 read does not reproduce cleanSheetFromRates");
  }

  const season = loadSeason();
  const label = path.basename(dataDir);
  const teamCases = collectTeamCases(season, ARMS);
  const rate = mean(teamCases.map((c) => c.cleanSheet));
  const caseOut = process.env.BACKTEST_CASE_OUT;

  console.log(`\n=== ${label}: in-season form signal, goals against xG ===`);
  console.log(`walk-forward gameweeks ${FIRST_GAMEWEEK}-38, shipped decay ${SHIPPED_DECAY} prior ${SHIPPED_PRIOR_WEIGHT}`);
  console.log(`${teamCases.length} team-fixtures, actual clean-sheet rate ${rate.toFixed(3)}\n`);
  console.log("arm                             Brier    dBrier   95% CI (gw clusters)     verdict  logloss   AUC    GA RMSE  meanP");
  console.log("-".repeat(120));
  const baseBrier = brier(teamCases, 0);
  ARMS.forEach((item, index) => {
    const score = brier(teamCases, index);
    const meanPrediction = mean(teamCases.map((c) => c.predictions[index].cleanSheet));
    const tail = `${logloss(teamCases, index).toFixed(4)}  ${auc(teamCases, index).toFixed(3)}  ${goalsRmse(teamCases, index).toFixed(4)}  ${meanPrediction.toFixed(3)}`;
    if (index === 0) {
      console.log(`${item.name.padEnd(31)} ${score.toFixed(5)}       -                             -       ${tail}`);
      return;
    }
    const { lo, hi } = clusteredInterval(teamCases, index, brier, 20260910 + index);
    const delta = score - baseBrier;
    console.log(`${item.name.padEnd(31)} ${score.toFixed(5)}  ${delta >= 0 ? "+" : ""}${delta.toFixed(5)}  [${lo >= 0 ? "+" : ""}${lo.toFixed(5)}, ${hi >= 0 ? "+" : ""}${hi.toFixed(5)}]  ${verdictOf(lo, hi)}  ${tail}`);
  });

  if (caseOut) dumpCases(label, teamCases, caseOut);

  const gridCases = collectTeamCases(season, GRID);
  const ranked = GRID.map((item, index) => ({ item, brier: brier(gridCases, index) }))
    .sort((a, b) => a.brier - b.brier);
  const gridBase = ranked.find((r) => r.item.goalsWeight === 0 && r.item.decay === SHIPPED_DECAY
    && r.item.priorWeight === SHIPPED_PRIOR_WEIGHT)!.brier;
  console.log(`\nweight x decay x prior surface, ${GRID.length} cells. Shipped cell Brier ${gridBase.toFixed(5)}.`);
  console.log("Read the spread, not the winner: a best cell chosen on the same data it is scored on is a noise estimate.");
  console.log("rank  cell              Brier     vs shipped");
  ranked.slice(0, 8).forEach((row, rank) => {
    console.log(`${String(rank + 1).padStart(4)}  ${row.item.name.padEnd(18)} ${row.brier.toFixed(5)}  ${row.brier - gridBase >= 0 ? "+" : ""}${(row.brier - gridBase).toFixed(5)}`);
  });
  console.log(`worst cell ${ranked[ranked.length - 1].item.name} ${ranked[ranked.length - 1].brier.toFixed(5)}`);
  console.log("best cell per goals weight:");
  for (const goalsWeight of SIGNAL_WEIGHTS) {
    const best = ranked.find((row) => row.item.goalsWeight === goalsWeight)!;
    console.log(`  w=${goalsWeight}  ${best.item.name.padEnd(18)} ${best.brier.toFixed(5)}  ${best.brier - gridBase >= 0 ? "+" : ""}${(best.brier - gridBase).toFixed(5)}`);
  }

  const signalArms = ARMS.slice(0, SIGNAL_WEIGHTS.length);
  const playerCases = collectPlayerCases(season, signalArms);
  const baseXp = xpRmse(playerCases, 0);
  console.log(`\nwhole-model xP, ${playerCases.length} played rows. Table clean-sheet path only - see the note in this file.`);
  console.log("arm                             xP RMSE   dRMSE    95% CI (gw clusters)     verdict");
  signalArms.forEach((item, index) => {
    const score = xpRmse(playerCases, index);
    if (index === 0) {
      console.log(`${item.name.padEnd(31)} ${score.toFixed(5)}       -                             -`);
      return;
    }
    const { lo, hi } = clusteredInterval(playerCases, index, xpRmse, 20260911 + index);
    console.log(`${item.name.padEnd(31)} ${score.toFixed(5)}  ${score - baseXp >= 0 ? "+" : ""}${(score - baseXp).toFixed(5)}  [${lo >= 0 ? "+" : ""}${lo.toFixed(5)}, ${hi >= 0 ? "+" : ""}${hi.toFixed(5)}]  ${verdictOf(lo, hi)}`);
  });
}

main();
