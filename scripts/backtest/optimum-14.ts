/**
 * Optimum sweep for the four "100% testable" knobs:
 *   1. table-path compression (retained weight + base rate)
 *   2. attack-ratio clamp window
 *   3. outer multiplier clamp window
 *   4. rated-path skew weight (+ rated shrink control)
 *
 * Walk-forward: strengths from gameweeks strictly before the scored one.
 * Team-fixture cases, GW 6-38. GW-cluster bootstrap CIs vs shipped.
 * Elo ratings come from backtest-elo.json (walk-forward, pre-match).
 *
 *   BACKTEST_DATA_DIR=/tmp/fpl-backtest-seasons/2025-26 OUT=/tmp/opt14-2025-26.jsonl npx tsx scripts/backtest/optimum-14.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadSeason, strengthsBefore } from "./season";
import {
  interpolatedCleanSheet,
  cleanSheetFromRates,
  continuousDifficultyMultiplier,
  LEAGUE_MEAN_XG,
} from "@/lib/projections/fixtureAdjustment";
import { ELO_LEVEL_SLOPE } from "@/lib/projections/cleanSheetStrength";

const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 4000;
const SHIPPED_RETAINED = 0.75;
const SHIPPED_BASE = 0.25;
const SHIPPED_SKEW = 0.6;

const RETAINED_GRID = [1.0, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6];
const BASE_GRID = [0.22, 0.25, 0.27, 0.3];
const SKEW_GRID = [0, 0.3, 0.5, 0.6, 0.75, 0.85, 1.0];
const RATED_SHRINK_GRID = [1.0, 0.95, 0.9, 0.85, 0.8];
const RATIO_WINDOWS: { name: string; lo: number; hi: number }[] = [
  { name: "[0.78,1.22]", lo: 0.78, hi: 1.22 },
  { name: "[0.70,1.35]", lo: 0.7, hi: 1.35 },
  { name: "[0.65,1.50]", lo: 0.65, hi: 1.5 },
  { name: "[0.60,1.60]", lo: 0.6, hi: 1.6 },
  { name: "[0.55,1.75]", lo: 0.55, hi: 1.75 },
  { name: "open", lo: 0.001, hi: 1000 },
];
const OUTER_WINDOWS: { name: string; lo: number; hi: number }[] = [
  { name: "[0.55,1.60]", lo: 0.55, hi: 1.6 },
  { name: "[0.50,1.80]", lo: 0.5, hi: 1.8 },
  { name: "[0.40,2.20]", lo: 0.4, hi: 2.2 },
  { name: "open", lo: 0.001, hi: 1000 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const compress = (p: number, w: number, b: number) => p - (1 - w) * Math.max(0, p - b);

interface EloRow { fixtureId: number; homeElo: number; awayElo: number; leagueMeanElo: number }
const dataDir = process.env.BACKTEST_DATA_DIR ?? path.join(path.resolve(__dirname, "../.."), "data/generated");
const eloPath = path.join(dataDir, "backtest-elo.json");
const eloRows: EloRow[] = existsSync(eloPath) ? (JSON.parse(readFileSync(eloPath, "utf8")) as EloRow[]) : [];
const eloByFixture = new Map(eloRows.map((r) => [r.fixtureId, r]));

function eloBefore(fixtures: { fixtureId: number; gameweek: number; homeTeamId: number; awayTeamId: number }[], gameweek: number) {
  const byTeam = new Map<number, number>();
  let leagueMean = 0;
  for (const f of fixtures.filter((x) => x.gameweek < gameweek && eloByFixture.has(x.fixtureId)).sort((a, b) => a.gameweek - b.gameweek)) {
    const row = eloByFixture.get(f.fixtureId)!;
    byTeam.set(f.homeTeamId, row.homeElo);
    byTeam.set(f.awayTeamId, row.awayElo);
    leagueMean = row.leagueMeanElo;
  }
  return { byTeam, leagueMean };
}

interface TC {
  gw: number; isHome: boolean;
  ownDef: number; oppAtt: number; ownAtt: number; oppDef: number;
  base: number;
  eloOwn: number | undefined; eloOpp: number | undefined; eloMean: number;
  actualCS: number; actualGoalsAgainst: number; actualXG: number;
}

function main(): void {
  const season = loadSeason();
  const cases: TC[] = [];
  for (let gw = FIRST_GAMEWEEK; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const { byTeam, leagueMean } = eloBefore(season.fixtures, gw);
    for (const fx of season.fixturesByGameweek.get(gw) ?? []) {
      const h = strengths[fx.homeTeamId]; const a = strengths[fx.awayTeamId];
      if (!h || !a) continue;
      const homeBase = continuousDifficultyMultiplier(fx.homeDifficulty ?? 3);
      const awayBase = continuousDifficultyMultiplier(fx.awayDifficulty ?? 3);
      cases.push({
        gw, isHome: true,
        ownDef: (h.defenceHome + h.defenceAway) / 2, oppAtt: (a.attackHome + a.attackAway) / 2,
        ownAtt: (h.attackHome + h.attackAway) / 2, oppDef: (a.defenceHome + a.defenceAway) / 2,
        base: homeBase,
        eloOwn: byTeam.get(fx.homeTeamId), eloOpp: byTeam.get(fx.awayTeamId), eloMean: leagueMean,
        actualCS: fx.awayGoals === 0 ? 1 : 0, actualGoalsAgainst: fx.awayGoals, actualXG: fx.awayXg,
      });
      cases.push({
        gw, isHome: false,
        ownDef: (a.defenceHome + a.defenceAway) / 2, oppAtt: (h.attackHome + h.attackAway) / 2,
        ownAtt: (a.attackHome + a.attackAway) / 2, oppDef: (h.defenceHome + h.defenceAway) / 2,
        base: awayBase,
        eloOwn: byTeam.get(fx.awayTeamId), eloOpp: byTeam.get(fx.homeTeamId), eloMean: leagueMean,
        actualCS: fx.homeGoals === 0 ? 1 : 0, actualGoalsAgainst: fx.homeGoals, actualXG: fx.homeXg,
      });
    }
  }

  const byGw = new Map<number, TC[]>();
  for (const c of cases) (byGw.get(c.gw) ?? byGw.set(c.gw, []).get(c.gw)!).push(c);
  const gws = [...byGw.keys()];
  let seed = 20260911;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const resamples = Array.from({ length: BOOTSTRAP }, () =>
    Array.from({ length: gws.length }, () => gws[Math.floor(rand() * gws.length)]));

  // ---- family 1: table compression ----
  const tableRaw = cases.map((c) => interpolatedCleanSheet(c.isHome, c.ownDef, c.oppAtt));
  const brier = (pred: number[]) => cases.reduce((s, c, i) => s + (pred[i] - c.actualCS) ** 2, 0) / cases.length;
  const brierOn = (list: TC[], pred: number[], idx: Map<TC, number>) =>
    list.reduce((s, c) => s + (pred[idx.get(c)!] - c.actualCS) ** 2, 0) / list.length;
  const idx = new Map(cases.map((c, i) => [c, i] as const));
  type Res = { name: string; brier: number; d: number; lo: number; hi: number; verdict: string };
  const shipTable = tableRaw.map((p) => compress(p, SHIPPED_RETAINED, SHIPPED_BASE));
  const baseBrier = brier(shipTable);
  const rowFor = (name: string, pred: number[]): Res => {
    const b = brier(pred);
    const deltas = resamples.map((s) => {
      const list = s.flatMap((gw) => byGw.get(gw)!);
      return brierOn(list, pred, idx) - brierOn(list, shipTable, idx);
    }).sort((x, y) => x - y);
    const lo = deltas[Math.floor(0.025 * BOOTSTRAP)]; const hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
    return { name, brier: b, d: b - baseBrier, lo, hi, verdict: hi < 0 ? "BETTER" : lo > 0 ? "WORSE" : "ns" };
  };
  console.log(`\n1. TABLE COMPRESSION (base ${SHIPPED_BASE} unless named), Brier, n=${cases.length}, base=${baseBrier.toFixed(5)}`);
  const t1: Res[] = RETAINED_GRID.map((w) => rowFor(`retained ${w.toFixed(2)}`, tableRaw.map((p) => compress(p, w, SHIPPED_BASE))));
  for (const r of t1) console.log(`  ${r.name.padEnd(16)} ${r.brier.toFixed(5)} ${r.d >= 0 ? "+" : ""}${r.d.toFixed(5)} [${r.lo >= 0 ? "+" : ""}${r.lo.toFixed(5)},${r.hi >= 0 ? "+" : ""}${r.hi.toFixed(5)}] ${r.verdict}`);
  const bestW = [...t1].sort((a, b) => a.brier - b.brier)[0];
  console.log(`  best retained in-grid: ${bestW.name} (${bestW.verdict})`);

  // ---- family 4a: rated skew ----
  const ratedRaw = (skewW: number): (number | undefined)[] => cases.map((c) => {
    if (c.eloOwn === undefined || c.eloOpp === undefined) return undefined;
    const mk = (elo: number, att: number, def: number) => {
      const level = ELO_LEVEL_SLOPE * (elo - c.eloMean);
      const skew = skewW * (Math.log(att) - Math.log(def));
      return { attack: Math.exp((level + skew) / 2), defence: Math.exp((level - skew) / 2) };
    };
    const own = mk(c.eloOwn, c.ownAtt, c.ownDef); const opp = mk(c.eloOpp, c.oppAtt, c.oppDef);
    return cleanSheetFromRates(c.isHome, own.defence, opp.attack).cleanSheetProbability;
  });
  const ratedIdx = cases.map((_, i) => i).filter((i) => ratedRaw(SHIPPED_SKEW)[i] !== undefined);
  const rbrier = (pred: (number | undefined)[]) => ratedIdx.reduce((s, i) => s + (pred[i]! - cases[i].actualCS) ** 2, 0) / ratedIdx.length;
  const rbrierOn = (list: TC[], pred: (number | undefined)[]) => {
    const sub = list.filter((c) => pred[idx.get(c)!] !== undefined);
    return sub.reduce((s, c) => s + (pred[idx.get(c)!]! - c.actualCS) ** 2, 0) / sub.length;
  };
  const shipRated = ratedRaw(SHIPPED_SKEW);
  const baseR = rbrier(shipRated);
  console.log(`\n4a. RATED SKEW, Brier, n=${ratedIdx.length}, shipped 0.60 base=${baseR.toFixed(5)}`);
  for (const w of SKEW_GRID) {
    const pred = ratedRaw(w); const b = rbrier(pred);
    const deltas = resamples.map((s) => {
      const list = s.flatMap((gw) => byGw.get(gw)!);
      return rbrierOn(list, pred) - rbrierOn(list, shipRated);
    }).sort((x, y) => x - y);
    const lo = deltas[Math.floor(0.025 * BOOTSTRAP)]; const hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
    console.log(`  skew ${w.toFixed(2).padEnd(5)} ${b.toFixed(5)} ${b - baseR >= 0 ? "+" : ""}${(b - baseR).toFixed(5)} [${lo >= 0 ? "+" : ""}${lo.toFixed(5)},${hi >= 0 ? "+" : ""}${hi.toFixed(5)}] ${hi < 0 ? "BETTER" : lo > 0 ? "WORSE" : "ns"}`);
  }

  // ---- family 1b: rated shrink (control) ----
  console.log(`\n1b. RATED SHRINK to 0.25 at shipped skew, Brier`);
  for (const k of RATED_SHRINK_GRID) {
    const pred = shipRated.map((p) => (p === undefined ? undefined : SHIPPED_BASE + k * (p - SHIPPED_BASE)));
    const b = rbrier(pred);
    const deltas = resamples.map((s) => {
      const list = s.flatMap((gw) => byGw.get(gw)!);
      return rbrierOn(list, pred) - rbrierOn(list, shipRated);
    }).sort((x, y) => x - y);
    const lo = deltas[Math.floor(0.025 * BOOTSTRAP)]; const hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
    console.log(`  shrink ${k.toFixed(2)}  ${b.toFixed(5)} ${b - baseR >= 0 ? "+" : ""}${(b - baseR).toFixed(5)} [${lo >= 0 ? "+" : ""}${lo.toFixed(5)},${hi >= 0 ? "+" : ""}${hi.toFixed(5)}] ${hi < 0 ? "BETTER" : lo > 0 ? "WORSE" : "ns"}`);
  }

  // ---- families 2+3: clamps on team-xG RMSE (base=1 neutral) ----
  // Target is team xG (process), not realized goals (finishing noise).
  const leagueAvg = season.leagueAverageXg;
  const rmse = (pred: number[]) => Math.sqrt(cases.reduce((s, c, i) => s + (pred[i] - c.actualXG) ** 2, 0) / cases.length);
  const rmseOn = (list: TC[], pred: number[]) => Math.sqrt(list.reduce((s, c) => s + (pred[idx.get(c)!] - c.actualXG) ** 2, 0) / list.length);
  const predFor = (rLo: number, rHi: number, mLo: number, mHi: number, withBase = false) => cases.map((c) => {
    const venue = c.isHome ? 1.102 : 0.898;
    const base = withBase ? c.base : 1;
    return leagueAvg * clamp(base * clamp(c.ownAtt / c.oppDef, rLo, rHi) * venue, mLo, mHi);
  });
  const shipXG = predFor(0.7, 1.35, 0.55, 1.6);
  const baseX = rmse(shipXG);
  console.log(`\n2+3. CLAMP SWEEP, team-xG RMSE (base=1, leagueAvg=${leagueAvg.toFixed(3)}), base=${baseX.toFixed(5)}`);
  for (const r of RATIO_WINDOWS) {
    const pred = predFor(r.lo, r.hi, 0.55, 1.6);
    const b = rmse(pred);
    const deltas = resamples.map((s) => {
      const list = s.flatMap((gw) => byGw.get(gw)!);
      return rmseOn(list, pred) - rmseOn(list, shipXG);
    }).sort((x, y) => x - y);
    const lo = deltas[Math.floor(0.025 * BOOTSTRAP)]; const hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
    console.log(`  ratio ${r.name.padEnd(11)} ${b.toFixed(5)} ${b - baseX >= 0 ? "+" : ""}${(b - baseX).toFixed(5)} [${lo >= 0 ? "+" : ""}${lo.toFixed(5)},${hi >= 0 ? "+" : ""}${hi.toFixed(5)}] ${hi < 0 ? "BETTER" : lo > 0 ? "WORSE" : "ns"}`);
  }
  for (const m of OUTER_WINDOWS) {
    const pred = predFor(0.7, 1.35, m.lo, m.hi);
    const b = rmse(pred);
    const deltas = resamples.map((s) => {
      const list = s.flatMap((gw) => byGw.get(gw)!);
      return rmseOn(list, pred) - rmseOn(list, shipXG);
    }).sort((x, y) => x - y);
    const lo = deltas[Math.floor(0.025 * BOOTSTRAP)]; const hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
    console.log(`  outer ${m.name.padEnd(11)} ${b.toFixed(5)} ${b - baseX >= 0 ? "+" : ""}${(b - baseX).toFixed(5)} [${lo >= 0 ? "+" : ""}${lo.toFixed(5)},${hi >= 0 ? "+" : ""}${hi.toFixed(5)}] ${hi < 0 ? "BETTER" : lo > 0 ? "WORSE" : "ns"}`);
  }
  console.log(`  -- joint (outer must bind, so ratio open) --`);
  for (const m of OUTER_WINDOWS) {
    const pred = predFor(0.001, 1000, m.lo, m.hi);
    const b = rmse(pred);
    const deltas = resamples.map((s) => {
      const list = s.flatMap((gw) => byGw.get(gw)!);
      return rmseOn(list, pred) - rmseOn(list, shipXG);
    }).sort((x, y) => x - y);
    const lo = deltas[Math.floor(0.025 * BOOTSTRAP)]; const hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
    console.log(`  ratio open + outer ${m.name.padEnd(11)} ${b.toFixed(5)} ${b - baseX >= 0 ? "+" : ""}${(b - baseX).toFixed(5)} [${lo >= 0 ? "+" : ""}${lo.toFixed(5)},${hi >= 0 ? "+" : ""}${hi.toFixed(5)}] ${hi < 0 ? "BETTER" : lo > 0 ? "WORSE" : "ns"}`);
  }
  console.log(`  -- with live FDR base (production shape) --`);
  const shipBase = predFor(0.7, 1.35, 0.55, 1.6, true);
  const baseXB = rmse(shipBase);
  console.log(`  shipped + base: ${baseXB.toFixed(5)} (vs neutral-base shipped ${baseX.toFixed(5)})`);
  for (const r of RATIO_WINDOWS) {
    const pred = predFor(r.lo, r.hi, 0.55, 1.6, true);
    const b = rmse(pred);
    const deltas = resamples.map((s) => {
      const list = s.flatMap((gw) => byGw.get(gw)!);
      return rmseOn(list, pred) - rmseOn(list, shipBase);
    }).sort((x, y) => x - y);
    const lo = deltas[Math.floor(0.025 * BOOTSTRAP)]; const hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
    console.log(`  ratio ${r.name.padEnd(11)} + base ${b.toFixed(5)} ${b - baseXB >= 0 ? "+" : ""}${(b - baseXB).toFixed(5)} [${lo >= 0 ? "+" : ""}${lo.toFixed(5)},${hi >= 0 ? "+" : ""}${hi.toFixed(5)}] ${hi < 0 ? "BETTER" : lo > 0 ? "WORSE" : "ns"}`);
  }

  const out = process.env.OUT;
  if (out) {
    const lines = cases.map((c, i) => JSON.stringify({
      season: dataDir.split("/").pop(), gw: c.gw, isHome: c.isHome,
      tableRaw: tableRaw[i], actualCS: c.actualCS, actualGA: c.actualGoalsAgainst,
      rated60: shipRated[i], ownAtt: c.ownAtt, oppDef: c.oppDef, ownDef: c.ownDef, oppAtt: c.oppAtt,
    }));
    writeFileSync(out, lines.join("\n") + "\n");
    console.log(`\nwrote ${lines.length} cases to ${out}`);
  }
}

main();
