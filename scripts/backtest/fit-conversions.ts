/**
 * Fits the xG->goals and xA->assists conversion factors, per position.
 *
 * Expected points are linear in both factors (total = base + gG + aA), so the
 * least-squares optimum is a closed form rather than a grid search. Factors are
 * fitted on three quarters of the gameweeks and scored on the fourth, four
 * times over, because a factor fitted and judged on the same rows will always
 * look good.
 *
 * The priors are corrected first. PRIOR_XG/PRIOR_XA sit well above the pool
 * xG/xA they are blended into (1.6x for midfielders), and blendPlayerRate gives
 * the prior 71% of the weight permanently, so fitting a conversion on top of
 * the old priors would only be fitting around that error.
 */
import type { HistoricalStats, Player, Position } from "@/types/player";
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { expectedPoints, playerRates, type RateOverrides } from "./xp";
import { BASELINE } from "./variants";

const FIRST = 20;
const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

/** Measured per-90 pool rates for 2025/26, in xG/xA units. */
const POOL_XG: Record<Position, number> = { GK: 0.001, DEF: 0.057, MID: 0.153, FWD: 0.410 };
const POOL_XA: Record<Position, number> = { GK: 0.002, DEF: 0.058, MID: 0.126, FWD: 0.060 };
/** Naive conversions: season totals of goals/xG and assists/xA. */
const NAIVE_GOAL: Record<Position, number> = { GK: 1, DEF: 0.757, MID: 0.981, FWD: 0.981 };
const NAIVE_ASSIST: Record<Position, number> = { GK: 1, DEF: 1.292, MID: 1.325, FWD: 2.105 };

const ONE_CONVERSION: Record<Position, number> = { GK: 1, DEF: 1, MID: 1, FWD: 1 };
const CURRENT_PRIORS: RateOverrides = {};
const CORRECTED_PRIORS: RateOverrides = { priorXg: POOL_XG, priorXa: POOL_XA };

function anchor(season: Season, id: number): HistoricalStats | undefined {
  const rows = (season.rowsByPlayer.get(id) ?? []).filter((r) => r.gameweek < FIRST);
  const minutes = rows.reduce((s, r) => s + r.minutes, 0);
  if (minutes <= 0) return undefined;
  const st = season.players.get(id)!.stats;
  const scale = st.minutes > 0 ? minutes / st.minutes : 0;
  return {
    season: "h1", minutes,
    expectedGoals: rows.reduce((s, r) => s + (r.expectedGoals ?? 0), 0),
    expectedAssists: rows.reduce((s, r) => s + (r.expectedAssists ?? 0), 0),
    bonus: rows.reduce((s, r) => s + (r.bonus ?? 0), 0),
    saves: (st.saves ?? 0) * scale, defensiveContribution: (st.defensiveContribution ?? 0) * scale,
    yellowCards: rows.reduce((s, r) => s + (r.yellowCards ?? 0), 0),
    redCards: rows.reduce((s, r) => s + (r.redCards ?? 0), 0),
  };
}

interface Row { gameweek: number; position: Position; actual: number; base: number; unitG: number; unitA: number;
  /** Expected goals and assists for this spell, in counts - the identifiable quantity. */
  xgSpell: number; xaSpell: number; goals: number; assists: number;
  /** What the player actually recorded that match, to separate rate error from conversion. */
  actualXg: number; actualXa: number }

/** One row per appearance, with the goal and assist terms separated out. */
function collect(season: Season, overrides: RateOverrides): Row[] {
  const rows: Row[] = [];
  for (let gw = FIRST; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const byId = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    for (const r of season.rowsByGameweek.get(gw) ?? []) {
      if (r.minutes <= 0) continue;
      const fx = byId.get(r.fixtureId);
      if (!fx) continue;
      const base = playerAt(season, r.historicalPlayerId, gw, fx, r.wasHome);
      const a = anchor(season, r.historicalPlayerId);
      if (!base || !a) continue;
      const p: Player = { ...base, historical: a };
      const rates = playerRates(p, formBefore(season, r.historicalPlayerId, gw), gw, overrides);
      // Conversions off: this script exists to derive them, so it must see the
      // raw xG/xA terms rather than the ones the shipped model already scales.
      const c = expectedPoints(p, p.fixtures[0], r.minutes, rates, strengths, BASELINE, true, true, ONE_CONVERSION, ONE_CONVERSION);
      const goalPoints = { GK: 10, DEF: 6, MID: 5, FWD: 4 }[p.position];
      rows.push({
        gameweek: gw, position: p.position, actual: r.totalPoints,
        base: c.total - c.goals - c.assists, unitG: c.goals, unitA: c.assists,
        xgSpell: c.goals / goalPoints, xaSpell: c.assists / 3,
        goals: r.goals ?? 0, assists: r.assists ?? 0,
        actualXg: r.expectedGoals ?? 0, actualXa: r.expectedAssists ?? 0,
      });
    }
  }
  return rows;
}

/** Least-squares (goalScale, assistScale) for one position's rows. */
function solve(rows: readonly Row[]): { goal: number; assist: number } {
  let gg = 0, ga = 0, aa = 0, gr = 0, ar = 0;
  for (const row of rows) {
    const r = row.actual - row.base;
    gg += row.unitG * row.unitG; ga += row.unitG * row.unitA; aa += row.unitA * row.unitA;
    gr += row.unitG * r; ar += row.unitA * r;
  }
  const det = gg * aa - ga * ga;
  if (Math.abs(det) < 1e-12) return { goal: 1, assist: 1 };
  return { goal: (gr * aa - ar * ga) / det, assist: (gg * ar - ga * gr) / det };
}

const score = (rows: readonly Row[], g: number, a: number) => {
  const err = rows.map((r) => r.base + g * r.unitG + a * r.unitA - r.actual);
  return { rmse: Math.sqrt(mean(err.map((e) => e * e))), bias: mean(err) };
};

function main(): void {
  const season = loadSeason();
  const current = collect(season, CURRENT_PRIORS);
  const corrected = collect(season, CORRECTED_PRIORS);
  const gws = [...new Set(current.map((r) => r.gameweek))].sort((a, b) => a - b);
  const folds = [0, 1, 2, 3].map((k) => new Set(gws.filter((_, i) => i % 4 === k)));

  console.log(`gameweeks ${FIRST}-38, anchored on each player's own gameweeks 1-19`);
  console.log(`${current.length} appearances, 4-fold cross-validation by gameweek\n`);

  // Fit the conversion where it is identifiable: actual counts against the
  // expected counts the model produced. Fitting a scalar on the points term
  // instead lets it soak up every other error correlated with that component.
  const ratio = (rows: readonly Row[], x: (r: Row) => number, y: (r: Row) => number) => {
    let xy = 0, xx = 0;
    for (const r of rows) { xy += x(r) * y(r); xx += x(r) * x(r); }
    return xx > 0 ? xy / xx : NaN;
  };
  console.log("FITTED CONVERSIONS, out of fold, actual counts against modelled expected counts");
  console.log("pos    goal  xG -> goals        assist  xA -> assists      season ratio (g/xG, a/xA)   modelled total");
  const fitted: Record<string, { goal: number; assist: number }> = {};
  for (const pos of POSITIONS) {
    const list = corrected.filter((r) => r.position === pos);
    const g = folds.map((f) => ratio(list.filter((r) => !f.has(r.gameweek)), (r) => r.xgSpell, (r) => r.goals));
    const a = folds.map((f) => ratio(list.filter((r) => !f.has(r.gameweek)), (r) => r.xaSpell, (r) => r.assists));
    fitted[pos] = { goal: mean(g), assist: mean(a) };
    const totalXg = list.reduce((s, r) => s + r.xgSpell, 0), totalXa = list.reduce((s, r) => s + r.xaSpell, 0);
    console.log(`${pos.padEnd(6)} ${mean(g).toFixed(3)}  [${Math.min(...g).toFixed(2)}, ${Math.max(...g).toFixed(2)}]`
      + `      ${mean(a).toFixed(3)}  [${Math.min(...a).toFixed(2)}, ${Math.max(...a).toFixed(2)}]`
      + `        ${NAIVE_GOAL[pos].toFixed(3)} / ${NAIVE_ASSIST[pos].toFixed(3)}`
      + `        xG ${totalXg.toFixed(1)}, xA ${totalXa.toFixed(1)}`);
  }
  const FITTED_GOAL = Object.fromEntries(POSITIONS.map((p) => [p, fitted[p].goal])) as Record<Position, number>;
  const FITTED_ASSIST = Object.fromEntries(POSITIONS.map((p) => [p, fitted[p].assist])) as Record<Position, number>;

  // The bias-neutral alternative: correct the modelled rate to the expected
  // count actually recorded, then apply the true conversion. Unlike the fitted
  // slope this does not shrink, so it keeps the top of the range intact.
  const implied = (pos: Position, kind: "goal" | "assist", train: readonly Row[]) => {
    const m = train.reduce((s, r) => s + (kind === "goal" ? r.xgSpell : r.xaSpell), 0);
    const act = train.reduce((s, r) => s + (kind === "goal" ? r.actualXg : r.actualXa), 0);
    const real = train.reduce((s, r) => s + (kind === "goal" ? r.goals : r.assists), 0);
    return m > 5 && act > 0 ? (act / m) * (real / act) : 1;
  };
  const IMPLIED_GOAL = Object.fromEntries(POSITIONS.map((p) =>
    [p, mean(folds.map((f) => implied(p, "goal", corrected.filter((r) => r.position === p && !f.has(r.gameweek)))))])) as Record<Position, number>;
  const IMPLIED_ASSIST = Object.fromEntries(POSITIONS.map((p) =>
    [p, mean(folds.map((f) => implied(p, "assist", corrected.filter((r) => r.position === p && !f.has(r.gameweek)))))])) as Record<Position, number>;
  console.log("\nBIAS-NEUTRAL SCALARS (rate correction x true conversion), out of fold");
  console.log("pos       goal     assist");
  for (const p of POSITIONS) console.log(`${p.padEnd(8)} ${IMPLIED_GOAL[p].toFixed(3)}    ${IMPLIED_ASSIST[p].toFixed(3)}`);

  // The conversion alone, with the rate error left where it belongs. This is
  // what a scoring rule should encode: how a chance turns into a return.
  const trueConv = (pos: Position, kind: "goal" | "assist", train: readonly Row[]) => {
    const act = train.reduce((s, r) => s + (kind === "goal" ? r.actualXg : r.actualXa), 0);
    const real = train.reduce((s, r) => s + (kind === "goal" ? r.goals : r.assists), 0);
    return act > 5 ? real / act : 1;
  };
  const TRUE_GOAL = Object.fromEntries(POSITIONS.map((p) =>
    [p, mean(folds.map((f) => trueConv(p, "goal", corrected.filter((r) => r.position === p && !f.has(r.gameweek)))))])) as Record<Position, number>;
  const TRUE_ASSIST = Object.fromEntries(POSITIONS.map((p) =>
    [p, mean(folds.map((f) => trueConv(p, "assist", corrected.filter((r) => r.position === p && !f.has(r.gameweek)))))])) as Record<Position, number>;
  console.log("\nTRUE CONVERSIONS ONLY (chance -> return, no rate correction)");
  console.log("pos       goal     assist");
  for (const p of POSITIONS) console.log(`${p.padEnd(8)} ${TRUE_GOAL[p].toFixed(3)}    ${TRUE_ASSIST[p].toFixed(3)}`);

  console.log("\nSHRINKING THE ANCHOR, then applying true conversions only");
  console.log("shrink (min)   RMSE      bias     MID bias    modelled/actual xG (MID)");
  for (const w of [0, 300, 600, 900, 1350, 1800, 2700]) {
    const rows2 = collect(season, { anchorShrinkMinutes: w, priorXg: POOL_XG, priorXa: POOL_XA });
    const err = rows2.map((r) => r.base + TRUE_GOAL[r.position] * r.unitG + TRUE_ASSIST[r.position] * r.unitA - r.actual);
    const mid = rows2.map((r, i) => [r, err[i]] as const).filter(([r]) => r.position === "MID");
    const m = rows2.filter((r) => r.position === "MID");
    const ratio = m.reduce((s, r) => s + r.actualXg, 0) / m.reduce((s, r) => s + r.xgSpell, 0);
    console.log(`${String(w).padStart(9)}      ${Math.sqrt(mean(err.map((e) => e * e))).toFixed(4)}  ${mean(err) >= 0 ? "+" : ""}${mean(err).toFixed(3)}    ${mean(mid.map(([, e]) => e)) >= 0 ? "+" : ""}${mean(mid.map(([, e]) => e)).toFixed(3)}       ${ratio.toFixed(3)}`);
  }

  console.log("\nOUT-OF-FOLD ACCURACY (fitted on 3 folds, scored on the 4th)");
  console.log("arm                                  RMSE      bias     MID RMSE   MID bias");
  const arms: { name: string; rows: Row[]; g: Record<Position, number> | "fit"; a: Record<Position, number> | "fit" }[] = [
    { name: "no conversions (previous)", rows: current, g: { GK: 1, DEF: 1, MID: 1, FWD: 1 }, a: { GK: 1, DEF: 1, MID: 1, FWD: 1 } },
    { name: "naive season conversions", rows: corrected, g: NAIVE_GOAL, a: NAIVE_ASSIST },
    
    { name: "bias-neutral scalars (SHIPPED)", rows: corrected, g: IMPLIED_GOAL, a: IMPLIED_ASSIST },
    { name: "true conversions only", rows: corrected, g: TRUE_GOAL, a: TRUE_ASSIST },
    { name: "RMSE-fitted slopes (shrinks)", rows: corrected, g: FITTED_GOAL, a: FITTED_ASSIST },
    { name: "least-squares on points (overfits)", rows: corrected, g: "fit", a: "fit" },
  ];
  for (const arm of arms) {
    const errs: number[] = [], mids: number[] = [];
    for (const f of folds) {
      const train = arm.rows.filter((r) => !f.has(r.gameweek));
      const test = arm.rows.filter((r) => f.has(r.gameweek));
      for (const row of test) {
        const pos = row.position;
        const fit = arm.g === "fit" ? solve(train.filter((r) => r.position === pos)) : null;
        const g = fit ? fit.goal : (arm.g as Record<Position, number>)[pos];
        const a = fit ? fit.assist : (arm.a as Record<Position, number>)[pos];
        const e = row.base + g * row.unitG + a * row.unitA - row.actual;
        errs.push(e);
        if (pos === "MID") mids.push(e);
      }
    }
    const rmse = Math.sqrt(mean(errs.map((e) => e * e)));
    const midRmse = Math.sqrt(mean(mids.map((e) => e * e)));
    console.log(`${arm.name.padEnd(37)} ${rmse.toFixed(4)}  ${mean(errs) >= 0 ? "+" : ""}${mean(errs).toFixed(3)}    ${midRmse.toFixed(4)}   ${mean(mids) >= 0 ? "+" : ""}${mean(mids).toFixed(3)}`);
  }

  // A fitted scalar is two things multiplied: the true conversion, and a
  // correction for the model over- or under-stating the expected count itself.
  console.log("\nWHAT THE FITTED SCALAR IS ACTUALLY DOING");
  console.log("pos    modelled xG   actual xG   ratio    true g/xG   =>  implied scalar   fitted");
  for (const pos of POSITIONS) {
    const l = corrected.filter((r) => r.position === pos);
    const mXg = l.reduce((s, r) => s + r.xgSpell, 0), aXg = l.reduce((s, r) => s + r.actualXg, 0);
    const g = l.reduce((s, r) => s + r.goals, 0);
    if (mXg < 5) { console.log(`${pos.padEnd(6)} (too little xG to identify)`); continue; }
    console.log(`${pos.padEnd(6)} ${mXg.toFixed(1).padStart(9)} ${aXg.toFixed(1).padStart(11)}   ${(aXg / mXg).toFixed(3)}     ${(g / aXg).toFixed(3)}      ${((aXg / mXg) * (g / aXg)).toFixed(3)}        ${fitted[pos].goal.toFixed(3)}`);
  }
  console.log("pos    modelled xA   actual xA   ratio    true a/xA   =>  implied scalar   fitted");
  for (const pos of POSITIONS) {
    const l = corrected.filter((r) => r.position === pos);
    const mXa = l.reduce((s, r) => s + r.xaSpell, 0), aXa = l.reduce((s, r) => s + r.actualXa, 0);
    const a = l.reduce((s, r) => s + r.assists, 0);
    if (mXa < 5) { console.log(`${pos.padEnd(6)} (too little xA to identify)`); continue; }
    console.log(`${pos.padEnd(6)} ${mXa.toFixed(1).padStart(9)} ${aXa.toFixed(1).padStart(11)}   ${(aXa / mXa).toFixed(3)}     ${(a / aXa).toFixed(3)}      ${((aXa / mXa) * (a / aXa)).toFixed(3)}        ${fitted[pos].assist.toFixed(3)}`);
  }

  // Is the RMSE gain real? Paired bootstrap over gameweek clusters.
  console.log("\nIS THE GAIN REAL? paired bootstrap over gameweek clusters");
  const byGw = new Map<number, Row[]>();
  for (const r of corrected) (byGw.get(r.gameweek) ?? byGw.set(r.gameweek, []).get(r.gameweek)!).push(r);
  const cByGw = new Map<number, Row[]>();
  for (const r of current) (cByGw.get(r.gameweek) ?? cByGw.set(r.gameweek, []).get(r.gameweek)!).push(r);
  let seed = 20260824;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const rmseOf = (l: readonly Row[], g: Record<Position, number>, a: Record<Position, number>) =>
    Math.sqrt(mean(l.map((r) => (r.base + g[r.position] * r.unitG + a[r.position] * r.unitA - r.actual) ** 2)));
  const ONE = { GK: 1, DEF: 1, MID: 1, FWD: 1 } as Record<Position, number>;
  for (const [label, g, a] of [["bias-neutral", IMPLIED_GOAL, IMPLIED_ASSIST], ["RMSE-fitted", FITTED_GOAL, FITTED_ASSIST]] as const) {
    const d = Array.from({ length: 4000 }, () => {
      const picks = Array.from({ length: gws.length }, () => gws[Math.floor(rand() * gws.length)]);
      return rmseOf(picks.flatMap((x) => byGw.get(x)!), g, a) - rmseOf(picks.flatMap((x) => cByGw.get(x)!), ONE, ONE);
    }).sort((x, y) => x - y);
    const pt = rmseOf(corrected, g, a) - rmseOf(current, ONE, ONE);
    console.log(`  ${label.padEnd(14)} RMSE vs current: ${pt.toFixed(4)}  [${d[100].toFixed(4)}, ${d[3899].toFixed(4)}]  ${d[3899] < 0 ? "BETTER" : d[100] > 0 ? "WORSE" : "cannot resolve"}`);
  }
  const deltas = Array.from({ length: 4000 }, () => {
    const picks = Array.from({ length: gws.length }, () => gws[Math.floor(rand() * gws.length)]);
    return rmseOf(picks.flatMap((g) => byGw.get(g)!), FITTED_GOAL, FITTED_ASSIST)
      - rmseOf(picks.flatMap((g) => cByGw.get(g)!), ONE, ONE);
  }).sort((x, y) => x - y);
  const point = rmseOf(corrected, FITTED_GOAL, FITTED_ASSIST) - rmseOf(current, ONE, ONE);
  console.log(`  (legacy check) fitted minus current RMSE: ${point.toFixed(4)}  [${deltas[100].toFixed(4)}, ${deltas[3899].toFixed(4)}]  ${deltas[3899] < 0 ? "BETTER" : deltas[100] > 0 ? "WORSE" : "cannot resolve"}`);

  console.log("\nPER-POSITION, component-fitted conversions (out of fold)");
  console.log("pos     RMSE current -> fitted      bias current -> fitted");
  for (const pos of POSITIONS) {
    const cur = score(current.filter((r) => r.position === pos), 1, 1);
    const errs: number[] = [];
    for (const f of folds) {
      const train = corrected.filter((r) => r.position === pos && !f.has(r.gameweek));
      const g = ratio(train, (r) => r.xgSpell, (r) => r.goals);
      const a = ratio(train, (r) => r.xaSpell, (r) => r.assists);
      for (const row of corrected.filter((r) => r.position === pos && f.has(r.gameweek))) {
        errs.push(row.base + g * row.unitG + a * row.unitA - row.actual);
      }
    }
    console.log(`${pos.padEnd(6)}  ${cur.rmse.toFixed(4)} -> ${Math.sqrt(mean(errs.map((e) => e * e))).toFixed(4)}`
      + `           ${cur.bias >= 0 ? "+" : ""}${cur.bias.toFixed(3)} -> ${mean(errs) >= 0 ? "+" : ""}${mean(errs).toFixed(3)}`);
  }
}
main();
