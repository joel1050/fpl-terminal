/** Why is a top forward's fixture swing so small, and what widens it correctly? */
import { loadSeason, strengthsBefore, formBefore, playerAt } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { adjust, BASELINE, type Variant } from "./variants";

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const v = (o: Partial<Variant>): Variant => ({ ...BASELINE, ...o });

const ARMS: { name: string; variant: Variant }[] = [
  { name: "shipped: ratio[.70,1.35] mult[.70,1.30]", variant: BASELINE },
  { name: "ratio[.55,1.75] mult[.70,1.30]", variant: v({ attackRatioClamp: [0.55, 1.75] }) },
  { name: "ratio[.70,1.35] mult[.55,1.60]", variant: v({ multiplierClamp: [0.55, 1.60] }) },
  { name: "ratio[.55,1.75] mult[.55,1.60] + bonus follows", variant: v({ attackRatioClamp: [0.55, 1.75], multiplierClamp: [0.55, 1.60] }) },
  { name: "ratio[.40,2.20] mult[.45,1.90]", variant: v({ attackRatioClamp: [0.40, 2.20], multiplierClamp: [0.45, 1.90] }) },
  { name: "no clamps at all", variant: v({ attackRatioClamp: [0.01, 100], multiplierClamp: [0.01, 100] }) },
];
/** Second axis: does bonus follow the fixture? Index-matched to ARMS. */
const BONUS_FIXTURE = [false, false, false, true, false, false];

interface Row { gameweek: number; playerId: number; name: string; ratio: number; actual: number; minutes: number; preds: number[]; mults: number[]; seasonXg: number }

function main(): void {
  const season = loadSeason();
  const rows: Row[] = [];
  for (let gw = 6; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const byId = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    for (const r of season.rowsByGameweek.get(gw) ?? []) {
      if (r.minutes <= 0) continue;
      const fx = byId.get(r.fixtureId);
      if (!fx) continue;
      const p = playerAt(season, r.historicalPlayerId, gw, fx, r.wasHome);
      if (!p || p.position !== "FWD") continue;
      const rates = playerRates(p, formBefore(season, r.historicalPlayerId, gw), gw);
      const f = p.fixtures[0];
      const own = strengths[p.teamId], opp = strengths[f.opponentTeamId];
      const st = season.players.get(r.historicalPlayerId)!.stats;
      rows.push({
        gameweek: gw, playerId: r.historicalPlayerId, name: p.displayName, minutes: r.minutes, actual: r.totalPoints,
        ratio: (r.wasHome ? own.attackHome : own.attackAway) / (r.wasHome ? opp.defenceAway : opp.defenceHome),
        preds: ARMS.map((a, i) => expectedPoints(p, f, r.minutes, rates, strengths, a.variant, BONUS_FIXTURE[i]).total),
        mults: ARMS.map((a) => adjust(f, { ownTeam: own, opponentTeam: opp }, a.variant).attackMultiplier),
        seasonXg: st.minutes > 0 ? ((st.expectedGoals ?? 0) / st.minutes) * 90 : 0,
      });
    }
  }

  const swing = (list: readonly Row[], i: number) => {
    const s = [...list].sort((a, b) => b.ratio - a.ratio);
    const q = Math.floor(s.length / 5);
    return mean(s.slice(0, q).map((r) => r.preds[i])) - mean(s.slice(-q).map((r) => r.preds[i]));
  };
  const actualSwing = (list: readonly Row[]) => {
    const s = [...list].sort((a, b) => b.ratio - a.ratio);
    const q = Math.floor(s.length / 5);
    return mean(s.slice(0, q).map((r) => r.actual)) - mean(s.slice(-q).map((r) => r.actual));
  };

  const elite = rows.filter((r) => r.seasonXg >= 0.5);
  console.log(`forward rows ${rows.length}, elite (xG/90 >= 0.50) ${elite.length}\n`);
  console.log("OBSERVED swing, easiest fifth of fixtures minus hardest fifth:");
  console.log(`  all forwards   ${actualSwing(rows).toFixed(3)} pts`);
  console.log(`  elite forwards ${actualSwing(elite).toFixed(3)} pts\n`);
  console.log("clamp setting                              all fwd   elite    mult range      capped%");
  console.log("-".repeat(92));
  ARMS.forEach((arm, i) => {
    const m = rows.map((r) => r.mults[i]).sort((a, b) => a - b);
    const lim = arm.variant.multiplierClamp;
    const capped = rows.filter((r) => r.mults[i] >= lim[1] - 1e-9 || r.mults[i] <= lim[0] + 1e-9).length;
    console.log(`${arm.name.padEnd(42)} ${swing(rows, i).toFixed(3)}   ${swing(elite, i).toFixed(3)}   ${m[0].toFixed(2)}-${m[m.length - 1].toFixed(2)}     ${(100 * capped / rows.length).toFixed(1)}%`);
  });

  console.log("\naccuracy per arm (forwards only):");
  console.log("arm                                        RMSE     bias     started-only bias");
  ARMS.forEach((arm, i) => {
    const rmse = Math.sqrt(mean(rows.map((r) => (r.preds[i] - r.actual) ** 2)));
    const bias = mean(rows.map((r) => r.preds[i] - r.actual));
    const st = rows.filter((r) => r.minutes >= 60);
    const sb = mean(st.map((r) => r.preds[i] - r.actual));
    console.log(`${arm.name.padEnd(42)} ${rmse.toFixed(4)}  ${bias >= 0 ? "+" : ""}${bias.toFixed(3)}   ${sb >= 0 ? "+" : ""}${sb.toFixed(3)}`);
  });

  // Is the shortfall real, or sampling noise? Bootstrap over gameweek clusters.
  console.log("\nis the swing shortfall real? (model swing minus observed swing, 95% CI)");
  const gws = [...new Set(rows.map((r) => r.gameweek))];
  const byGw = new Map<number, Row[]>();
  for (const r of rows) (byGw.get(r.gameweek) ?? byGw.set(r.gameweek, []).get(r.gameweek)!).push(r);
  let seed = 20260824;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const samples = Array.from({ length: 4000 }, () => Array.from({ length: gws.length }, () => gws[Math.floor(rand() * gws.length)]).flatMap((g) => byGw.get(g)!));
  for (const [label, filter] of [["all forwards", () => true], ["elite", (r: Row) => r.seasonXg >= 0.5]] as const) {
    for (const i of [0, 3]) {
      const deltas = samples.map((smp) => {
        const list = smp.filter(filter as (r: Row) => boolean);
        return swing(list, i) - actualSwing(list);
      }).sort((a, b) => a - b);
      const lo = deltas[100], hi = deltas[3899];
      const point = swing(rows.filter(filter as (r: Row) => boolean), i) - actualSwing(rows.filter(filter as (r: Row) => boolean));
      console.log(`  ${label.padEnd(14)} ${ARMS[i].name.slice(0, 34).padEnd(35)} ${point >= 0 ? "+" : ""}${point.toFixed(3)}  [${lo >= 0 ? "+" : ""}${lo.toFixed(3)}, ${hi >= 0 ? "+" : ""}${hi.toFixed(3)}]  ${hi < 0 ? "MODEL TOO FLAT" : lo > 0 ? "too steep" : "matches"}`);
    }
  }

  // The Haaland case: why is his own swing near zero?
  const byPlayer = new Map<number, Row[]>();
  for (const r of rows) (byPlayer.get(r.playerId) ?? byPlayer.set(r.playerId, []).get(r.playerId)!).push(r);
  const top = [...byPlayer.values()].filter((rs) => rs.length >= 20)
    .sort((a, b) => b[0].seasonXg - a[0].seasonXg).slice(0, 4);
  console.log("\nper-player: easiest third of his own fixtures minus hardest third");
  console.log("player                  n   shipped   widened+bonus   actual");
  for (const rs of top) {
    const s2 = [...rs].sort((a, b) => b.ratio - a.ratio);
    const h = Math.max(3, Math.floor(s2.length / 3));
    const e = s2.slice(0, h), hd = s2.slice(-h);
    const sw = (i: number) => mean(e.map((r) => r.preds[i])) - mean(hd.map((r) => r.preds[i]));
    const act = mean(e.map((r) => r.actual)) - mean(hd.map((r) => r.actual));
    console.log(`  ${rs[0].name.slice(0, 21).padEnd(22)} ${String(rs.length).padStart(2)}   ${sw(0) >= 0 ? "+" : ""}${sw(0).toFixed(2)}      ${sw(3) >= 0 ? "+" : ""}${sw(3).toFixed(2)}          ${act >= 0 ? "+" : ""}${act.toFixed(2)}`);
  }

  console.log("\nwhy a top forward barely moves: his own raw ratio range vs what survives the clamps");
  for (const rs of top) {
    const raw = rs.map((r) => r.ratio).sort((a, b) => a - b);
    const cur = rs.map((r) => r.mults[0]).sort((a, b) => a - b);
    const wide = rs.map((r) => r.mults[3]).sort((a, b) => a - b);
    const atCap = rs.filter((r) => r.mults[0] >= 1.2999).length;
    console.log(`  ${rs[0].name.slice(0, 22).padEnd(23)} raw ratio ${raw[0].toFixed(2)}-${raw[raw.length - 1].toFixed(2)}`
      + `   shipped mult ${cur[0].toFixed(2)}-${cur[cur.length - 1].toFixed(2)} (${atCap}/${rs.length} pinned at 1.30)`
      + `   widened ${wide[0].toFixed(2)}-${wide[wide.length - 1].toFixed(2)}`);
  }
}
main();
