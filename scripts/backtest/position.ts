/**
 * Per-position report: is this position's xP accurate, and does it swing enough
 * between an easy and a hard fixture?
 *
 * POSITION=MID npx tsx scripts/backtest/position.ts
 *
 * Minutes are held at their actual value so the fixture effect is isolated from
 * the minutes model. Rates are anchored on the player's own gameweeks 1-19,
 * standing in for the previous season the live app has and this data set does
 * not - without that the position prior drags every player toward the pool
 * average and the bias reads far worse than production.
 */
import type { HistoricalStats, Player, Position } from "@/types/player";
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { adjust, BASELINE } from "./variants";

const POSITION = (process.env.POSITION ?? "MID") as Position;
const FIRST = 20;
const BOOTSTRAP = 4000;
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

interface Row {
  gameweek: number; playerId: number; name: string; position: Position;
  minutes: number; actual: number; pred: number; ratio: number; attackMultiplier: number;
  seasonXgi: number; parts: Record<string, number>;
}

/** The player's own gameweeks 1-19, standing in for a previous season. */
function anchor(season: Season, playerId: number): HistoricalStats | undefined {
  const rows = (season.rowsByPlayer.get(playerId) ?? []).filter((r) => r.gameweek < FIRST);
  const minutes = rows.reduce((s, r) => s + r.minutes, 0);
  if (minutes <= 0) return undefined;
  const stats = season.players.get(playerId)!.stats;
  const scale = stats.minutes > 0 ? minutes / stats.minutes : 0;
  return {
    season: "first-half", minutes,
    expectedGoals: rows.reduce((s, r) => s + (r.expectedGoals ?? 0), 0),
    expectedAssists: rows.reduce((s, r) => s + (r.expectedAssists ?? 0), 0),
    bonus: rows.reduce((s, r) => s + (r.bonus ?? 0), 0),
    saves: (stats.saves ?? 0) * scale,
    defensiveContribution: (stats.defensiveContribution ?? 0) * scale,
    yellowCards: rows.reduce((s, r) => s + (r.yellowCards ?? 0), 0),
    redCards: rows.reduce((s, r) => s + (r.redCards ?? 0), 0),
  };
}

function collect(season: Season): Row[] {
  const rows: Row[] = [];
  for (let gw = FIRST; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const byId = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    for (const r of season.rowsByGameweek.get(gw) ?? []) {
      if (r.minutes <= 0) continue;
      const fx = byId.get(r.fixtureId);
      if (!fx) continue;
      const base = playerAt(season, r.historicalPlayerId, gw, fx, r.wasHome);
      const anchored = anchor(season, r.historicalPlayerId);
      if (!base || !anchored) continue;
      const p: Player = { ...base, historical: anchored };
      const f = p.fixtures[0];
      const own = strengths[p.teamId], opp = strengths[f.opponentTeamId];
      const c = expectedPoints(p, f, r.minutes, playerRates(p, formBefore(season, r.historicalPlayerId, gw), gw), strengths, BASELINE);
      const st = season.players.get(r.historicalPlayerId)!.stats;
      rows.push({
        gameweek: gw, playerId: r.historicalPlayerId, name: p.displayName, position: p.position,
        minutes: r.minutes, actual: r.totalPoints, pred: c.total,
        ratio: (r.wasHome ? own.attackHome : own.attackAway) / (r.wasHome ? opp.defenceAway : opp.defenceHome),
        attackMultiplier: adjust(f, { ownTeam: own, opponentTeam: opp }, BASELINE).attackMultiplier,
        seasonXgi: st.minutes > 0 ? (((st.expectedGoals ?? 0) + (st.expectedAssists ?? 0)) / st.minutes) * 90 : 0,
        parts: { appearance: c.appearance, goals: c.goals, assists: c.assists, cleanSheets: c.cleanSheets,
                 defCon: c.defensiveContribution, bonus: c.bonus, cards: c.cards },
      });
    }
  }
  return rows;
}

const band = (label: string, list: readonly Row[]) => {
  if (!list.length) return;
  console.log(`${label.padEnd(26)} n=${String(list.length).padStart(5)}  xP ${mean(list.map((r) => r.pred)).toFixed(3)}`
    + `  actual ${mean(list.map((r) => r.actual)).toFixed(3)}`
    + `  bias ${mean(list.map((r) => r.pred - r.actual)) >= 0 ? "+" : ""}${mean(list.map((r) => r.pred - r.actual)).toFixed(3)}`
    + `  mult ${mean(list.map((r) => r.attackMultiplier)).toFixed(3)}  min ${mean(list.map((r) => r.minutes)).toFixed(1)}`);
};

const quintile = (list: readonly Row[], pick: (r: Row) => number) => {
  const s = [...list].sort((a, b) => b.ratio - a.ratio);
  const q = Math.max(1, Math.floor(s.length / 5));
  return mean(s.slice(0, q).map(pick)) - mean(s.slice(-q).map(pick));
};

function main(): void {
  const season = loadSeason();
  const all = collect(season);
  const rows = all.filter((r) => r.position === POSITION);
  console.log(`${POSITION}, gameweeks ${FIRST}-38, anchored on each player's own gameweeks 1-19\n`);

  console.log("=== ACCURACY ===");
  band("all", rows);
  band("  started (60+)", rows.filter((r) => r.minutes >= 60));
  band("  cameo (<60)", rows.filter((r) => r.minutes < 60));
  const byXgi = [...rows].sort((a, b) => a.seasonXgi - b.seasonXgi);
  const q4 = Math.floor(byXgi.length / 4);
  console.log("\nby the player's own season xGI/90:");
  for (let i = 0; i < 4; i += 1) {
    const s = byXgi.slice(i * q4, i === 3 ? byXgi.length : (i + 1) * q4);
    band(`  xGI/90 ${s[0].seasonXgi.toFixed(2)}-${s[s.length - 1].seasonXgi.toFixed(2)}`, s);
  }
  console.log("\nmean predicted points by component:");
  for (const k of Object.keys(rows[0].parts)) {
    console.log(`  ${k.padEnd(14)} ${mean(rows.map((r) => r.parts[k])).toFixed(3)}`);
  }

  console.log("\n=== FIXTURE SWING ===");
  const sorted = [...rows].sort((a, b) => b.ratio - a.ratio);
  const q5 = Math.floor(sorted.length / 5);
  for (let i = 0; i < 5; i += 1) {
    const s = sorted.slice(i * q5, i === 4 ? sorted.length : (i + 1) * q5);
    band(`  Q${i + 1} ratio ${s[s.length - 1].ratio.toFixed(2)}-${s[0].ratio.toFixed(2)}`, s);
  }
  const modelSwing = quintile(rows, (r) => r.pred), actualSwing = quintile(rows, (r) => r.actual);
  console.log(`  SWING easiest fifth - hardest fifth:  model ${modelSwing >= 0 ? "+" : ""}${modelSwing.toFixed(3)}   observed ${actualSwing >= 0 ? "+" : ""}${actualSwing.toFixed(3)}`);

  // Is the shortfall real, or noise? Bootstrap over gameweek clusters.
  const gws = [...new Set(rows.map((r) => r.gameweek))];
  const byGw = new Map<number, Row[]>();
  for (const r of rows) (byGw.get(r.gameweek) ?? byGw.set(r.gameweek, []).get(r.gameweek)!).push(r);
  let seed = 20260824;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const deltas = Array.from({ length: BOOTSTRAP }, () => {
    const smp = Array.from({ length: gws.length }, () => gws[Math.floor(rand() * gws.length)]).flatMap((g) => byGw.get(g)!);
    return quintile(smp, (r) => r.pred) - quintile(smp, (r) => r.actual);
  }).sort((a, b) => a - b);
  const lo = deltas[Math.floor(0.025 * BOOTSTRAP)], hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
  console.log(`  model minus observed: ${(modelSwing - actualSwing).toFixed(3)}  [${lo.toFixed(3)}, ${hi.toFixed(3)}]  ${hi < 0 ? "MODEL TOO FLAT" : lo > 0 ? "too steep" : "cannot resolve"}`);

  const atCeiling = rows.filter((r) => r.attackMultiplier >= 1.5999).length;
  const atFloor = rows.filter((r) => r.attackMultiplier <= 0.5501).length;
  const mults = rows.map((r) => r.attackMultiplier).sort((a, b) => a - b);
  console.log(`\n  attack multiplier ${mults[0].toFixed(2)}-${mults[mults.length - 1].toFixed(2)}`
    + `   pinned at a clamp: ${atCeiling + atFloor} of ${rows.length} (${(100 * (atCeiling + atFloor) / rows.length).toFixed(1)}%)`);

  const named = (process.env.PLAYERS ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
  const byPlayer = new Map<number, Row[]>();
  for (const r of rows) (byPlayer.get(r.playerId) ?? byPlayer.set(r.playerId, []).get(r.playerId)!).push(r);
  const picked = [...byPlayer.values()].filter((rs) => rs.length >= 12
    && (named.length ? named.some((n) => rs[0].name.toLowerCase().includes(n)) : rs[0].seasonXgi >= 0.5));
  console.log("\nnamed players - easiest third of his own fixtures minus hardest third:");
  console.log("player                       n   xGI/90   easy xP  hard xP   model   observed   ratio range   pinned");
  for (const rs of picked.sort((a, b) => b[0].seasonXgi - a[0].seasonXgi)) {
    const s = [...rs].sort((a, b) => b.ratio - a.ratio);
    const h = Math.max(2, Math.floor(s.length / 3));
    const e = s.slice(0, h), hd = s.slice(-h);
    const ms = mean(e.map((r) => r.pred)) - mean(hd.map((r) => r.pred));
    const as = mean(e.map((r) => r.actual)) - mean(hd.map((r) => r.actual));
    const raw = rs.map((r) => r.ratio).sort((a, b) => a - b);
    const pin = rs.filter((r) => r.attackMultiplier >= 1.5999 || r.attackMultiplier <= 0.5501).length;
    console.log(`${rs[0].name.slice(0, 27).padEnd(28)} ${String(rs.length).padStart(2)}   ${rs[0].seasonXgi.toFixed(2)}     ${mean(e.map((r) => r.pred)).toFixed(2)}     ${mean(hd.map((r) => r.pred)).toFixed(2)}   ${ms >= 0 ? "+" : ""}${ms.toFixed(2)}     ${as >= 0 ? "+" : ""}${as.toFixed(2)}     ${raw[0].toFixed(2)}-${raw[raw.length - 1].toFixed(2)}     ${pin}/${rs.length}`);
  }
}
main();
