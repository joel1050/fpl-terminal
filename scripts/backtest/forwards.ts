/**
 * Forwards: is their xP accurate, and does it swing enough between a weak and
 * a strong opponent? Walk-forward over 2025/26, minutes held at actual so the
 * fixture effect is isolated from the minutes model.
 */
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { adjust, BASELINE, type Variant } from "./variants";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

interface Row {
  gameweek: number; playerId: number; name: string; position: string;
  minutes: number; actual: number; pred: number;
  goalsPart: number; assistsPart: number; bonusPart: number; appearancePart: number;
  attackMultiplier: number; oppDefence: number; ratio: number;
  seasonXgPer90: number; isHome: boolean;
}

function collect(season: Season, variant: Variant): Row[] {
  const rows: Row[] = [];
  for (let gw = 6; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const byId = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    for (const r of season.rowsByGameweek.get(gw) ?? []) {
      if (r.minutes <= 0) continue;
      const fx = byId.get(r.fixtureId);
      if (!fx) continue;
      const p = playerAt(season, r.historicalPlayerId, gw, fx, r.wasHome);
      if (!p) continue;
      const rates = playerRates(p, formBefore(season, r.historicalPlayerId, gw), gw);
      const fixture = p.fixtures[0];
      const c = expectedPoints(p, fixture, r.minutes, rates, strengths, variant);
      const a = adjust(fixture, { ownTeam: strengths[p.teamId], opponentTeam: strengths[fixture.opponentTeamId] }, variant);
      const own = strengths[p.teamId], opp = strengths[fixture.opponentTeamId];
      const ownAttack = r.wasHome ? own.attackHome : own.attackAway;
      const oppDefence = r.wasHome ? opp.defenceAway : opp.defenceHome;
      const st = season.players.get(r.historicalPlayerId)!.stats;
      rows.push({
        gameweek: gw, playerId: r.historicalPlayerId, name: p.displayName, position: p.position,
        minutes: r.minutes, actual: r.totalPoints, pred: c.total,
        goalsPart: c.goals, assistsPart: c.assists, bonusPart: c.bonus, appearancePart: c.appearance,
        attackMultiplier: a.attackMultiplier, oppDefence, ratio: ownAttack / oppDefence,
        seasonXgPer90: st.minutes > 0 ? ((st.expectedGoals ?? 0) / st.minutes) * 90 : 0,
        isHome: r.wasHome,
      });
    }
  }
  return rows;
}

function band(label: string, list: readonly Row[]): void {
  if (!list.length) { console.log(`${label.padEnd(26)} (none)`); return; }
  console.log(`${label.padEnd(26)} n=${String(list.length).padStart(5)}  xP ${mean(list.map((r) => r.pred)).toFixed(3)}`
    + `  actual ${mean(list.map((r) => r.actual)).toFixed(3)}`
    + `  bias ${mean(list.map((r) => r.pred - r.actual)) >= 0 ? "+" : ""}${mean(list.map((r) => r.pred - r.actual)).toFixed(3)}`
    + `  mult ${mean(list.map((r) => r.attackMultiplier)).toFixed(3)}`
    + `  min ${mean(list.map((r) => r.minutes)).toFixed(1)}`);
}

function quintilesByOpponent(label: string, list: readonly Row[]): { predSwing: number; actualSwing: number } {
  const sorted = [...list].sort((a, b) => b.ratio - a.ratio); // best matchup first
  const q = Math.floor(sorted.length / 5);
  const slices = Array.from({ length: 5 }, (_, i) => sorted.slice(i * q, i === 4 ? sorted.length : (i + 1) * q));
  console.log(`\n${label}  (sorted by own attack / opponent defence, easiest first)`);
  slices.forEach((s, i) => band(`  Q${i + 1} ratio ${s[s.length - 1].ratio.toFixed(2)}-${s[0].ratio.toFixed(2)}`, s));
  const predSwing = mean(slices[0].map((r) => r.pred)) - mean(slices[4].map((r) => r.pred));
  const actualSwing = mean(slices[0].map((r) => r.actual)) - mean(slices[4].map((r) => r.actual));
  console.log(`  SWING easiest - hardest:   model ${predSwing >= 0 ? "+" : ""}${predSwing.toFixed(3)} xP`
    + `   actual ${actualSwing >= 0 ? "+" : ""}${actualSwing.toFixed(3)} pts`);
  return { predSwing, actualSwing };
}

function main(): void {
  const season = loadSeason();
  const rows = collect(season, BASELINE);
  const fwd = rows.filter((r) => r.position === "FWD");

  console.log("=== 2. ARE FORWARDS ACCURATE? ===\n");
  band("all forwards", fwd);
  band("  started (60+)", fwd.filter((r) => r.minutes >= 60));
  band("  cameo (<60)", fwd.filter((r) => r.minutes < 60));
  console.log("\nby the forward's own season xG per 90:");
  const byXg = [...fwd].sort((a, b) => a.seasonXgPer90 - b.seasonXgPer90);
  const q = Math.floor(byXg.length / 4);
  for (let i = 0; i < 4; i += 1) {
    const s = byXg.slice(i * q, i === 3 ? byXg.length : (i + 1) * q);
    band(`  xG/90 ${s[0].seasonXgPer90.toFixed(2)}-${s[s.length - 1].seasonXgPer90.toFixed(2)}`, s);
  }
  console.log("\nmean component split for forwards:");
  console.log(`  appearance ${mean(fwd.map((r) => r.appearancePart)).toFixed(3)}`
    + `  goals ${mean(fwd.map((r) => r.goalsPart)).toFixed(3)}`
    + `  assists ${mean(fwd.map((r) => r.assistsPart)).toFixed(3)}`
    + `  bonus ${mean(fwd.map((r) => r.bonusPart)).toFixed(3)}`);

  console.log("\n\n=== 3. HOW MUCH DOES THE FIXTURE SWING A FORWARD? ===");
  quintilesByOpponent("ALL FORWARDS", fwd);
  const elite = fwd.filter((r) => r.seasonXgPer90 >= 0.5);
  quintilesByOpponent(`ELITE FORWARDS (season xG/90 >= 0.50, ${new Set(elite.map((r) => r.playerId)).size} players)`, elite);

  console.log("\nattack multiplier for forwards - how compressed is it?");
  const mults = fwd.map((r) => r.attackMultiplier).sort((a, b) => a - b);
  const raw = fwd.map((r) => r.ratio).sort((a, b) => a - b);
  const pct = (a: number[], p: number) => a[Math.floor(p * (a.length - 1))];
  console.log(`  raw own-attack/opp-defence ratio: ${raw[0].toFixed(2)} - ${raw[raw.length - 1].toFixed(2)}  (5th ${pct(raw, .05).toFixed(2)}, 95th ${pct(raw, .95).toFixed(2)})`);
  console.log(`  final attack multiplier:          ${mults[0].toFixed(2)} - ${mults[mults.length - 1].toFixed(2)}  (5th ${pct(mults, .05).toFixed(2)}, 95th ${pct(mults, .95).toFixed(2)})`);
  const atCap = fwd.filter((r) => r.attackMultiplier >= 1.2999).length;
  const atFloor = fwd.filter((r) => r.attackMultiplier <= 0.7001).length;
  console.log(`  pinned at the 1.30 ceiling: ${atCap} rows (${(100 * atCap / fwd.length).toFixed(1)}%)`);
  console.log(`  pinned at the 0.70 floor:   ${atFloor} rows (${(100 * atFloor / fwd.length).toFixed(1)}%)`);

  console.log("\nbiggest forwards by season xG/90 - their own easiest vs hardest split:");
  const byPlayer = new Map<number, Row[]>();
  for (const r of fwd) (byPlayer.get(r.playerId) ?? byPlayer.set(r.playerId, []).get(r.playerId)!).push(r);
  const top = [...byPlayer.entries()].filter(([, rs]) => rs.length >= 20)
    .sort((a, b) => b[1][0].seasonXgPer90 - a[1][0].seasonXgPer90).slice(0, 6);
  console.log("player                 n   xG/90   easy xP  hard xP  model swing   easy act  hard act  actual swing");
  for (const [, rs] of top) {
    const s = [...rs].sort((a, b) => b.ratio - a.ratio);
    const h = Math.max(3, Math.floor(s.length / 3));
    const easy = s.slice(0, h), hard = s.slice(-h);
    const ep = mean(easy.map((r) => r.pred)), hp = mean(hard.map((r) => r.pred));
    const ea = mean(easy.map((r) => r.actual)), ha = mean(hard.map((r) => r.actual));
    console.log(`${rs[0].name.slice(0, 20).padEnd(21)} ${String(rs.length).padStart(2)}   ${rs[0].seasonXgPer90.toFixed(2)}    ${ep.toFixed(2)}     ${hp.toFixed(2)}     ${(ep - hp >= 0 ? "+" : "") + (ep - hp).toFixed(2)}         ${ea.toFixed(2)}      ${ha.toFixed(2)}     ${(ea - ha >= 0 ? "+" : "") + (ea - ha).toFixed(2)}`);
  }
}
main();
