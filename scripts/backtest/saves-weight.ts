/**
 * How much should this season's saves count against a goalkeeper's record?
 *
 * Production blends the current season into a keeper's save rate at
 * `n / (n + 6)`, where n is matches played. That constant was selected by
 * `form-weight.ts` on overall xP, which is dominated by outfield attacking
 * returns; nothing in this suite ever calibrated it for saves. At two matches
 * it puts 25% weight on a dozen saves, against a previous season of ninety-odd.
 *
 * It was also, until now, untestable: `historical-match-stats.json` carried no
 * per-match saves, so `currentBefore` could not build a walk-forward save total
 * and the harness skipped the current-season blend entirely. The ingest now
 * carries `saves`, which is what makes this script possible and what removed
 * the matching entry from `KNOWN_LEAKS`.
 *
 * Scored on saves directly - the quantity the rate predicts - rather than on
 * whole-player xP, where a keeper's save points are a fraction of the variance.
 * Both the count and the points it converts to are reported, because FPL pays
 * on `floor(saves / 3)` and a rate can be right on average while landing on the
 * wrong side of the threshold.
 *
 * Minutes are actual, as in `run.ts`, so the minutes model does not bury the
 * signal being measured.
 *
 *   BACKTEST_DATA_DIR=$ROOT/2025-26 npx tsx scripts/backtest/saves-weight.ts
 *   npx tsx scripts/backtest/saves-weight.ts --pool /tmp/sv-*.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectedFloorDivision } from "@/lib/projections/distributions";
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { playerRates } from "./xp";
import { adjust, BASELINE } from "./variants";

/** Gameweek 1 has no current-season evidence, so every arm is identical there. */
const FIRST_GAMEWEEK = 2;
const EARLY_THROUGH = 5;
const BOOTSTRAP = 4000;
const SAVES_PER_POINT = 3;
const SHIPPED_PRIOR_MATCHES = 6;

const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * `null` is the evidence-weighted arm: instead of a constant, the anchor is
 * worth however many matches it was actually built from, so a keeper with a
 * full previous season needs a full season to overturn it and one with barely
 * any history moves quickly. This is the principled alternative to a constant,
 * and the reason the constant looks wrong at two matches.
 */
type Weight = number | null;

const ARMS: { name: string; weight: Weight }[] = [
  { name: "shipped n/(n+6)", weight: SHIPPED_PRIOR_MATCHES },
  ...[2, 4, 10, 15, 20, 30, 45, 60].map((k) => ({ name: `n/(n+${k})`, weight: k })),
  { name: "anchor's own matches", weight: null },
  { name: "previous season only", weight: 1e9 },
];

interface Case {
  gameweek: number;
  actualSaves: number;
  actualPoints: number;
  predictedSaves: number[];
  predictedPoints: number[];
}

function collect(season: Season): Case[] {
  const cases: Case[] = [];
  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(season, gameweek);
    const fixtureById = new Map((season.fixturesByGameweek.get(gameweek) ?? []).map((f) => [f.fixtureId, f]));
    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0 || row.saves === undefined) continue;
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
      // The anchor's weight in matches, for the evidence-weighted arm. Held off
      // zero so a keeper with no history does not hand the current season
      // everything on one appearance.
      const anchorMatches = Math.max((player.historical?.minutes ?? 0) / 90, 1);

      const predictedSaves = ARMS.map((arm) => {
        const rates = playerRates(player, form, gameweek, {
          savesPriorWeight: arm.weight ?? anchorMatches,
        }, strengths);
        return rates.saves * minutesShare * adjustment.savesEnvironment;
      });
      cases.push({
        gameweek,
        actualSaves: row.saves,
        actualPoints: Math.floor(row.saves / SAVES_PER_POINT),
        predictedSaves,
        predictedPoints: predictedSaves.map((m) => expectedFloorDivision(m, SAVES_PER_POINT)),
      });
    }
  }
  return cases;
}

const savesRmse = (list: readonly Case[], index: number) =>
  Math.sqrt(mean(list.map((c) => (c.predictedSaves[index] - c.actualSaves) ** 2)));
const pointsRmse = (list: readonly Case[], index: number) =>
  Math.sqrt(mean(list.map((c) => (c.predictedPoints[index] - c.actualPoints) ** 2)));
const savesBias = (list: readonly Case[], index: number) =>
  mean(list.map((c) => c.predictedSaves[index] - c.actualSaves));

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
  const base = savesRmse(cases, 0);
  const basePoints = pointsRmse(cases, 0);
  console.log(`\n${title}: ${cases.length} goalkeeper appearances, mean saves ${mean(cases.map((c) => c.actualSaves)).toFixed(2)}`);
  console.log("  arm                      savesRMSE   dRMSE    95% CI (gw clusters)     verdict  ptsRMSE   dPts     bias");
  ARMS.forEach((arm, index) => {
    const score = savesRmse(cases, index);
    const points = pointsRmse(cases, index);
    const bias = savesBias(cases, index);
    if (index === 0) {
      console.log(`  ${arm.name.padEnd(24)} ${score.toFixed(5)}       -                             -       ${points.toFixed(5)}     -    ${fmt(bias, 3)}`);
      return;
    }
    const { lo, hi } = interval(cases, index, savesRmse, seed + index);
    console.log(`  ${arm.name.padEnd(24)} ${score.toFixed(5)}  ${fmt(score - base)}  [${fmt(lo)}, ${fmt(hi)}]  ${verdictOf(lo, hi)}  ${points.toFixed(5)}  ${fmt(points - basePoints, 4)}  ${fmt(bias, 3)}`);
  });
}

function report(label: string, cases: readonly Case[]): void {
  console.log(`\n=== ${label}: the current-season weight on goalkeeper saves ===`);
  const gw = (c: Case) => c.gameweek % 100;
  window(`gameweeks ${FIRST_GAMEWEEK}-${EARLY_THROUGH} (where a small sample carries most weight)`,
    cases.filter((c) => gw(c) <= EARLY_THROUGH), 20260917);
  window(`gameweeks ${EARLY_THROUGH + 1}-38`, cases.filter((c) => gw(c) > EARLY_THROUGH), 20260918);
  window("all gameweeks", cases, 20260919);
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

  const dataDir = process.env.BACKTEST_DATA_DIR ?? path.join(path.resolve(__dirname, "../.."), "data/generated");
  const label = path.basename(dataDir);
  const season = loadSeason();
  const cases = collect(season);
  if (cases.length === 0) {
    console.error("no goalkeeper rows carry per-match saves; re-run prepare-seasons.ts with the current ingest");
    process.exit(1);
  }
  report(label, cases);

  const out = process.env.BACKTEST_CASE_OUT;
  if (out) {
    const offset = Number(label.slice(0, 4)) * 100;
    writeFileSync(out, JSON.stringify({
      label, arms: ARMS.map((a) => a.name),
      cases: cases.map((c) => ({ ...c, gameweek: offset + c.gameweek })),
    }));
    console.log(`\ncases written to ${out}`);
  }
}

main();
