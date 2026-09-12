/**
 * Should a team's own clean-sheet rate feed the clean-sheet read, alongside xG?
 *
 * The shipped read goes through a goals-against mean: xG for and against fits
 * attack and defence rates, a fixture turns those into a lambda, and a negative
 * binomial turns the lambda into P(0 conceded). Every team is assumed to convert
 * its lambda into clean sheets the same way. They do not have to: a side that
 * ships three in one match and keeps two clean sheets has the same lambda as one
 * conceding one a week, and twice the clean sheets. `results/goals-vs-xg.md`
 * found the rated path predicts 0.274 against a measured 0.241-0.252, so there
 * is a conversion error to go looking for.
 *
 * The cost is information. A clean sheet is one bit a match; over the fifteen
 * matches that matter mid-season a 0.25 rate carries a standard error near 0.11.
 * Goals, which carry strictly more than a threshold on themselves, were already
 * a wash in `goals-vs-xg.ts`. So this is a bias-against-variance question, and
 * the corpus has to answer it.
 *
 * Each team gets a clean-sheet rate: the previous season's as the prior, the
 * current season's decayed and schedule-adjusted as the evidence, blended on
 * the same n/(n+12) schedule the xG fit uses. That rate is inverted through the
 * same negative binomial into an implied goals-against, and the ratio of it to
 * what the xG fit implies is applied at weight `w`. Two routes:
 *
 *   LAMBDA  straight onto the fixture's goals-against mean. The honest test of
 *           the idea, and the one an outcome verdict belongs to.
 *   SKEW    into the strengths' defence before `deriveCleanSheetStrengths`,
 *           which is where it would have to live to ship inside the current
 *           structure. That transform keeps 60% of a team's lean and halves it,
 *           so only about 0.3 of any correction survives - the arm is damped by
 *           construction and is reported to show by how much.
 *
 * Needs a previous season in the corpus for the prior, so it runs on 2023/24
 * onwards. Walk-forward otherwise: every rate is built only from matches before
 * the gameweek being scored.
 *
 *   BACKTEST_MULTI_DATA_DIR=$ROOT npx tsx scripts/backtest/prepare-seasons.ts
 *   BACKTEST_MULTI_DATA_DIR=$ROOT npx tsx scripts/backtest/elo-history.ts
 *   BACKTEST_DATA_DIR=$ROOT/2024-25 npx tsx scripts/backtest/cs-rate-signal.ts
 *   npx tsx scripts/backtest/cs-rate-signal.ts --pool /tmp/cs-*.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TeamStrength } from "@/types/projection";
import type { HistoricalMatchStat } from "@/lib/historical/types";
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
import { buildFixturesFromMatchRows } from "./multiSeasonData";
import { loadSeason, type Season } from "./season";

const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 4000;
const DECAY = 0.9;
const PRIOR_WEIGHT = 12;
const PHI = CLEAN_SHEET_DISPERSION;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Clean-sheet probability under the shipped negative binomial, and its inverse. */
const lambdaToCleanSheet = (lambda: number) => clamp(Math.pow(PHI / (PHI + lambda), PHI), 0.02, 0.9);
const cleanSheetToLambda = (probability: number) => PHI * (Math.pow(clamp(probability, 0.02, 0.9), -1 / PHI) - 1);

const POOLING = process.argv.includes("--pool");
const dataDir = process.env.BACKTEST_DATA_DIR ?? path.join(path.resolve(__dirname, "../.."), "data/generated");

// ---------------------------------------------------------------------------
// Inputs: walk-forward Elo, and the previous season's clean-sheet rates.
// ---------------------------------------------------------------------------

interface EloRow { fixtureId: number; homeElo: number; awayElo: number; leagueMeanElo: number }
interface RawTeam { teamId: number; name: string }

const readJson = <T,>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const normalizedName = (value: string) =>
  value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const eloPath = path.join(dataDir, "backtest-elo.json");
if (!POOLING && !existsSync(eloPath)) {
  console.error(`no backtest-elo.json in ${dataDir}; run scripts/backtest/elo-history.ts first`);
  process.exit(1);
}
const eloByFixture = new Map(
  (POOLING || !existsSync(eloPath) ? [] : readJson<EloRow[]>(eloPath)).map((row) => [row.fixtureId, row]),
);

/**
 * Each team's clean-sheet rate last season, keyed to this season's team ids.
 *
 * A full season faces every opponent home and away, so the rate needs no
 * schedule adjustment. Promoted clubs have no top-flight rate and take the
 * league average, exactly as `buildPreviousSeasonTeamPriors` does for xG.
 */
function previousCleanSheetRates(): { byTeam: Map<number, number>; leagueRate: number; promoted: number } {
  const seasons = ["2022-23", "2023-24", "2024-25", "2025-26"];
  const label = path.basename(dataDir);
  const index = seasons.indexOf(label);
  if (index <= 0) throw new Error(`${label} has no previous season in the corpus; run 2023-24 onwards`);
  const previousDir = path.join(path.dirname(dataDir), seasons[index - 1]);

  const previousFixtures = buildFixturesFromMatchRows(
    readJson<HistoricalMatchStat[]>(path.join(previousDir, "historical-match-stats.json")),
  );
  const counts = new Map<number, { matches: number; cleanSheets: number }>();
  const add = (teamId: number, conceded: number) => {
    const entry = counts.get(teamId) ?? { matches: 0, cleanSheets: 0 };
    entry.matches += 1;
    entry.cleanSheets += conceded === 0 ? 1 : 0;
    counts.set(teamId, entry);
  };
  for (const fixture of previousFixtures) {
    add(fixture.homeTeamId, fixture.awayGoals);
    add(fixture.awayTeamId, fixture.homeGoals);
  }
  const leagueRate = [...counts.values()].reduce((sum, e) => sum + e.cleanSheets, 0)
    / Math.max([...counts.values()].reduce((sum, e) => sum + e.matches, 0), 1);

  const previousById = new Map(readJson<RawTeam[]>(path.join(previousDir, "team-strength.json"))
    .map((team) => [team.teamId, normalizedName(team.name)]));
  const rateByName = new Map<string, number>();
  for (const [teamId, entry] of counts) {
    const name = previousById.get(teamId);
    if (name && entry.matches > 0) rateByName.set(name, entry.cleanSheets / entry.matches);
  }

  const byTeam = new Map<number, number>();
  let promoted = 0;
  for (const team of readJson<RawTeam[]>(path.join(dataDir, "team-strength.json"))) {
    const rate = rateByName.get(normalizedName(team.name));
    if (rate === undefined) promoted += 1;
    byTeam.set(team.teamId, rate ?? leagueRate);
  }
  return { byTeam, leagueRate, promoted };
}

function eloBefore(season: Season, gameweek: number): { byTeam: Map<number, number>; leagueMean: number } {
  const byTeam = new Map<number, number>();
  let leagueMean = 0;
  for (const fixture of season.fixtures.filter((f) => f.gameweek < gameweek).sort((a, b) => a.gameweek - b.gameweek)) {
    const row = eloByFixture.get(fixture.fixtureId);
    if (!row) continue;
    byTeam.set(fixture.homeTeamId, row.homeElo);
    byTeam.set(fixture.awayTeamId, row.awayElo);
    leagueMean = row.leagueMeanElo;
  }
  return { byTeam, leagueMean };
}

// ---------------------------------------------------------------------------
// The clean-sheet-rate signal.
// ---------------------------------------------------------------------------

/**
 * The correction factor on a team's goals-against mean implied by its own
 * clean-sheet record, as a ratio to what the xG fit implies. 1 means the two
 * agree and the arm changes nothing.
 *
 * The current-season part is schedule-adjusted by the mean attacking strength
 * of the opponents actually faced, weighted the same way the rate is. Without
 * that, a team off an easy run reads as a better defence than it is - the same
 * correction `adjustedMatchXG` makes on the xG side.
 */
function cleanSheetLambdaRatio(
  season: Season,
  gameweek: number,
  strengths: Record<number, TeamStrength>,
  priorRates: Map<number, number>,
): Map<number, number> {
  const played = new Map<number, { cleanSheet: number; opponentAttack: number }[]>();
  for (const fixture of season.fixtures) {
    if (fixture.gameweek >= gameweek) continue;
    const attackOf = (teamId: number) => {
      const strength = season.priorStrengths[teamId];
      return strength ? (strength.attackHome + strength.attackAway) / 2 : 1;
    };
    (played.get(fixture.homeTeamId) ?? played.set(fixture.homeTeamId, []).get(fixture.homeTeamId)!)
      .push({ cleanSheet: fixture.awayGoals === 0 ? 1 : 0, opponentAttack: attackOf(fixture.awayTeamId) });
    (played.get(fixture.awayTeamId) ?? played.set(fixture.awayTeamId, []).get(fixture.awayTeamId)!)
      .push({ cleanSheet: fixture.homeGoals === 0 ? 1 : 0, opponentAttack: attackOf(fixture.homeTeamId) });
  }

  const ratios = new Map<number, number>();
  for (const [key, strength] of Object.entries(strengths)) {
    const teamId = Number(key);
    const defence = (strength.defenceHome + strength.defenceAway) / 2;
    if (!(defence > 0)) continue;
    const lambdaXg = LEAGUE_MEAN_XG / defence;

    const lambdaPrior = cleanSheetToLambda(priorRates.get(teamId) ?? 0.25);
    const matches = played.get(teamId) ?? [];
    let lambdaCs = lambdaPrior;
    if (matches.length > 0) {
      let weightSum = 0;
      let weightedCleanSheets = 0;
      let weightedOpponentAttack = 0;
      for (let i = 0; i < matches.length; i += 1) {
        const match = matches[matches.length - 1 - i]; // i = 0 is the most recent
        const weight = DECAY ** i;
        weightSum += weight;
        weightedCleanSheets += weight * match.cleanSheet;
        weightedOpponentAttack += weight * match.opponentAttack;
      }
      const observedRate = weightedCleanSheets / weightSum;
      const opponentAttack = Math.max(weightedOpponentAttack / weightSum, 0.2);
      const lambdaCurrent = cleanSheetToLambda(observedRate) / opponentAttack;
      const share = matches.length / (matches.length + PRIOR_WEIGHT);
      lambdaCs = Math.exp((1 - share) * Math.log(lambdaPrior) + share * Math.log(Math.max(lambdaCurrent, 0.05)));
    }
    ratios.set(teamId, lambdaCs / lambdaXg);
  }
  return ratios;
}

type Mode = "LAMBDA" | "SKEW";

interface Arm { name: string; weight: number; mode: Mode }

const WEIGHTS = [0.25, 0.5, 0.75, 1];
const ARMS: Arm[] = [
  { name: "shipped (xG only)", weight: 0, mode: "LAMBDA" },
  ...WEIGHTS.map((weight) => ({ name: `CS rate ${weight} on lambda`, weight, mode: "LAMBDA" as Mode })),
  ...WEIGHTS.map((weight) => ({ name: `CS rate ${weight} via skew`, weight, mode: "SKEW" as Mode })),
];

/** `deriveCleanSheetStrengths` with the corpus ratings, optionally correcting defence first. */
function cleanSheetStrengths(
  strengths: Record<number, TeamStrength>,
  elo: { byTeam: Map<number, number>; leagueMean: number },
  ratios: Map<number, number>,
  skewWeight: number,
): Record<number, CleanSheetStrength> {
  const result: Record<number, CleanSheetStrength> = {};
  for (const [key, strength] of Object.entries(strengths)) {
    const teamId = Number(key);
    const rating = elo.byTeam.get(teamId);
    if (rating === undefined) continue;
    const attack = (strength.attackHome + strength.attackAway) / 2;
    let defence = (strength.defenceHome + strength.defenceAway) / 2;
    if (!(attack > 0) || !(defence > 0)) continue;
    // A ratio above 1 means the clean-sheet record wants a higher goals-against
    // mean, which is a weaker defence: the correction enters inverted.
    if (skewWeight > 0) defence /= Math.pow(ratios.get(teamId) ?? 1, skewWeight);
    const level = ELO_LEVEL_SLOPE * (rating - elo.leagueMean);
    const skew = CLEAN_SHEET_SKEW_WEIGHT * (Math.log(attack) - Math.log(defence));
    result[teamId] = { attack: Math.exp((level + skew) / 2), defence: Math.exp((level - skew) / 2) };
  }
  return result;
}

interface Case {
  gameweek: number;
  cleanSheet: number;
  goalsAgainst: number;
  predictions: { cleanSheet: number; goalsAgainst: number }[];
}

function collect(season: Season, priorRates: Map<number, number>): Case[] {
  const cases: Case[] = [];
  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const history: Record<number, TeamMatchXG[]> = {};
    for (const fixture of season.fixtures) {
      if (fixture.gameweek >= gameweek) continue;
      (history[fixture.homeTeamId] ??= []).push({
        xgFor: fixture.homeXg, xgAgainst: fixture.awayXg,
        opponentTeamId: fixture.awayTeamId, wasHome: true, gameweek: fixture.gameweek,
      });
      (history[fixture.awayTeamId] ??= []).push({
        xgFor: fixture.awayXg, xgAgainst: fixture.homeXg,
        opponentTeamId: fixture.homeTeamId, wasHome: false, gameweek: fixture.gameweek,
      });
    }
    const strengths = applyInSeasonForm(season.priorStrengths, history, DECAY, PRIOR_WEIGHT);
    const elo = eloBefore(season, gameweek);
    const ratios = cleanSheetLambdaRatio(season, gameweek, strengths, priorRates);
    const ratesByArm = ARMS.map((item) =>
      cleanSheetStrengths(strengths, elo, ratios, item.mode === "SKEW" ? item.weight : 0));

    for (const fixture of season.fixturesByGameweek.get(gameweek) ?? []) {
      for (const isHome of [true, false]) {
        const ownId = isHome ? fixture.homeTeamId : fixture.awayTeamId;
        const opponentId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
        const conceded = isHome ? fixture.awayGoals : fixture.homeGoals;
        const predictions = ARMS.map((item, index) => {
          const own = ratesByArm[index][ownId];
          const opponent = ratesByArm[index][opponentId];
          if (!own || !opponent) return undefined;
          const base = cleanSheetFromRates(isHome, own.defence, opponent.attack);
          if (item.mode === "SKEW" || item.weight === 0) return base;
          const venue = isHome ? AWAY_ATTACK_MULTIPLIER : HOME_ATTACK_MULTIPLIER;
          const lambda = LEAGUE_MEAN_XG * (opponent.attack / own.defence) * venue
            * Math.pow(ratios.get(ownId) ?? 1, item.weight);
          return { cleanSheetProbability: lambdaToCleanSheet(lambda), goalsAgainst: lambda };
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

// ---------------------------------------------------------------------------
// Scoring. Paired bootstrap over gameweek clusters, as elsewhere in this suite.
// ---------------------------------------------------------------------------

const brier = (list: readonly Case[], index: number) =>
  mean(list.map((c) => (c.predictions[index].cleanSheet - c.cleanSheet) ** 2));
const logloss = (list: readonly Case[], index: number) =>
  -mean(list.map((c) => {
    const p = clamp(c.predictions[index].cleanSheet, 1e-6, 1 - 1e-6);
    return c.cleanSheet ? Math.log(p) : Math.log(1 - p);
  }));
const goalsRmse = (list: readonly Case[], index: number) =>
  Math.sqrt(mean(list.map((c) => (c.predictions[index].goalsAgainst - c.goalsAgainst) ** 2)));

function auc(list: readonly Case[], index: number): number {
  const sorted = list.map((c) => ({ score: c.predictions[index].cleanSheet, actual: c.cleanSheet }))
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
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * (sorted.length - positives));
}

function interval(cases: readonly Case[], index: number, seed: number): { lo: number; hi: number } {
  const byGameweek = new Map<number, Case[]>();
  for (const item of cases) (byGameweek.get(item.gameweek) ?? byGameweek.set(item.gameweek, []).get(item.gameweek)!).push(item);
  const gameweeks = [...byGameweek.keys()];
  let state = seed;
  const random = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const deltas: number[] = [];
  for (let draw = 0; draw < BOOTSTRAP; draw += 1) {
    const rows: Case[] = [];
    for (let i = 0; i < gameweeks.length; i += 1) rows.push(...byGameweek.get(gameweeks[Math.floor(random() * gameweeks.length)])!);
    deltas.push(brier(rows, index) - brier(rows, 0));
  }
  deltas.sort((a, b) => a - b);
  return { lo: deltas[Math.floor(BOOTSTRAP * 0.025)], hi: deltas[Math.floor(BOOTSTRAP * 0.975)] };
}

const verdictOf = (lo: number, hi: number) => (hi < 0 ? "BETTER" : lo > 0 ? "WORSE " : "  ns  ");

function report(title: string, cases: readonly Case[]): void {
  const base = brier(cases, 0);
  console.log(`\n=== ${title} ===`);
  console.log(`${cases.length} team-fixtures, actual clean-sheet rate ${mean(cases.map((c) => c.cleanSheet)).toFixed(3)}\n`);
  console.log("arm                             Brier    dBrier   95% CI (gw clusters)     verdict  logloss   AUC    GA RMSE  meanP");
  console.log("-".repeat(120));
  ARMS.forEach((item, index) => {
    const score = brier(cases, index);
    const tail = `${logloss(cases, index).toFixed(4)}  ${auc(cases, index).toFixed(3)}  ${goalsRmse(cases, index).toFixed(4)}  ${mean(cases.map((c) => c.predictions[index].cleanSheet)).toFixed(3)}`;
    if (index === 0) {
      console.log(`${item.name.padEnd(31)} ${score.toFixed(5)}       -                             -       ${tail}`);
      return;
    }
    const { lo, hi } = interval(cases, index, 20260913 + index);
    console.log(`${item.name.padEnd(31)} ${score.toFixed(5)}  ${score - base >= 0 ? "+" : ""}${(score - base).toFixed(5)}  [${lo >= 0 ? "+" : ""}${lo.toFixed(5)}, ${hi >= 0 ? "+" : ""}${hi.toFixed(5)}]  ${verdictOf(lo, hi)}  ${tail}`);
  });
}

function main(): void {
  const poolIndex = process.argv.indexOf("--pool");
  if (poolIndex >= 0) {
    const files = process.argv.slice(poolIndex + 1);
    const loaded = files.map((file) => readJson<{ label: string; arms: string[]; cases: Case[] }>(file));
    for (const item of loaded) {
      if (item.arms.join("|") !== ARMS.map((a) => a.name).join("|")) throw new Error(`arm sets differ: ${item.label}`);
    }
    report(`pooled: ${loaded.map((l) => l.label).join(", ")}`, loaded.flatMap((l) => l.cases));
    return;
  }

  const label = path.basename(dataDir);
  const { byTeam, leagueRate, promoted } = previousCleanSheetRates();
  const season = loadSeason();
  const cases = collect(season, byTeam);

  console.log(`\n${label}: previous-season clean-sheet rate ${leagueRate.toFixed(3)}, ${promoted} teams on the league fallback`);
  report(`${label}: clean-sheet rate as a defensive signal`, cases);

  const out = process.env.BACKTEST_CASE_OUT;
  if (out) {
    // Season-unique cluster ids, so a pooled resample cannot mix two seasons'
    // gameweek 9 into one cluster.
    const offset = Number(label.slice(0, 4)) * 100;
    writeFileSync(out, JSON.stringify({
      label, arms: ARMS.map((a) => a.name),
      cases: cases.map((c) => ({ ...c, gameweek: offset + c.gameweek })),
    }));
    console.log(`\nteam cases written to ${out}`);
  }
}

main();
