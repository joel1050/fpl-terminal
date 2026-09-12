/**
 * Coherent goalkeeper saves: one lambda for both halves of shots faced.
 *
 * Shipped production estimates saves and goals conceded from unrelated
 * sources: saves from the keeper's own regressed per-90 rate times a
 * `savesEnvironment` multiplier, goals conceded from the team model's
 * `expectedGoalsAgainst`. Inverting the shipped gameweek-4 table back to shots
 * gives a 16-point spread of implied save percentage (0.57-0.74) against a
 * league rate of ~0.67 - the volume and concession estimates disagreeing.
 *
 * This script reparameterises: volume (`lambda`) comes from the team model,
 * skill (`p`, save percentage) from the keeper, both regressed Beta-binomial:
 *
 *   lambda = adjustment.expectedGoalsAgainst (unchanged team model)
 *   p      = (saves + kappa * p0) / (shots faced + kappa)
 *   expectedSaves = lambda * p / (1 - p), scaled by minutes share
 *
 * `p0` is the walk-forward league save percentage, never hardcoded. `kappa`
 * is the prior weight in equivalent shots faced; `Infinity` gives every keeper
 * the league rate (saves as a pure function of the team's lambda).
 *
 * Instruments, in order of authority: saves RMSE / saves-points RMSE, joint
 * shots coherence RMSE + implied save-percentage spread, whole-player
 * goalkeeper xP RMSE at actual minutes. Minutes are actual throughout, as in
 * `run.ts`, so the minutes model does not bury the signal.
 *
 *   BACKTEST_DATA_DIR=$ROOT/2025-26 npx tsx scripts/backtest/coherent-saves.ts
 *   npx tsx scripts/backtest/coherent-saves.ts --pool /tmp/cs-*.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectedFloorDivision } from "@/lib/projections/distributions";
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { playerRates, expectedPoints } from "./xp";
import { adjust, BASELINE } from "./variants";

/** Gameweek 1 has no current-season evidence, so every arm is identical there. */
const FIRST_GAMEWEEK = 2;
const EARLY_THROUGH = 5;
const BOOTSTRAP = 4000;
const SAVES_PER_POINT = 3;
/** Numerical guard only: a keeper who has saved everything would imply p = 1. */
const MAX_SAVE_PERCENTAGE = 0.95;

const KAPPAS: readonly number[] = [0, 20, 50, 100, 200, 500, Number.POSITIVE_INFINITY];
const ARM_NAMES = ["shipped", ...KAPPAS.map((k) =>
  Number.isFinite(k) ? `coherent k=${k}` : "coherent k=Inf (league rate)")];

const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const std = (values: readonly number[]) => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
};

interface Case {
  gameweek: number;
  minutes: number;
  actualSaves: number;
  actualSavesPoints: number;
  actualConceded: number;
  actualShots: number;
  actualTotalPoints: number;
  /** Team-model lambda scaled to minutes played. */
  lambdaShare: number;
  /** Implied save percentage per arm: shipped inverts to one, coherent is p. */
  implied: number[];
  predSaves: number[];
  predSavesPoints: number[];
  predShots: number[];
  predXp: number[];
  /** Diagnostics: keeper + team context for the residual checks. */
  keeperId: number;
  teamId: number;
  goals: number;
  yellowCards: number;
  redCards: number;
  expectedGoalsConceded?: number;
}

function collect(season: Season): { cases: Case[]; leagueRateByGameweek: Map<number, number> } {
  // Walk-forward league save percentage from goalkeeper rows before each gameweek.
  const gkSavesBefore = new Map<number, { saves: number; shots: number }>();
  let cumSaves = 0;
  let cumShots = 0;
  const leagueRateByGameweek = new Map<number, number>();
  for (let gw = 1; gw <= 38; gw += 1) {
    const rows = season.rowsByGameweek.get(gw) ?? [];
    leagueRateByGameweek.set(gw, cumShots > 0 ? cumSaves / cumShots : 0.661);
    for (const row of rows) {
      const pos = season.players.get(row.historicalPlayerId)?.position;
      if (pos !== "GK" || row.saves === undefined || row.goalsConceded === undefined) continue;
      cumSaves += row.saves;
      cumShots += row.saves + row.goalsConceded;
    }
    gkSavesBefore.set(gw, { saves: cumSaves, shots: cumShots });
  }

  const cases: Case[] = [];
  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(season, gameweek);
    const fixtureById = new Map((season.fixturesByGameweek.get(gameweek) ?? []).map((f) => [f.fixtureId, f]));
    const p0 = leagueRateByGameweek.get(gameweek) ?? 0.661;
    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0 || row.saves === undefined || row.goalsConceded === undefined) continue;
      const fixture = fixtureById.get(row.fixtureId);
      if (!fixture) continue;
      const player = playerAt(season, row.historicalPlayerId, gameweek, fixture, row.wasHome);
      if (!player || player.position !== "GK") continue;
      const upcoming = player.fixtures[0];
      const adjustment = adjust(upcoming, {
        ownTeam: strengths[player.teamId], opponentTeam: strengths[upcoming.opponentTeamId],
      }, BASELINE);
      const form = formBefore(season, row.historicalPlayerId, gameweek);
      const minutesShare = row.minutes / 90;
      const lambdaShare = adjustment.expectedGoalsAgainst * minutesShare;

      const previous = season.previousStatsByPlayerId.get(row.historicalPlayerId);
      const prevSaves = previous?.saves ?? 0;
      const prevConceded = previous?.goalsConceded ?? 0;
      let currSaves = 0;
      let currConceded = 0;
      for (const past of season.rowsByPlayer.get(row.historicalPlayerId) ?? []) {
        if (past.gameweek >= gameweek || past.saves === undefined || past.goalsConceded === undefined) continue;
        currSaves += past.saves;
        currConceded += past.goalsConceded;
      }

      // Arm 0: shipped production rate (regressed per-90 saves x environment).
      const shippedRates = playerRates(player, form, gameweek, undefined, strengths);
      const shippedMean = shippedRates.saves * minutesShare * adjustment.savesEnvironment;

      const implied: number[] = [];
      const predSaves: number[] = [shippedMean];
      const denom = shippedMean + lambdaShare;
      implied.push(denom > 0 ? shippedMean / denom : p0);

      for (const kappa of KAPPAS) {
        let p: number;
        if (!Number.isFinite(kappa)) {
          p = p0;
        } else {
          const shots = prevSaves + prevConceded + currSaves + currConceded;
          p = shots + kappa > 0
            ? (prevSaves + currSaves + kappa * p0) / (shots + kappa)
            : p0;
          p = Math.min(Math.max(p, 0), MAX_SAVE_PERCENTAGE);
        }
        implied.push(p);
        predSaves.push(p >= 1 ? lambdaShare * 20 : (lambdaShare * p) / (1 - p));
      }

      const predSavesPoints = predSaves.map((m) => expectedFloorDivision(m, SAVES_PER_POINT));
      const predShots = predSaves.map((m) => m + lambdaShare);

      // Whole-player xP at actual minutes: coherent arms reuse the shipped
      // components with only the saves mean replaced, so the floor division
      // and every other term are identical across arms.
      const predXp = predSaves.map((m, index) => {
        if (index === 0) {
          return expectedPoints(player, upcoming, row.minutes, shippedRates, strengths, BASELINE).total;
        }
        const env = adjustment.savesEnvironment;
        const coherentRates = {
          ...shippedRates,
          saves: minutesShare > 0 && env > 0 ? m / (minutesShare * env) : 0,
        };
        return expectedPoints(player, upcoming, row.minutes, coherentRates, strengths, BASELINE).total;
      });

      cases.push({
        gameweek,
        minutes: row.minutes,
        actualSaves: row.saves,
        actualSavesPoints: Math.floor(row.saves / SAVES_PER_POINT),
        actualConceded: row.goalsConceded,
        actualShots: row.saves + row.goalsConceded,
        actualTotalPoints: row.totalPoints,
        lambdaShare,
        implied,
        predSaves,
        predSavesPoints,
        predShots,
        predXp,
        keeperId: row.historicalPlayerId,
        teamId: player.teamId,
        goals: row.goals,
        yellowCards: row.yellowCards ?? 0,
        redCards: row.redCards ?? 0,
        expectedGoalsConceded: row.expectedGoalsConceded,
      });
    }
  }
  return { cases, leagueRateByGameweek };
}

const savesRmse = (list: readonly Case[], index: number) =>
  Math.sqrt(mean(list.map((c) => (c.predSaves[index] - c.actualSaves) ** 2)));
const savesPointsRmse = (list: readonly Case[], index: number) =>
  Math.sqrt(mean(list.map((c) => (c.predSavesPoints[index] - c.actualSavesPoints) ** 2)));
const shotsRmse = (list: readonly Case[], index: number) =>
  Math.sqrt(mean(list.map((c) => (c.predShots[index] - c.actualShots) ** 2)));
const xpRmse = (list: readonly Case[], index: number) =>
  Math.sqrt(mean(list.map((c) => (c.predXp[index] - c.actualTotalPoints) ** 2)));

/** Paired bootstrap over gameweek clusters: keepers in one round share fixtures. */
function interval(
  cases: readonly Case[], index: number,
  score: (list: readonly Case[], i: number) => number, seed: number,
): { lo: number; hi: number } {
  const byGameweek = new Map<number, Case[]>();
  for (const c of cases) (byGameweek.get(c.gameweek) ?? byGameweek.set(c.gameweek, []).get(c.gameweek)!).push(c);
  const gameweeks = [...byGameweek.keys()];
  let state = seed;
  const random = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const deltas: number[] = [];
  for (let draw = 0; draw < BOOTSTRAP; draw += 1) {
    const rows: Case[] = [];
    for (let i = 0; i < gameweeks.length; i += 1) rows.push(...byGameweek.get(gameweeks[Math.floor(random() * gameweeks.length)])!);
    deltas.push(score(rows, index) - score(rows, 0));
  }
  deltas.sort((a, b) => a - b);
  return { lo: deltas[Math.floor(BOOTSTRAP * 0.025)], hi: deltas[Math.floor(BOOTSTRAP * 0.975)] };
}

const fmt = (v: number, places = 5) => (v >= 0 ? "+" : "") + v.toFixed(places);
const verdictOf = (lo: number, hi: number) => (hi < 0 ? "BETTER" : lo > 0 ? "WORSE " : "  ns  ");

function window(title: string, cases: readonly Case[], seed: number): void {
  if (cases.length === 0) return;
  console.log(`\n${title}: ${cases.length} goalkeeper appearances`);
  console.log("  arm                           savesRMSE    dRMSE    95% CI (gw clusters)     verdict   ptsRMSE    dPts   shotsRMSE   dShots    xpRMSE     dXp   implSave%sd");
  ARM_NAMES.forEach((name, index) => {
    const score = savesRmse(cases, index);
    const points = savesPointsRmse(cases, index);
    const shots = shotsRmse(cases, index);
    const xp = xpRmse(cases, index);
    const spread = std(cases.map((c) => c.implied[index]));
    if (index === 0) {
      console.log(`  ${name.padEnd(29)} ${score.toFixed(5)}       -                              -        ${points.toFixed(5)}     -     ${shots.toFixed(5)}      -      ${xp.toFixed(5)}     -      ${spread.toFixed(4)}`);
      return;
    }
    const { lo, hi } = interval(cases, index, savesRmse, seed + index);
    const { lo: loXp, hi: hiXp } = interval(cases, index, xpRmse, seed + 100 + index);
    const base = { saves: savesRmse(cases, 0), points: savesPointsRmse(cases, 0), shots: shotsRmse(cases, 0), xp: xpRmse(cases, 0) };
    console.log(`  ${name.padEnd(29)} ${score.toFixed(5)}  ${fmt(score - base.saves)}  [${fmt(lo)}, ${fmt(hi)}]  ${verdictOf(lo, hi)}  ${points.toFixed(5)}  ${fmt(points - base.points, 4)}  ${shots.toFixed(5)}  ${fmt(shots - base.shots, 4)}  ${xp.toFixed(5)}  ${fmt(xp - base.xp, 4)}[${fmt(loXp, 3)},${fmt(hiXp, 3)}]  ${spread.toFixed(4)}`);
  });
}

function report(label: string, cases: readonly Case[]): void {
  console.log(`\n=== ${label}: coherent saves (team lambda x keeper save percentage) ===`);
  console.log(`mean saves ${mean(cases.map((c) => c.actualSaves)).toFixed(2)}, mean conceded ${mean(cases.map((c) => c.actualConceded)).toFixed(2)}, mean lambda-share ${mean(cases.map((c) => c.lambdaShare)).toFixed(2)}`);
  const gw = (c: Case) => c.gameweek % 100;
  window(`gameweeks ${FIRST_GAMEWEEK}-${EARLY_THROUGH}`,
    cases.filter((c) => gw(c) <= EARLY_THROUGH), 20260921);
  window(`gameweeks ${EARLY_THROUGH + 1}-38`, cases.filter((c) => gw(c) > EARLY_THROUGH), 20260922);
  window("all gameweeks", cases, 20260923);
}

function diagnostics(label: string, cases: readonly Case[], bestIndex: number): void {
  console.log(`\n--- diagnostics (${label}; coherent arm = ${ARM_NAMES[bestIndex]}) ---`);
  // Coupling: do saves errors track lambda errors?
  const shipSavesErr = cases.map((c) => c.predSaves[0] - c.actualSaves);
  const cohSavesErr = cases.map((c) => c.predSaves[bestIndex] - c.actualSaves);
  const lambdaErr = cases.map((c) => c.lambdaShare - c.actualConceded);
  const corr = (a: readonly number[], b: readonly number[]) => {
    const ma = mean(a);
    const mb = mean(b);
    const num = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
    const den = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0) * b.reduce((s, v) => s + (v - mb) ** 2, 0));
    return den > 0 ? num / den : Number.NaN;
  };
  console.log(`corr(saves error, lambda error): shipped ${corr(shipSavesErr, lambdaErr).toFixed(3)}, coherent ${corr(cohSavesErr, lambdaErr).toFixed(3)} (higher = inherits team-model error)`);

  // Shot quality: predicted vs realized shots by team, and xGA per shot spread.
  const byTeam = new Map<number, { pred: number; actual: number; xgc: number; n: number }>();
  for (const c of cases) {
    const e = byTeam.get(c.teamId) ?? { pred: 0, actual: 0, xgc: 0, n: 0 };
    e.pred += c.predSaves[bestIndex] + c.lambdaShare;
    e.actual += c.actualShots;
    e.xgc += c.expectedGoalsConceded ?? 0;
    e.n += 1;
    byTeam.set(c.teamId, e);
  }
  const teams = [...byTeam.entries()].map(([teamId, e]) => ({
    teamId, n: e.n, predPer: e.pred / e.n, actualPer: e.actual / e.n,
    xgaPerShot: e.actual > 0 ? e.xgc / e.actual : Number.NaN,
  })).sort((a, b) => b.actualPer - a.actualPer);
  console.log("team  n  predShots/row  actualShots/row  xGA-per-shot");
  for (const t of teams) {
    console.log(`  ${String(t.teamId).padStart(2)} ${String(t.n).padStart(3)}  ${t.predPer.toFixed(2).padStart(12)}  ${t.actualPer.toFixed(2).padStart(15)}  ${Number.isFinite(t.xgaPerShot) ? t.xgaPerShot.toFixed(3) : "-"}`);
  }
  console.log(`xGA-per-shot spread across teams: sd ${std(teams.filter((t) => Number.isFinite(t.xgaPerShot)).map((t) => t.xgaPerShot)).toFixed(4)} (wide = constant-quality assumption fails)`);

  // Penalties / red cards: are the worst residuals a handful of distorted rows?
  const resid = cases.map((c) => ({
    c, e: Math.abs(c.predSaves[bestIndex] - c.actualSaves),
  })).sort((a, b) => b.e - a.e).slice(0, 8);
  console.log("worst coherent residuals (gw, keeper, min, pred-vs-actual saves, conceded, team goals, YC/RC):");
  for (const { c, e } of resid) {
    console.log(`  gw${c.gameweek % 100} keeper#${c.keeperId} ${c.minutes}' pred ${c.predSaves[bestIndex].toFixed(1)} vs ${c.actualSaves} (err ${e.toFixed(1)}), conceded ${c.actualConceded}, teamGoals ${c.goals}, YC ${c.yellowCards} RC ${c.redCards}`);
  }
}

function main(): void {
  const poolIndex = process.argv.indexOf("--pool");
  if (poolIndex >= 0) {
    const loaded = process.argv.slice(poolIndex + 1)
      .map((file) => JSON.parse(readFileSync(file, "utf8")) as { label: string; arms: string[]; cases: Case[] });
    for (const item of loaded) {
      if (item.arms.join("|") !== ARM_NAMES.join("|")) throw new Error(`arm sets differ: ${item.label}`);
    }
    const pooled = loaded.flatMap((l) => l.cases);
    report(`pooled: ${loaded.map((l) => l.label).join(", ")}`, pooled);
    diagnostics("pooled", pooled, 4);
    return;
  }

  const dataDir = process.env.BACKTEST_DATA_DIR ?? path.join(path.resolve(__dirname, "../.."), "data/generated");
  const label = path.basename(dataDir);
  const season = loadSeason();
  const { cases, leagueRateByGameweek } = collect(season);
  if (cases.length === 0) {
    console.error("no goalkeeper rows carry per-match saves and goals conceded; re-run prepare-seasons.ts with the current ingest");
    process.exit(1);
  }
  const rates = [...leagueRateByGameweek.entries()].filter(([gw]) => gw >= FIRST_GAMEWEEK)
    .map(([, r]) => r);
  console.log(`walk-forward league save percentage: ${Math.min(...rates).toFixed(4)}-${Math.max(...rates).toFixed(4)} (season ${(mean(rates)).toFixed(4)})`);
  report(label, cases);
  diagnostics(label, cases, 4);

  const out = process.env.BACKTEST_CASE_OUT;
  if (out) {
    const offset = Number(label.slice(0, 4)) * 100;
    writeFileSync(out, JSON.stringify({
      label, arms: ARM_NAMES,
      cases: cases.map((c) => ({ ...c, gameweek: offset + c.gameweek })),
    }));
    console.log(`\ncases written to ${out}`);
  }
}

main();
