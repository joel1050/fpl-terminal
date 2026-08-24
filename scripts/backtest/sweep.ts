/**
 * Two focused follow-ups.
 *
 * 1. The attack-ratio clamp was the only arm to beat baseline on xP. A single
 *    significant result among ten arms is what multiple testing looks like, so
 *    this sweeps the clamp width: a real effect should improve smoothly with
 *    width and hold on a per-gameweek sign test, noise should not.
 * 2. The attacking side of section 7 scored against team goals, which carries
 *    more information than one player's match points.
 */
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE, MEASURED_VENUE, type Variant } from "./variants";

const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 4000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const WIDTHS: { name: string; variant: Variant }[] = [
  { name: "ratio [0.78,1.22] (current)", variant: { ...BASELINE } },
  { name: "ratio [0.70,1.35]", variant: { ...BASELINE, attackRatioClamp: [0.70, 1.35] } },
  { name: "ratio [0.65,1.50]", variant: { ...BASELINE, attackRatioClamp: [0.65, 1.50] } },
  { name: "ratio [0.55,1.75]", variant: { ...BASELINE, attackRatioClamp: [0.55, 1.75] } },
  { name: "ratio [0.40,2.20]", variant: { ...BASELINE, attackRatioClamp: [0.40, 2.20] } },
  { name: "ratio unclamped", variant: { ...BASELINE, attackRatioClamp: [0.01, 100] } },
  { name: "ratio [0.55,1.75] + mult [0.5,1.6]", variant: { ...BASELINE, attackRatioClamp: [0.55, 1.75], multiplierClamp: [0.5, 1.6] } },
  { name: "mult [0.5,1.6] only", variant: { ...BASELINE, multiplierClamp: [0.5, 1.6] } },
  { name: "ratio [0.55,1.75] + venue measured", variant: { ...BASELINE, attackRatioClamp: [0.55, 1.75], venue: MEASURED_VENUE } },
];

interface Row { gameweek: number; actual: number; predictions: number[] }

function collect(season: Season): Row[] {
  const rows: Row[] = [];
  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(season, gameweek);
    const fixtureById = new Map((season.fixturesByGameweek.get(gameweek) ?? []).map((f) => [f.fixtureId, f]));
    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = fixtureById.get(row.fixtureId);
      if (!fixture) continue;
      const player = playerAt(season, row.historicalPlayerId, gameweek, fixture, row.wasHome);
      if (!player) continue;
      const rates = playerRates(player, formBefore(season, row.historicalPlayerId, gameweek), gameweek);
      rows.push({
        gameweek, actual: row.totalPoints,
        predictions: WIDTHS.map((w) => expectedPoints(player, player.fixtures[0], row.minutes, rates, strengths, w.variant).total),
      });
    }
  }
  return rows;
}

function main(): void {
  const season = loadSeason();
  const rows = collect(season);
  const byGameweek = new Map<number, Row[]>();
  for (const r of rows) (byGameweek.get(r.gameweek) ?? byGameweek.set(r.gameweek, []).get(r.gameweek)!).push(r);
  const gameweeks = [...byGameweek.keys()];
  const rmse = (list: readonly Row[], i: number) =>
    Math.sqrt(list.reduce((s, r) => s + (r.predictions[i] - r.actual) ** 2, 0) / list.length);

  let seed = 20260824;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const resamples = Array.from({ length: BOOTSTRAP }, () =>
    Array.from({ length: gameweeks.length }, () => gameweeks[Math.floor(rand() * gameweeks.length)]));

  console.log(`1. ATTACK CLAMP WIDTH SWEEP - xP vs actual points, ${rows.length.toLocaleString()} played rows\n`);
  console.log("clamp                              RMSE     dRMSE   95% CI                 gw wins");
  console.log("-".repeat(88));
  const base = rmse(rows, 0);
  WIDTHS.forEach((w, i) => {
    if (i === 0) { console.log(`${w.name.padEnd(34)} ${base.toFixed(4)}        -                          -`); return; }
    const deltas = resamples.map((sample) => {
      const list = sample.flatMap((gw) => byGameweek.get(gw)!);
      return rmse(list, i) - rmse(list, 0);
    }).sort((a, b) => a - b);
    const lo = deltas[Math.floor(0.025 * BOOTSTRAP)], hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
    const wins = gameweeks.filter((gw) => rmse(byGameweek.get(gw)!, i) < rmse(byGameweek.get(gw)!, 0)).length;
    const verdict = hi < 0 ? "BETTER" : lo > 0 ? "WORSE " : "  ns  ";
    const d = rmse(rows, i) - base;
    console.log(`${w.name.padEnd(34)} ${rmse(rows, i).toFixed(4)} ${d >= 0 ? "+" : ""}${d.toFixed(4)}  [${lo >= 0 ? "+" : ""}${lo.toFixed(4)}, ${hi >= 0 ? "+" : ""}${hi.toFixed(4)}] ${verdict}  ${wins}/${gameweeks.length}`);
  });

  // ---- 2. attacking side scored against team goals ----
  console.log(`\n\n2. ATTACK MODEL vs ACTUAL TEAM GOALS (660 team-fixtures)\n`);
  interface Case { gameweek: number; predictions: number[]; actual: number }
  const models: { name: string; f: (isHome: boolean, ownAttack: number, oppDefence: number) => number }[] = [
    { name: "current: venue 1.03/0.97, clamp [0.78,1.22]", f: (h, a, d) => 1.35 * clamp(a / d, 0.78, 1.22) * (h ? 1.03 : 0.97) },
    { name: "measured venue 1.102/0.898, same clamp", f: (h, a, d) => 1.35 * clamp(a / d, 0.78, 1.22) * (h ? 1.102 : 0.898) },
    { name: "measured venue, clamp [0.55,1.75]", f: (h, a, d) => 1.35 * clamp(a / d, 0.55, 1.75) * (h ? 1.102 : 0.898) },
    { name: "measured venue, unclamped", f: (h, a, d) => 1.35 * (a / d) * (h ? 1.102 : 0.898) },
    { name: "current venue, unclamped", f: (h, a, d) => 1.35 * (a / d) * (h ? 1.03 : 0.97) },
    { name: "constant league average", f: () => 1.35 },
  ];
  const cases: Case[] = [];
  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const s = strengthsBefore(season, gameweek);
    for (const fx of season.fixturesByGameweek.get(gameweek) ?? []) {
      const h = s[fx.homeTeamId], a = s[fx.awayTeamId];
      if (!h || !a) continue;
      cases.push({ gameweek, actual: fx.homeGoals, predictions: models.map((m) => m.f(true, h.attackHome, a.defenceAway)) });
      cases.push({ gameweek, actual: fx.awayGoals, predictions: models.map((m) => m.f(false, a.attackAway, h.defenceHome)) });
    }
  }
  const cByGw = new Map<number, Case[]>();
  for (const c of cases) (cByGw.get(c.gameweek) ?? cByGw.set(c.gameweek, []).get(c.gameweek)!).push(c);
  const gws2 = [...cByGw.keys()];
  // Poisson deviance: the right loss for a predicted rate against a count.
  const dev = (list: readonly Case[], i: number) => list.reduce((s, c) => {
    const m = Math.max(c.predictions[i], 1e-6);
    return s + 2 * ((c.actual > 0 ? c.actual * Math.log(c.actual / m) : 0) - (c.actual - m));
  }, 0) / list.length;
  const resamples2 = Array.from({ length: BOOTSTRAP }, () =>
    Array.from({ length: gws2.length }, () => gws2[Math.floor(rand() * gws2.length)]));
  console.log("model                                         deviance   ddev    95% CI                 corr");
  console.log("-".repeat(96));
  const base2 = dev(cases, 0);
  models.forEach((m, i) => {
    const d = dev(cases, i);
    const xs = cases.map((c) => c.predictions[i]), ys = cases.map((c) => c.actual);
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
    let num = 0, dx = 0, dy = 0;
    for (let k = 0; k < xs.length; k += 1) { num += (xs[k] - mx) * (ys[k] - my); dx += (xs[k] - mx) ** 2; dy += (ys[k] - my) ** 2; }
    const corr = dx > 0 ? num / Math.sqrt(dx * dy) : 0;
    if (i === 0) { console.log(`${m.name.padEnd(45)} ${d.toFixed(4)}       -                          ${corr.toFixed(3)}`); return; }
    const deltas = resamples2.map((sample) => {
      const list = sample.flatMap((gw) => cByGw.get(gw)!);
      return dev(list, i) - dev(list, 0);
    }).sort((x, y) => x - y);
    const lo = deltas[Math.floor(0.025 * BOOTSTRAP)], hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
    const verdict = hi < 0 ? "BETTER" : lo > 0 ? "WORSE " : "  ns  ";
    console.log(`${m.name.padEnd(45)} ${d.toFixed(4)} ${d - base2 >= 0 ? "+" : ""}${(d - base2).toFixed(4)}  [${lo >= 0 ? "+" : ""}${lo.toFixed(4)}, ${hi >= 0 ? "+" : ""}${hi.toFixed(4)}] ${verdict}  ${corr.toFixed(3)}`);
  });
}

main();
