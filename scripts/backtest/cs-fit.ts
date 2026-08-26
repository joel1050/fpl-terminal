/**
 * Fits a correction to the clean-sheet table and checks it OUT OF SAMPLE.
 *
 * Fitting and scoring on the same 660 fixtures would guarantee an improvement
 * and mean nothing. This uses 5-fold cross-validation over blocks of gameweeks:
 * the correction is fitted on four folds and scored on the fifth it never saw.
 */
import { loadSeason, strengthsBefore } from "./season";

const FIRST = 6, FOLDS = 5;
const TIERS = [0.84, 0.92, 1, 1.08, 1.16];
const tierOf = (v: number) => TIERS.reduce((b, t, i) => (Math.abs(v - t) < Math.abs(v - TIERS[b]) ? i : b), 0);
const TABLE = {
  home: [[.26,.24,.20,.15,.11],[.36,.31,.27,.24,.17],[.39,.33,.28,.24,.17],[.42,.36,.31,.27,.19],[.50,.42,.39,.33,.27]],
  away: [[.23,.16,.15,.12,.06],[.31,.25,.20,.17,.11],[.33,.27,.22,.18,.13],[.36,.30,.25,.21,.15],[.42,.35,.34,.30,.18]],
} as const;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Case { gw: number; defTier: number; base: number; actual: number }

type Correction = (c: Case, params: number[]) => number;

interface Family { name: string; nParams: number; grid: number[][]; apply: Correction }

const scaleRow = (rows: number[]): Family => ({
  name: `scale tier ${rows.map((r) => r + 1).join("+")} rows`,
  nParams: 1,
  grid: Array.from({ length: 41 }, (_, i) => [0.5 + i * 0.025]),
  apply: (c, p) => (rows.includes(c.defTier) ? clamp(c.base * p[0], 0.02, 0.9) : c.base),
});

const FAMILIES: Family[] = [
  { name: "no correction (current)", nParams: 0, grid: [[]], apply: (c) => c.base },
  scaleRow([0]),
  scaleRow([0, 1]),
  {
    name: "global logit recalibration",
    nParams: 2,
    grid: (() => { const g: number[][] = []; for (let a = 0.6; a <= 1.6; a += 0.05) for (let b = -0.6; b <= 0.6; b += 0.05) g.push([a, b]); return g; })(),
    apply: (c, p) => {
      const l = Math.log(c.base / (1 - c.base)) * p[0] + p[1];
      return clamp(1 / (1 + Math.exp(-l)), 0.02, 0.9);
    },
  },
];

const brier = (list: readonly Case[], f: Family, p: number[]) =>
  list.reduce((s, c) => s + (f.apply(c, p) - c.actual) ** 2, 0) / list.length;

function main(): void {
  const season = loadSeason();
  const cases: Case[] = [];
  for (let gw = FIRST; gw <= 38; gw += 1) {
    const s = strengthsBefore(season, gw);
    for (const fx of season.fixturesByGameweek.get(gw) ?? []) {
      const h = s[fx.homeTeamId], a = s[fx.awayTeamId];
      if (!h || !a) continue;
      cases.push({ gw, defTier: tierOf(h.defenceHome), actual: fx.awayGoals === 0 ? 1 : 0,
        base: TABLE.home[tierOf(h.defenceHome)][tierOf(a.attackAway)] });
      cases.push({ gw, defTier: tierOf(a.defenceAway), actual: fx.homeGoals === 0 ? 1 : 0,
        base: TABLE.away[tierOf(a.defenceAway)][tierOf(h.attackHome)] });
    }
  }
  const gws = [...new Set(cases.map((c) => c.gw))].sort((a, b) => a - b);
  const foldOf = new Map(gws.map((g, i) => [g, i % FOLDS]));

  console.log(`clean-sheet table correction, ${cases.length} team-fixtures, ${FOLDS}-fold CV over gameweeks`);
  console.log(`tier-1 defence appears in ${cases.filter((c) => c.defTier === 0).length} of them\n`);
  console.log("family                          in-sample   out-of-sample   fitted on full data");
  console.log("-".repeat(84));

  const baseOut: number[] = [];
  for (const f of FAMILIES) {
    // in-sample: best params on everything
    let bestP = f.grid[0], bestB = Infinity;
    for (const p of f.grid) { const b = brier(cases, f, p); if (b < bestB) { bestB = b; bestP = p; } }

    // out-of-sample: fit on the other folds, score on the held-out one
    let sse = 0, n = 0;
    const perFold: number[] = [];
    for (let k = 0; k < FOLDS; k += 1) {
      const train = cases.filter((c) => foldOf.get(c.gw) !== k);
      const test = cases.filter((c) => foldOf.get(c.gw) === k);
      let p = f.grid[0], b = Infinity;
      for (const cand of f.grid) { const v = brier(train, f, cand); if (v < b) { b = v; p = cand; } }
      const t = brier(test, f, p);
      perFold.push(t); sse += t * test.length; n += test.length;
    }
    const out = sse / n;
    if (f.name.startsWith("no correction")) baseOut.push(...perFold);
    const wins = f.name.startsWith("no correction") ? "" :
      `   folds improved: ${perFold.filter((v, i) => v < baseOut[i]).length}/${FOLDS}`;
    const params = bestP.length ? bestP.map((x) => x.toFixed(2)).join(", ") : "-";
    console.log(`${f.name.padEnd(30)} ${bestB.toFixed(5)}      ${out.toFixed(5)}    ${params}${wins}`);
  }
  console.log("\nA correction that helps in-sample but not out-of-sample is fitting noise.");
}
main();
