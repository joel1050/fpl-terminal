/**
 * Direct walk-forward test of the clean-sheet model, 2025/26.
 *
 * Scoring section 7 through section 8 xP has almost no statistical power: a
 * clean sheet is ~1.1 of a defender's ~3.5 expected points and match points are
 * dominated by variance. This scores the clean-sheet probability against the
 * event it predicts, where the power actually is. 760 team-fixtures, strengths
 * built only from earlier gameweeks.
 */
import { loadSeason, strengthsBefore } from "./season";

const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 4000;

const TIERS = [0.84, 0.92, 1, 1.08, 1.16] as const;
const TABLE = {
  home: [
    [0.26, 0.24, 0.20, 0.15, 0.11], [0.36, 0.31, 0.27, 0.24, 0.17],
    [0.39, 0.33, 0.28, 0.24, 0.17], [0.42, 0.36, 0.31, 0.27, 0.19],
    [0.50, 0.42, 0.39, 0.33, 0.27],
  ],
  away: [
    [0.23, 0.16, 0.15, 0.12, 0.06], [0.31, 0.25, 0.20, 0.17, 0.11],
    [0.33, 0.27, 0.22, 0.18, 0.13], [0.36, 0.30, 0.25, 0.21, 0.15],
    [0.42, 0.35, 0.34, 0.30, 0.18],
  ],
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function nearestTier(value: number): number {
  let best = 0, bestDistance = Infinity;
  TIERS.forEach((tier, index) => {
    const d = Math.abs(value - tier);
    if (d < bestDistance) { best = index; bestDistance = d; }
  });
  return best;
}

/** Fractional tier position, so a strength between anchors lands between rows. */
function tierPosition(value: number): number {
  if (value <= TIERS[0]) return 0;
  if (value >= TIERS[4]) return 4;
  const step = 0.08;
  return (value - TIERS[0]) / step;
}

/** The same market table, read continuously instead of snapped to a cell. */
function bilinear(isHome: boolean, ownDefence: number, opponentAttack: number): number {
  const grid = TABLE[isHome ? "home" : "away"];
  const r = tierPosition(ownDefence), c = tierPosition(opponentAttack);
  const r0 = Math.floor(r), c0 = Math.floor(c);
  const r1 = Math.min(4, r0 + 1), c1 = Math.min(4, c0 + 1);
  const fr = r - r0, fc = c - c0;
  return grid[r0][c0] * (1 - fr) * (1 - fc) + grid[r1][c0] * fr * (1 - fc)
       + grid[r0][c1] * (1 - fr) * fc + grid[r1][c1] * fr * fc;
}

interface Model { name: string; predict: (isHome: boolean, ownDefence: number, opponentAttack: number) => number }

const poisson = (scale: number, gamma: number, homeFactor: number, awayFactor: number): Model["predict"] =>
  (isHome, ownDefence, opponentAttack) => {
    const lambda = scale * Math.pow(opponentAttack / ownDefence, gamma) * (isHome ? awayFactor : homeFactor);
    return clamp(Math.exp(-lambda), 0.02, 0.9);
  };

const MODELS: Model[] = [
  { name: "current: 5x5 tier table", predict: (h, d, a) => TABLE[h ? "home" : "away"][nearestTier(d)][nearestTier(a)] },
  { name: "same table, bilinear", predict: bilinear },
  { name: "Poisson s1.35 g1.0", predict: poisson(1.35, 1.0, 1.102, 0.898) },
  { name: "Poisson s1.35 g0.8", predict: poisson(1.35, 0.8, 1.102, 0.898) },
  { name: "Poisson s1.35 g1.2", predict: poisson(1.35, 1.2, 1.102, 0.898) },
  { name: "Poisson s1.30 g1.0", predict: poisson(1.30, 1.0, 1.102, 0.898) },
  { name: "Poisson s1.41 g1.0", predict: poisson(1.408, 1.0, 1.102, 0.898) },
  { name: "Poisson s1.35 g1.0 flat venue", predict: poisson(1.35, 1.0, 1.0, 1.0) },
  { name: "constant league rate", predict: () => 0.27 },
];

interface Case { gameweek: number; predictions: number[]; actual: number; ownDefence: number }

function main(): void {
  const season = loadSeason();
  const cases: Case[] = [];
  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(season, gameweek);
    for (const fixture of season.fixturesByGameweek.get(gameweek) ?? []) {
      const home = strengths[fixture.homeTeamId], away = strengths[fixture.awayTeamId];
      if (!home || !away) continue;
      cases.push({
        gameweek, ownDefence: home.defenceHome,
        predictions: MODELS.map((m) => m.predict(true, home.defenceHome, away.attackAway)),
        actual: fixture.awayGoals === 0 ? 1 : 0,
      });
      cases.push({
        gameweek, ownDefence: away.defenceAway,
        predictions: MODELS.map((m) => m.predict(false, away.defenceAway, home.attackHome)),
        actual: fixture.homeGoals === 0 ? 1 : 0,
      });
    }
  }

  const byGameweek = new Map<number, Case[]>();
  for (const c of cases) (byGameweek.get(c.gameweek) ?? byGameweek.set(c.gameweek, []).get(c.gameweek)!).push(c);
  const gameweeks = [...byGameweek.keys()];

  const brierOf = (list: readonly Case[], index: number) =>
    list.reduce((s, c) => s + (c.predictions[index] - c.actual) ** 2, 0) / list.length;
  const loglossOf = (list: readonly Case[], index: number) =>
    -list.reduce((s, c) => s + (c.actual
      ? Math.log(Math.max(c.predictions[index], 1e-6))
      : Math.log(Math.max(1 - c.predictions[index], 1e-6))), 0) / list.length;

  let seed = 20260824;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const resamples = Array.from({ length: BOOTSTRAP }, () =>
    Array.from({ length: gameweeks.length }, () => gameweeks[Math.floor(rand() * gameweeks.length)]));

  const baseBrier = brierOf(cases, 0);
  const actualRate = cases.reduce((s, c) => s + c.actual, 0) / cases.length;

  console.log(`walk-forward clean sheets, gameweeks ${FIRST_GAMEWEEK}-38`);
  console.log(`team-fixtures: ${cases.length}   actual clean-sheet rate: ${actualRate.toFixed(3)}\n`);
  console.log("model                            Brier    dBrier   95% CI (gw clusters)      logloss  meanPred  spread");
  console.log("-".repeat(106));

  MODELS.forEach((model, index) => {
    const brier = brierOf(cases, index);
    const logloss = loglossOf(cases, index);
    const preds = cases.map((c) => c.predictions[index]);
    const meanPred = preds.reduce((s, p) => s + p, 0) / preds.length;
    const spread = `${Math.min(...preds).toFixed(2)}-${Math.max(...preds).toFixed(2)}`;
    if (index === 0) {
      console.log(`${model.name.padEnd(31)} ${brier.toFixed(4)}        -                             ${logloss.toFixed(4)}   ${meanPred.toFixed(3)}    ${spread}`);
      return;
    }
    const deltas = resamples.map((sample) => {
      const list = sample.flatMap((gw) => byGameweek.get(gw)!);
      return brierOf(list, index) - brierOf(list, 0);
    }).sort((a, b) => a - b);
    const lo = deltas[Math.floor(0.025 * BOOTSTRAP)], hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
    const verdict = hi < 0 ? "BETTER" : lo > 0 ? "WORSE " : "  ns  ";
    const delta = brier - baseBrier;
    console.log(`${model.name.padEnd(31)} ${brier.toFixed(4)}  ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}  [${lo >= 0 ? "+" : ""}${lo.toFixed(4)}, ${hi >= 0 ? "+" : ""}${hi.toFixed(4)}] ${verdict}  ${logloss.toFixed(4)}   ${meanPred.toFixed(3)}    ${spread}`);
  });

  // Where the tier snap is supposed to hurt: the strongest and weakest defences.
  console.log("\ncalibration by predicted-strength band (current table vs bilinear vs best Poisson):");
  const sorted = [...cases].sort((a, b) => a.ownDefence - b.ownDefence);
  const bands = 5, size = Math.floor(sorted.length / bands);
  console.log("band (own defence)     n    actual   table   bilinear  Poisson");
  for (let b = 0; b < bands; b += 1) {
    const slice = sorted.slice(b * size, b === bands - 1 ? sorted.length : (b + 1) * size);
    const mean = (index: number) => slice.reduce((s, c) => s + c.predictions[index], 0) / slice.length;
    const act = slice.reduce((s, c) => s + c.actual, 0) / slice.length;
    const lo = slice[0].ownDefence.toFixed(2), hi = slice[slice.length - 1].ownDefence.toFixed(2);
    console.log(`${(lo + "-" + hi).padEnd(20)} ${String(slice.length).padStart(4)}   ${act.toFixed(3)}   ${mean(0).toFixed(3)}    ${mean(1).toFixed(3)}    ${mean(2).toFixed(3)}`);
  }
}

main();
