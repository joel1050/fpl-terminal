/**
 * Walk-forward backtest of section 7 variants, scored on section 8 xP against
 * actual FPL points, 2025/26.
 *
 * Minutes are the actual minutes played. That is deliberate: the minutes model
 * (sections 4-5) contributes far more error than anything in section 7, and
 * leaving it in would bury the signal being measured. It also makes the >=60
 * clean-sheet gate exact. Absolute errors are therefore better than a live
 * model would achieve; only the differences between arms are the result.
 *
 * Significance is a paired bootstrap over GAMEWEEK clusters, not rows: rows in
 * one fixture share a lambda and a team, so resampling rows would understate
 * the standard error.
 */
import { loadSeason, strengthsBefore, formBefore, playerAt, KNOWN_LEAKS, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE, LEGACY, MEASURED_VENUE, type Variant } from "./variants";

const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 10000;
const TOP_N = 30;

interface Row {
  gameweek: number;
  playerId: number;
  position: string;
  minutes: number;
  actual: number;
  predictions: number[];
}

const v = (over: Partial<Variant>): Variant => ({ ...BASELINE, ...over });

const ARMS: { name: string; variant: Variant; note: string; bonusFixture?: boolean }[] = [
  { name: "shipped §7", variant: BASELINE, note: "" },
  { name: "bonus follows fixture", variant: BASELINE, note: "", bonusFixture: true },
  { name: "outer clamp [0.55,1.60]", variant: v({ multiplierClamp: [0.55, 1.60] }), note: "" },
  { name: "both", variant: v({ multiplierClamp: [0.55, 1.60] }), note: "", bonusFixture: true },
  { name: "both + ratio [0.55,1.75]", variant: v({ attackRatioClamp: [0.55, 1.75], multiplierClamp: [0.55, 1.60] }), note: "", bonusFixture: true },
];

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
      const upcoming = player.fixtures[0];
      const predictions = ARMS.map((arm) =>
        expectedPoints(player, upcoming, row.minutes, rates, strengths, arm.variant, arm.bonusFixture ?? false).total);
      rows.push({
        gameweek, playerId: row.historicalPlayerId, position: player.position,
        minutes: row.minutes, actual: row.totalPoints, predictions,
      });
    }
  }
  return rows;
}

function spearman(pairs: readonly [number, number][]): number {
  const n = pairs.length;
  if (n < 3) return NaN;
  const rank = (values: number[]): number[] => {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const ranks = new Array<number>(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && order[j + 1].value === order[i].value) j += 1;
      const average = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[order[k].index] = average;
      i = j + 1;
    }
    return ranks;
  };
  const xr = rank(pairs.map((p) => p[0]));
  const yr = rank(pairs.map((p) => p[1]));
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const mx = mean(xr), my = mean(yr);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xr[i] - mx) * (yr[i] - my);
    dx += (xr[i] - mx) ** 2;
    dy += (yr[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

interface ArmStats {
  rmse: number; mae: number; spearman: number; topN: number;
  sseByGameweek: Map<number, { sse: number; ae: number; n: number }>;
}

function score(rows: readonly Row[], arm: number, filter?: (row: Row) => boolean): ArmStats {
  const used = filter ? rows.filter(filter) : rows;
  const byGameweek = new Map<number, { sse: number; ae: number; n: number }>();
  const gameweeks = new Map<number, Row[]>();
  for (const row of used) {
    const error = row.predictions[arm] - row.actual;
    const entry = byGameweek.get(row.gameweek) ?? { sse: 0, ae: 0, n: 0 };
    entry.sse += error * error; entry.ae += Math.abs(error); entry.n += 1;
    byGameweek.set(row.gameweek, entry);
    (gameweeks.get(row.gameweek) ?? gameweeks.set(row.gameweek, []).get(row.gameweek)!).push(row);
  }
  let sse = 0, ae = 0, n = 0;
  for (const e of byGameweek.values()) { sse += e.sse; ae += e.ae; n += e.n; }
  const rhos: number[] = [];
  const tops: number[] = [];
  for (const list of gameweeks.values()) {
    const rho = spearman(list.map((r) => [r.predictions[arm], r.actual] as [number, number]));
    if (Number.isFinite(rho)) rhos.push(rho);
    const sorted = [...list].sort((a, b) => b.predictions[arm] - a.predictions[arm]).slice(0, TOP_N);
    if (sorted.length) tops.push(sorted.reduce((s, r) => s + r.actual, 0) / sorted.length);
  }
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  return {
    rmse: Math.sqrt(sse / n), mae: ae / n,
    spearman: mean(rhos), topN: mean(tops), sseByGameweek: byGameweek,
  };
}

/** Paired bootstrap over gameweek clusters: 95% CI on (arm RMSE - baseline RMSE). */
function pairedCI(base: ArmStats, arm: ArmStats): [number, number, number] {
  const gameweeks = [...base.sseByGameweek.keys()];
  const deltas: number[] = [];
  let seed = 20260824;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let b = 0; b < BOOTSTRAP; b += 1) {
    let baseSse = 0, armSse = 0, n = 0;
    for (let i = 0; i < gameweeks.length; i += 1) {
      const gw = gameweeks[Math.floor(rand() * gameweeks.length)];
      const be = base.sseByGameweek.get(gw)!, ae = arm.sseByGameweek.get(gw)!;
      baseSse += be.sse; armSse += ae.sse; n += be.n;
    }
    deltas.push(Math.sqrt(armSse / n) - Math.sqrt(baseSse / n));
  }
  deltas.sort((a, b) => a - b);
  return [arm.rmse - base.rmse, deltas[Math.floor(0.025 * BOOTSTRAP)], deltas[Math.floor(0.975 * BOOTSTRAP)]];
}

function table(title: string, rows: readonly Row[], filter?: (row: Row) => boolean): void {
  const used = filter ? rows.filter(filter) : rows;
  if (!used.length) { console.log(`\n${title}: no rows\n`); return; }
  const stats = ARMS.map((_, index) => score(rows, index, filter));
  console.log(`\n${title}  (${used.length.toLocaleString()} rows)`);
  console.log("arm                          RMSE      dRMSE   95% CI (paired, gw clusters)   MAE     rho    top30");
  console.log("-".repeat(104));
  stats.forEach((s, index) => {
    if (index === 0) {
      console.log(`${ARMS[index].name.padEnd(28)} ${s.rmse.toFixed(4)}         -   ${" ".repeat(28)}  ${s.mae.toFixed(4)}  ${s.spearman.toFixed(3)}  ${s.topN.toFixed(2)}`);
      return;
    }
    const [delta, lo, hi] = pairedCI(stats[0], s);
    const verdict = hi < 0 ? "BETTER" : lo > 0 ? "WORSE " : "  ns  ";
    console.log(`${ARMS[index].name.padEnd(28)} ${s.rmse.toFixed(4)}  ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}   [${lo >= 0 ? "+" : ""}${lo.toFixed(4)}, ${hi >= 0 ? "+" : ""}${hi.toFixed(4)}] ${verdict}  ${s.mae.toFixed(4)}  ${s.spearman.toFixed(3)}  ${s.topN.toFixed(2)}`);
  });
}

function main(): void {
  const season = loadSeason();
  const rows = collect(season);
  console.log(`walk-forward 2025/26, gameweeks ${FIRST_GAMEWEEK}-38, minutes held at actual`);
  console.log(`scored rows: ${rows.length.toLocaleString()}   bootstrap resamples: ${BOOTSTRAP}`);
  console.log(`held constant across all arms (would otherwise leak):`);
  for (const leak of KNOWN_LEAKS) console.log(`  - ${leak}`);

  table("ALL PLAYED ROWS", rows);
  table("GK + DEF only (section 7's defensive path)", rows, (r) => r.position === "GK" || r.position === "DEF");
  table("MID + FWD only (section 7's attacking path)", rows, (r) => r.position === "MID" || r.position === "FWD");
  table("60+ minutes only (clean sheet actually credited)", rows, (r) => r.minutes >= 60);
  table("GK only", rows, (r) => r.position === "GK");

  console.log("\nrows each arm actually changes vs baseline:");
  ARMS.forEach((arm, index) => {
    if (index === 0) return;
    const moved = rows.filter((r) => Math.abs(r.predictions[index] - r.predictions[0]) > 1e-9);
    const mean = moved.length
      ? moved.reduce((s, r) => s + (r.predictions[index] - r.predictions[0]), 0) / moved.length : 0;
    console.log(`  ${arm.name.padEnd(28)} ${String(moved.length).padStart(6)} rows  mean shift ${mean >= 0 ? "+" : ""}${mean.toFixed(4)} pts`);
  });
  console.log();
  for (const arm of ARMS) if (arm.note) console.log(`note  ${arm.name}: ${arm.note}`);
}

main();
