/**
 * Per-player xP backtest, and bias by the strength tier of a player's own team.
 *
 * Runs twice, because the answer depends entirely on what anchors a player's
 * rate. Production blends a player's PREVIOUS SEASON per-90 with this season's
 * form, and gives that anchor 71% of the weight (prior 24 "matches" against an
 * effective cap of 10). A one-season backtest has no previous season, so the
 * anchor silently falls back to the POSITION prior - which prices every forward
 * like an average forward. Mode B emulates the real anchor with an early-season
 * block, and is the honest one to read.
 */
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";

const NAMES = ["Haaland", "Igor Thiago", "João Pedro Junqueira"];
const ANCHOR_THROUGH = 12;
const TIERS = [0.84, 0.92, 1, 1.08, 1.16];
const TIER_LABEL = ["1 weakest", "2", "3 mid", "4", "5 strongest"];

const tierOf = (v: number) =>
  TIERS.reduce((best, t, i) => (Math.abs(v - t) < Math.abs(v - TIERS[best]) ? i : best), 0);

interface Row {
  playerId: number; name: string; position: string; teamId: number;
  gameweek: number; actual: number; pred: number; minutes: number; tier: number;
}

function collect(season: Season, first: number, anchor?: number): Row[] {
  const rows: Row[] = [];
  for (let gw = first; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const byId = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    for (const r of season.rowsByGameweek.get(gw) ?? []) {
      if (r.minutes <= 0) continue;
      const fx = byId.get(r.fixtureId);
      if (!fx) continue;
      const p = playerAt(season, r.historicalPlayerId, gw, fx, r.wasHome, anchor);
      if (!p) continue;
      // Form starts after the anchor block so the two never count the same match.
      const form = formBefore(season, r.historicalPlayerId, gw)
        .slice(anchor === undefined ? 0 : (season.rowsByPlayer.get(r.historicalPlayerId) ?? [])
          .filter((x) => x.gameweek <= anchor && x.minutes > 0).length);
      const own = strengths[p.teamId];
      rows.push({
        playerId: r.historicalPlayerId, name: p.displayName, position: p.position, teamId: p.teamId,
        gameweek: gw, actual: r.totalPoints, minutes: r.minutes,
        pred: expectedPoints(p, p.fixtures[0], r.minutes, playerRates(p, form, gw), strengths, BASELINE).total,
        tier: own ? tierOf(own.overall) : 2,
      });
    }
  }
  return rows;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

let seed = 20260824;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/** Bootstrap CI on mean bias, resampling that player's own matches. */
function ci(list: readonly Row[]): [number, number] {
  if (list.length < 5) return [NaN, NaN];
  const d: number[] = [];
  for (let b = 0; b < 4000; b += 1) {
    let s = 0;
    for (let i = 0; i < list.length; i += 1) { const r = list[Math.floor(rand() * list.length)]; s += r.pred - r.actual; }
    d.push(s / list.length);
  }
  d.sort((a, b) => a - b);
  return [d[100], d[3899]];
}

function playerBlock(title: string, rows: readonly Row[]): void {
  console.log(`\n${title}`);
  console.log("player                        apps   xP/app  actual/app     bias   95% CI            season xP   season actual");
  console.log("-".repeat(114));
  for (const name of NAMES) {
    const list = rows.filter((r) => r.name.includes(name));
    if (!list.length) { console.log(`${name.padEnd(29)} (no rows)`); continue; }
    const p = mean(list.map((r) => r.pred)), a = mean(list.map((r) => r.actual));
    const [lo, hi] = ci(list);
    const sp = list.reduce((s, r) => s + r.pred, 0), sa = list.reduce((s, r) => s + r.actual, 0);
    const short = list[0].name.split(" ").slice(0, 2).join(" ");
    console.log(`${short.padEnd(29)} ${String(list.length).padStart(4)}   ${p.toFixed(2).padStart(6)}      ${a.toFixed(2).padStart(6)}   ${(p - a >= 0 ? "+" : "") + (p - a).toFixed(2)}   [${lo.toFixed(2)}, ${hi.toFixed(2)}]   ${sp.toFixed(0).padStart(9)}   ${sa.toFixed(0).padStart(13)}`);
  }
}

function tierBlock(title: string, rows: readonly Row[], filter?: (r: Row) => boolean): void {
  const used = filter ? rows.filter(filter) : rows;
  console.log(`\n${title}`);
  console.log("team tier          n      xP/app   actual/app     bias");
  console.log("-".repeat(58));
  for (let t = 0; t < 5; t += 1) {
    const list = used.filter((r) => r.tier === t);
    if (!list.length) continue;
    const p = mean(list.map((r) => r.pred)), a = mean(list.map((r) => r.actual));
    console.log(`${TIER_LABEL[t].padEnd(14)} ${String(list.length).padStart(5)}      ${p.toFixed(3)}       ${a.toFixed(3)}   ${(p - a >= 0 ? "+" : "") + (p - a).toFixed(3)}`);
  }
}

function main(): void {
  const season = loadSeason();
  const a = collect(season, 6);
  const b = collect(season, ANCHOR_THROUGH + 1, ANCHOR_THROUGH);

  console.log("=".repeat(114));
  console.log("MODE A - no previous-season anchor (position prior). NOT what production does.");
  console.log("=".repeat(114));
  playerBlock(`gameweeks 6-38, actual minutes`, a);
  tierBlock("bias by the strength tier of the player's own team - all positions", a);

  console.log("\n" + "=".repeat(114));
  console.log(`MODE B - anchored on the player's own gameweek 1-${ANCHOR_THROUGH} rate, emulating the previous season.`);
  console.log("=".repeat(114));
  playerBlock(`gameweeks ${ANCHOR_THROUGH + 1}-38, actual minutes`, b);
  tierBlock("bias by the strength tier of the player's own team - all positions", b);
  tierBlock("same, forwards only", b, (r) => r.position === "FWD");
  tierBlock("same, defenders + goalkeepers only", b, (r) => r.position === "DEF" || r.position === "GK");
}

main();
