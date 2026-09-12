/**
 * Where should the clean-sheet read take its goal-scale level from?
 *
 * `deriveCleanSheetStrengths` takes the level entirely from ClubElo and reads
 * only the lean - attack against defence - from this season's xG. A team that
 * gets uniformly worse therefore has an unchanged lean and an unchanged level,
 * so its clean-sheet rating does not move; and a team whose attack falls faster
 * than its defence is rated as defending *better*, because defence enters as
 * `exp((level - 0.6 * lean) / 2)`.
 *
 * That is not hypothetical. At gameweek 4 of 2026/27 Chelsea had conceded 7 in 3
 * with 1.63 xG against a match, and sat 5th of 20 on this rating at every prior
 * weight from 12 down to zero - the rating rose from 1.102 to 1.189 as the
 * season's evidence was given more weight. See
 * `scripts/experiments/diagnose-gk-defence.ts`.
 *
 * The arms hand the level over to the in-season fit as matches accrue:
 *
 *   level = (1 - w) * eloLevel + w * fittedLevel     w = n / (n + k)
 *
 * `fittedLevel` is `log(attack) + log(defence)`, centred and **rescaled to the
 * Elo level's own spread**. That rescale is not optional. The module docstring
 * records that these normalized ratios have a level spread 1.69x narrower than
 * a direct Poisson fit, so using them raw would leave the arm re-ordering teams
 * while quietly compressing them together, and would test the wrong thing.
 *
 * Scored on realized clean sheets, split by gameweek window, because the whole
 * question is about the early season and every other script in this directory
 * starts at gameweek 6.
 *
 *   BACKTEST_DATA_DIR=$ROOT/2025-26 npx tsx scripts/backtest/cs-level-source.ts
 *   npx tsx scripts/backtest/cs-level-source.ts --pool /tmp/lvl-*.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TeamStrength } from "@/types/projection";
import { applyInSeasonForm, type TeamMatchXG } from "@/lib/historical/inSeasonForm";
import { CLEAN_SHEET_SKEW_WEIGHT, ELO_LEVEL_SLOPE } from "@/lib/projections/cleanSheetStrength";
import { cleanSheetFromRates } from "@/lib/projections/fixtureAdjustment";
import { loadSeason, type Season } from "./season";

/** Gameweek 1 has no evidence at all, so every arm is identical there. */
const FIRST_GAMEWEEK = 2;
const EARLY_THROUGH = 5;
const BOOTSTRAP = 4000;

const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const sd = (values: readonly number[]) => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
};

const POOLING = process.argv.includes("--pool");
const dataDir = process.env.BACKTEST_DATA_DIR ?? path.join(path.resolve(__dirname, "../.."), "data/generated");

interface EloRow { fixtureId: number; homeElo: number; awayElo: number; leagueMeanElo: number }
const eloPath = path.join(dataDir, "backtest-elo.json");
if (!POOLING && !existsSync(eloPath)) {
  console.error(`no backtest-elo.json in ${dataDir}; run scripts/backtest/elo-history.ts first`);
  process.exit(1);
}
const eloByFixture = new Map(
  (POOLING || !existsSync(eloPath) ? [] : (JSON.parse(readFileSync(eloPath, "utf8")) as EloRow[]))
    .map((row) => [row.fixtureId, row]),
);

/**
 * Pre-match ratings as of `gameweek`, from each team's most recent earlier
 * fixture. Ratings carry across seasons in `elo-history.ts`, so gameweek 2 is
 * rated on last season rather than on one match.
 */
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

interface Arm { name: string; /** null = shipped, Elo only. */ k: number | null; fixed?: number }

const ARMS: Arm[] = [
  { name: "shipped (level from Elo)", k: null },
  ...[3, 6, 12, 20].map((k) => ({ name: `level -> fit on n/(n+${k})`, k })),
  ...[0.25, 0.5, 1].map((fixed) => ({ name: `level ${fixed} fit, fixed`, k: null, fixed })),
];

interface Rates { attack: number; defence: number }

/**
 * `deriveCleanSheetStrengths` with the level optionally handed over to the fit.
 * At `weight` 0 this is the shipped transform exactly; `main` asserts that.
 */
function cleanSheetStrengths(
  strengths: Record<number, TeamStrength>,
  elo: { byTeam: Map<number, number>; leagueMean: number },
  matchesPlayed: Map<number, number>,
  arm: Arm,
): Record<number, Rates> {
  const rated: { teamId: number; eloLevel: number; fitLevel: number; skew: number; played: number }[] = [];
  for (const [key, strength] of Object.entries(strengths)) {
    const teamId = Number(key);
    const rating = elo.byTeam.get(teamId);
    if (rating === undefined) continue;
    const attack = (strength.attackHome + strength.attackAway) / 2;
    const defence = (strength.defenceHome + strength.defenceAway) / 2;
    if (!(attack > 0) || !(defence > 0)) continue;
    rated.push({
      teamId,
      eloLevel: ELO_LEVEL_SLOPE * (rating - elo.leagueMean),
      fitLevel: Math.log(attack) + Math.log(defence),
      skew: Math.log(attack) - Math.log(defence),
      played: matchesPlayed.get(teamId) ?? 0,
    });
  }
  if (rated.length === 0) return {};

  // Centre the fitted level and stretch it onto the spread the Elo level has,
  // so the arm swaps where the level comes from without also changing how far
  // apart the teams sit. Both inputs are pre-gameweek, so nothing leaks.
  const fitMean = mean(rated.map((r) => r.fitLevel));
  const fitSd = sd(rated.map((r) => r.fitLevel));
  const eloSd = sd(rated.map((r) => r.eloLevel));
  const stretch = fitSd > 1e-9 ? eloSd / fitSd : 0;

  const result: Record<number, Rates> = {};
  for (const team of rated) {
    const weight = arm.fixed ?? (arm.k === null ? 0 : team.played / (team.played + arm.k));
    const fitted = (team.fitLevel - fitMean) * stretch;
    const level = (1 - weight) * team.eloLevel + weight * fitted;
    const skew = CLEAN_SHEET_SKEW_WEIGHT * team.skew;
    result[team.teamId] = { attack: Math.exp((level + skew) / 2), defence: Math.exp((level - skew) / 2) };
  }
  return result;
}

interface Case { gameweek: number; cleanSheet: number; predictions: number[] }

function collect(season: Season): Case[] {
  const cases: Case[] = [];
  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const history: Record<number, TeamMatchXG[]> = {};
    const played = new Map<number, number>();
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
      played.set(fixture.homeTeamId, (played.get(fixture.homeTeamId) ?? 0) + 1);
      played.set(fixture.awayTeamId, (played.get(fixture.awayTeamId) ?? 0) + 1);
    }
    const strengths = applyInSeasonForm(season.priorStrengths, history);
    const elo = eloBefore(season, gameweek);
    const byArm = ARMS.map((arm) => cleanSheetStrengths(strengths, elo, played, arm));

    for (const fixture of season.fixturesByGameweek.get(gameweek) ?? []) {
      for (const isHome of [true, false]) {
        const ownId = isHome ? fixture.homeTeamId : fixture.awayTeamId;
        const opponentId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
        const conceded = isHome ? fixture.awayGoals : fixture.homeGoals;
        const predictions = byArm.map((rates) => {
          const own = rates[ownId];
          const opponent = rates[opponentId];
          if (!own || !opponent) return undefined;
          return cleanSheetFromRates(isHome, own.defence, opponent.attack).cleanSheetProbability;
        });
        if (predictions.some((p) => p === undefined)) continue;
        cases.push({ gameweek, cleanSheet: conceded === 0 ? 1 : 0, predictions: predictions as number[] });
      }
    }
  }
  return cases;
}

const brier = (list: readonly Case[], index: number) =>
  mean(list.map((c) => (c.predictions[index] - c.cleanSheet) ** 2));
const logloss = (list: readonly Case[], index: number) =>
  -mean(list.map((c) => {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, c.predictions[index]));
    return c.cleanSheet ? Math.log(p) : Math.log(1 - p);
  }));

function auc(list: readonly Case[], index: number): number {
  const sorted = list.map((c) => ({ score: c.predictions[index], actual: c.cleanSheet }))
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
  return positives && negatives ? (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives) : NaN;
}

function interval(cases: readonly Case[], index: number, seed: number): { lo: number; hi: number } {
  const byGameweek = new Map<number, Case[]>();
  for (const c of cases) (byGameweek.get(c.gameweek) ?? byGameweek.set(c.gameweek, []).get(c.gameweek)!).push(c);
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

const fmt = (value: number, places = 5) => (value >= 0 ? "+" : "") + value.toFixed(places);
const verdictOf = (lo: number, hi: number) => (hi < 0 ? "BETTER" : lo > 0 ? "WORSE " : "  ns  ");

function window(title: string, cases: readonly Case[], seed: number): void {
  if (cases.length === 0) return;
  const base = brier(cases, 0);
  console.log(`\n${title}: ${cases.length} team-fixtures, clean-sheet rate ${mean(cases.map((c) => c.cleanSheet)).toFixed(3)}`);
  console.log("  arm                             Brier    dBrier   95% CI (gw clusters)     verdict  logloss   AUC");
  ARMS.forEach((arm, index) => {
    const score = brier(cases, index);
    const tail = `${logloss(cases, index).toFixed(4)}  ${auc(cases, index).toFixed(3)}`;
    if (index === 0) {
      console.log(`  ${arm.name.padEnd(31)} ${score.toFixed(5)}       -                             -       ${tail}`);
      return;
    }
    const { lo, hi } = interval(cases, index, seed + index);
    console.log(`  ${arm.name.padEnd(31)} ${score.toFixed(5)}  ${fmt(score - base)}  [${fmt(lo)}, ${fmt(hi)}]  ${verdictOf(lo, hi)}  ${tail}`);
  });
}

function report(label: string, cases: readonly Case[]): void {
  console.log(`\n=== ${label}: where the clean-sheet level comes from ===`);
  // Gameweek ids are season-offset once pooled, so recover the within-season one.
  const gw = (c: Case) => c.gameweek % 100;
  window(`gameweeks ${FIRST_GAMEWEEK}-${EARLY_THROUGH} (the early season, unscored by every other script)`,
    cases.filter((c) => gw(c) <= EARLY_THROUGH), 20260914);
  window(`gameweeks ${EARLY_THROUGH + 1}-38 (where the rest of the suite measures)`,
    cases.filter((c) => gw(c) > EARLY_THROUGH), 20260915);
  window("all gameweeks", cases, 20260916);
}

function main(): void {
  const poolIndex = process.argv.indexOf("--pool");
  if (poolIndex >= 0) {
    const loaded = process.argv.slice(poolIndex + 1)
      .map((file) => JSON.parse(readFileSync(file, "utf8")) as { label: string; arms: string[]; cases: Case[] });
    for (const item of loaded) {
      if (item.arms.join("|") !== ARMS.map((a) => a.name).join("|")) throw new Error(`arm sets differ: ${item.label}`);
    }
    report(`pooled: ${loaded.map((l) => l.label).join(", ")}`, loaded.flatMap((l) => l.cases));
    return;
  }

  // Arm 0 must be the shipped transform, or every delta is against the wrong
  // reference. Same inputs, same arithmetic, spelled out independently.
  const probeElo = { byTeam: new Map([[1, 1900], [2, 1800]]), leagueMean: 1850 };
  const probeStrengths = {
    1: { teamId: 1, attackHome: 1.2, attackAway: 1.2, defenceHome: 1.1, defenceAway: 1.1, overall: 1.15 },
    2: { teamId: 2, attackHome: 0.9, attackAway: 0.9, defenceHome: 0.8, defenceAway: 0.8, overall: 0.85 },
  } as Record<number, TeamStrength>;
  const shipped = cleanSheetStrengths(probeStrengths, probeElo, new Map(), ARMS[0]);
  const expectedLevel = ELO_LEVEL_SLOPE * (1900 - 1850);
  const expectedSkew = CLEAN_SHEET_SKEW_WEIGHT * (Math.log(1.2) - Math.log(1.1));
  if (Math.abs(shipped[1].defence - Math.exp((expectedLevel - expectedSkew) / 2)) > 1e-12) {
    throw new Error("arm 0 is not the shipped transform");
  }

  const label = path.basename(dataDir);
  const cases = collect(loadSeason());
  report(label, cases);

  const out = process.env.BACKTEST_CASE_OUT;
  if (out) {
    const offset = Number(label.slice(0, 4)) * 100;
    writeFileSync(out, JSON.stringify({
      label, arms: ARMS.map((a) => a.name),
      cases: cases.map((c) => ({ ...c, gameweek: offset + c.gameweek })),
    }));
    console.log(`\nteam cases written to ${out}`);
  }
}

main();
