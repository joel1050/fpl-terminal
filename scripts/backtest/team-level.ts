/**
 * Does the team-strength *level* need fixing, and does ClubElo help fix it?
 *
 * Section 3's strengths are normalized ratios centred on 1.0. Every consumer
 * divides one by another - `ownAttack / opponentDefence`, or a player's own form
 * by his team's attack - and a ratio cancels the level, so nothing in the
 * pipeline ever needed the absolute scale to be right. It is not: the level
 * `log(attack) + log(defence)` is markedly narrower than an independent Poisson
 * fitted to the same season's xG.
 *
 * Four questions, one grid:
 *   1  rescale the level onto the goal scale                     LEVEL_SCALES
 *   2  take part of the level from Elo instead                   ELO_WEIGHTS
 *   3  is the Elo-gap `base` redundant once the level is right   BASE arms
 *   4  do the clamps still earn their place                      CLAMP arms
 *
 * Scored on team xG, which the README names as the instrument for the attack
 * side, and on clean-sheet Brier for the defensive side. Walk-forward: every
 * strength is built from gameweeks strictly before the one being scored.
 *
 *   BACKTEST_DATA_DIR=<prepared 2025-26> npx tsx scripts/backtest/team-level.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TeamStrength } from "@/types/projection";
import { cleanSheetFromRates } from "@/lib/projections/fixtureAdjustment";
import { CLEAN_SHEET_SKEW_WEIGHT } from "@/lib/projections/cleanSheetStrength";
import { loadSeason, strengthsBefore } from "./season";

const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 4000;
const VENUE = [1.102, 0.898] as const;
const LEAGUE_XG = 1.408;
const SHIPPED_RATIO_CLAMP = [0.7, 1.35] as const;
const SHIPPED_MULTIPLIER_CLAMP = [0.55, 1.6] as const;
const OPEN = [0.001, 1000] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mean = (v: readonly number[]) => v.reduce((s, x) => s + x, 0) / v.length;

interface EloRow { fixtureId: number; homeElo: number; awayElo: number; leagueMeanElo: number; leagueSdElo: number }
const DATA_DIR = process.env.BACKTEST_DATA_DIR ?? path.join(path.resolve(__dirname, "../.."), "data/generated");
const ELO_PATH = path.join(DATA_DIR, "backtest-elo.json");
const ELO: EloRow[] = existsSync(ELO_PATH) ? (JSON.parse(readFileSync(ELO_PATH, "utf8")) as EloRow[]) : [];
if (ELO.length === 0) {
  console.error(`no backtest-elo.json in ${DATA_DIR}; run scripts/backtest/elo-history.ts first`);
  process.exit(1);
}

interface Arm {
  name: string;
  /** Multiplies the level measured from the strengths themselves. 1 = shipped. */
  levelScale: number;
  /** Share of the level taken from Elo instead of from the strengths. */
  eloWeight: number;
  /** Elo-gap difficulty on top of the strength ratio, as shipped. */
  useBase: boolean;
  ratioClamp: readonly [number, number];
  multiplierClamp: readonly [number, number];
}

/**
 * The Elo z-score is put on the strengths' own level scale before it is blended,
 * so `eloWeight` moves between two readings of the same quantity rather than
 * between two different units. The scale is measured from this gameweek's own
 * teams, which is the same pre-match information every other term reads.
 */
function reshape(
  strengths: Record<number, TeamStrength>,
  eloZ: Map<number, number>,
  arm: Arm,
): Map<number, { attack: number; defence: number }> {
  const ids = Object.keys(strengths).map(Number).filter((id) => eloZ.has(id));
  const raw = ids.map((id) => {
    const a = (strengths[id].attackHome + strengths[id].attackAway) / 2;
    const d = (strengths[id].defenceHome + strengths[id].defenceAway) / 2;
    return { id, level: Math.log(a) + Math.log(d), skew: Math.log(a) - Math.log(d) };
  });
  const meanLevel = mean(raw.map((r) => r.level));
  const sdLevel = Math.sqrt(mean(raw.map((r) => (r.level - meanLevel) ** 2)));
  const out = new Map<number, { attack: number; defence: number }>();
  for (const team of raw) {
    const own = team.level - meanLevel;
    const fromElo = eloZ.get(team.id)! * sdLevel;
    const level = arm.levelScale * ((1 - arm.eloWeight) * own + arm.eloWeight * fromElo);
    const skew = CLEAN_SHEET_SKEW_WEIGHT * team.skew;
    out.set(team.id, { attack: Math.exp((level + skew) / 2), defence: Math.exp((level - skew) / 2) });
  }
  return out;
}

const ARMS: Arm[] = [];
const base = { levelScale: 1, eloWeight: 0, useBase: true, ratioClamp: SHIPPED_RATIO_CLAMP, multiplierClamp: SHIPPED_MULTIPLIER_CLAMP };
ARMS.push({ ...base, name: "shipped (level as is)" });
for (const s of [1.35, 1.69, 2.0]) ARMS.push({ ...base, name: `1  level x${s.toFixed(2)}`, levelScale: s });
for (const w of [0.25, 0.5, 0.75, 1.0]) ARMS.push({ ...base, name: `2  level x1.69, Elo ${w.toFixed(2)}`, levelScale: 1.69, eloWeight: w });
ARMS.push({ ...base, name: "3  level x1.69, no base", levelScale: 1.69, useBase: false });
ARMS.push({ ...base, name: "3  level x1.69 Elo .5, no base", levelScale: 1.69, eloWeight: 0.5, useBase: false });
ARMS.push({ ...base, name: "3  shipped, no base", useBase: false });
ARMS.push({ ...base, name: "4  level x1.69, no clamps", levelScale: 1.69, ratioClamp: OPEN, multiplierClamp: OPEN });
ARMS.push({ ...base, name: "4  level x1.69 Elo .5, no clamps", levelScale: 1.69, eloWeight: 0.5, ratioClamp: OPEN, multiplierClamp: OPEN });
ARMS.push({ ...base, name: "4  shipped, no clamps", ratioClamp: OPEN, multiplierClamp: OPEN });
ARMS.push({ ...base, name: "4  x1.69 no base, no clamps", levelScale: 1.69, useBase: false, ratioClamp: OPEN, multiplierClamp: OPEN });

interface Row { gameweek: number; xgPredicted: number[]; xgActual: number; csPredicted: number[]; csActual: number; bound: boolean[] }

function main(): void {
  const season = loadSeason();
  const eloByFixture = new Map(ELO.map((r) => [r.fixtureId, r]));
  const rows: Row[] = [];

  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(season, gameweek);
    const fixtures = season.fixturesByGameweek.get(gameweek) ?? [];
    const samples = new Map<number, number[]>();
    for (const fx of fixtures) {
      const row = eloByFixture.get(fx.fixtureId);
      if (!row || !(row.leagueSdElo > 0)) continue;
      const push = (id: number, elo: number) =>
        (samples.get(id) ?? samples.set(id, []).get(id)!).push((elo - row.leagueMeanElo) / row.leagueSdElo);
      push(fx.homeTeamId, row.homeElo);
      push(fx.awayTeamId, row.awayElo);
    }
    const eloZ = new Map([...samples].map(([id, xs]) => [id, mean(xs)]));
    if (eloZ.size < 2) continue;
    const shaped = ARMS.map((arm) => reshape(strengths, eloZ, arm));

    for (const fx of fixtures) {
      const eloRow = eloByFixture.get(fx.fixtureId);
      if (!eloRow) continue;
      for (const isHome of [true, false]) {
        const ownId = isHome ? fx.homeTeamId : fx.awayTeamId;
        const oppId = isHome ? fx.awayTeamId : fx.homeTeamId;
        if (!shaped[0].has(ownId) || !shaped[0].has(oppId)) continue;
        // The shipped Elo-gap difficulty, as normalizeFixtures builds it.
        const ownElo = (isHome ? eloRow.homeElo : eloRow.awayElo) + (isHome ? 40 : -40);
        const oppElo = isHome ? eloRow.awayElo : eloRow.homeElo;
        const difficulty = clamp(3 + (oppElo - ownElo) / 200, 1, 5);
        const baseTerm = 1 + (3 - difficulty) * 0.07;
        const venue = isHome ? VENUE[0] : VENUE[1];

        const xgPredicted: number[] = [], csPredicted: number[] = [], bound: boolean[] = [];
        ARMS.forEach((arm, i) => {
          const own = shaped[i].get(ownId)!, opp = shaped[i].get(oppId)!;
          const rawRatio = own.attack / opp.defence;
          const ratio = clamp(rawRatio, arm.ratioClamp[0], arm.ratioClamp[1]);
          const rawMultiplier = (arm.useBase ? baseTerm : 1) * venue * ratio;
          const multiplier = clamp(rawMultiplier, arm.multiplierClamp[0], arm.multiplierClamp[1]);
          xgPredicted.push(LEAGUE_XG * multiplier);
          csPredicted.push(cleanSheetFromRates(isHome, own.defence, opp.attack).cleanSheetProbability);
          bound.push(rawRatio !== ratio || rawMultiplier !== multiplier);
        });
        rows.push({
          gameweek, xgPredicted, csPredicted, bound,
          xgActual: isHome ? fx.homeXg : fx.awayXg,
          csActual: (isHome ? fx.awayGoals : fx.homeGoals) === 0 ? 1 : 0,
        });
      }
    }
  }

  const byGameweek = new Map<number, Row[]>();
  for (const r of rows) (byGameweek.get(r.gameweek) ?? byGameweek.set(r.gameweek, []).get(r.gameweek)!).push(r);
  const gameweeks = [...byGameweek.keys()];
  const xgRmse = (list: readonly Row[], i: number) =>
    Math.sqrt(list.reduce((s, r) => s + (r.xgPredicted[i] - r.xgActual) ** 2, 0) / list.length);
  const csBrier = (list: readonly Row[], i: number) =>
    list.reduce((s, r) => s + (r.csPredicted[i] - r.csActual) ** 2, 0) / list.length;
  const corr = (i: number) => {
    const x = rows.map((r) => r.xgPredicted[i]), y = rows.map((r) => r.xgActual);
    const mx = mean(x), my = mean(y);
    const cov = x.reduce((s, v, k) => s + (v - mx) * (y[k] - my), 0);
    return cov / Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0) * y.reduce((s, v) => s + (v - my) ** 2, 0));
  };

  let seed = 20260909;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const resamples = Array.from({ length: BOOTSTRAP }, () =>
    Array.from({ length: gameweeks.length }, () => gameweeks[Math.floor(rand() * gameweeks.length)]));

  console.log(`walk-forward, gameweeks ${FIRST_GAMEWEEK}-38, ${rows.length} team-fixtures`);
  console.log(`actual: mean team xG ${mean(rows.map((r) => r.xgActual)).toFixed(3)}, clean-sheet rate ${mean(rows.map((r) => r.csActual)).toFixed(3)}\n`);
  console.log("arm                                xG RMSE   dRMSE   95% CI (gw clusters)      corr   CS Brier   dBrier    clamped");
  console.log("-".repeat(122));
  const baseXg = xgRmse(rows, 0), baseCs = csBrier(rows, 0);
  ARMS.forEach((arm, i) => {
    const xg = xgRmse(rows, i), cs = csBrier(rows, i);
    const clamped = (100 * rows.filter((r) => r.bound[i]).length) / rows.length;
    if (i === 0) {
      console.log(`${arm.name.padEnd(33)} ${xg.toFixed(4)}       -                             ${corr(i).toFixed(4)}   ${cs.toFixed(5)}        -     ${clamped.toFixed(1)}%`);
      return;
    }
    const deltas = resamples.map((s) => {
      const list = s.flatMap((gw) => byGameweek.get(gw)!);
      return xgRmse(list, i) - xgRmse(list, 0);
    }).sort((a, b) => a - b);
    const lo = deltas[Math.floor(0.025 * BOOTSTRAP)], hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
    const verdict = hi < 0 ? "BETTER" : lo > 0 ? "WORSE " : "  ns  ";
    const sign = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(4)}`;
    console.log(`${arm.name.padEnd(33)} ${xg.toFixed(4)}  ${sign(xg - baseXg)}  [${sign(lo)}, ${sign(hi)}] ${verdict}  ${corr(i).toFixed(4)}   ${cs.toFixed(5)}  ${sign(cs - baseCs)}     ${clamped.toFixed(1)}%`);
  });
}

main();
