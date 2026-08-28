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
  minutes: number; actual: number; pred: number; attackMultiplier: number;
  /** ownAttack / opponentDefence. Higher is easier. Drives goals, assists, bonus. */
  ratio: number;
  /** ownDefence / opponentAttack. Higher is easier. Drives clean sheets and goals conceded. */
  defRatio: number;
  ownDefence: number; oppAttack: number; cleanSheetProbability: number;
  seasonXgi: number; parts: Record<string, number>;
}

/** Mirrors nearestStrengthTier's grid, for counting how much snapping throws away. */
const TIERS = [0.84, 0.92, 1, 1.08, 1.16] as const;
const outsideTiers = (v: number) => v < TIERS[0] || v > TIERS[TIERS.length - 1];

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
      const a = adjust(f, { ownTeam: own, opponentTeam: opp }, BASELINE);
      const ownDefence = r.wasHome ? own.defenceHome : own.defenceAway;
      const oppAttack = r.wasHome ? opp.attackAway : opp.attackHome;
      rows.push({
        gameweek: gw, playerId: r.historicalPlayerId, name: p.displayName, position: p.position,
        minutes: r.minutes, actual: r.totalPoints, pred: c.total,
        ratio: (r.wasHome ? own.attackHome : own.attackAway) / (r.wasHome ? opp.defenceAway : opp.defenceHome),
        defRatio: ownDefence / oppAttack,
        ownDefence, oppAttack, cleanSheetProbability: a.cleanSheetProbability,
        attackMultiplier: a.attackMultiplier,
        seasonXgi: st.minutes > 0 ? (((st.expectedGoals ?? 0) + (st.expectedAssists ?? 0)) / st.minutes) * 90 : 0,
        // Every component, so the printed parts add up to the printed total. Goals
        // conceded is identically zero for MID and FWD, which is why leaving it out
        // went unnoticed - for a defender it is the third-largest term.
        parts: { appearance: c.appearance, goals: c.goals, assists: c.assists, cleanSheets: c.cleanSheets,
                 goalsConceded: c.goalsConceded, saves: c.saves, defCon: c.defensiveContribution,
                 bonus: c.bonus, cards: c.cards, penalties: c.penalties },
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

type Axis = { label: string; key: (r: Row) => number };
const ATTACK_AXIS: Axis = { label: "attack ratio  (ownAttack / oppDefence)", key: (r) => r.ratio };
const DEFENCE_AXIS: Axis = { label: "defence ratio (ownDefence / oppAttack)", key: (r) => r.defRatio };

const quintile = (list: readonly Row[], axis: Axis, pick: (r: Row) => number) => {
  const s = [...list].sort((a, b) => axis.key(b) - axis.key(a));
  const q = Math.max(1, Math.floor(s.length / 5));
  return mean(s.slice(0, q).map(pick)) - mean(s.slice(-q).map(pick));
};

/** Rows in the hardest fifth on this axis. */
const hardest = (list: readonly Row[], axis: Axis) => {
  const s = [...list].sort((a, b) => axis.key(b) - axis.key(a));
  return s.slice(-Math.max(1, Math.floor(s.length / 5)));
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

  // Sampling machinery shared by every interval below: resample whole gameweeks,
  // because rows in one fixture share a team, a clean-sheet probability and a
  // result, so resampling rows understates the spread.
  const gws = [...new Set(rows.map((r) => r.gameweek))];
  const byGw = new Map<number, Row[]>();
  for (const r of rows) (byGw.get(r.gameweek) ?? byGw.set(r.gameweek, []).get(r.gameweek)!).push(r);
  let seed = 20260824;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const samples = Array.from({ length: BOOTSTRAP }, () =>
    Array.from({ length: gws.length }, () => gws[Math.floor(rand() * gws.length)]).flatMap((g) => byGw.get(g)!));
  const interval = (stat: (list: readonly Row[]) => number) => {
    const d = samples.map(stat).sort((a, b) => a - b);
    return [d[Math.floor(0.025 * BOOTSTRAP)], d[Math.floor(0.975 * BOOTSTRAP)]] as const;
  };
  const signed = (x: number, dp = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(dp)}`;

  // Two fixture axes, because they drive different halves of the scoring. A
  // defender's goals, assists and bonus follow ownAttack / opponentDefence; his
  // clean sheet and goals-conceded points follow ownDefence / opponentAttack.
  // Sorting a defender on the attacking axis measures the smaller half.
  for (const axis of [ATTACK_AXIS, DEFENCE_AXIS]) {
    console.log(`\n=== FIXTURE SWING, sorted by ${axis.label} ===`);
    const sorted = [...rows].sort((a, b) => axis.key(b) - axis.key(a));
    const q5 = Math.floor(sorted.length / 5);
    for (let i = 0; i < 5; i += 1) {
      const s = sorted.slice(i * q5, i === 4 ? sorted.length : (i + 1) * q5);
      band(`  Q${i + 1} ${axis.key(s[s.length - 1]).toFixed(2)}-${axis.key(s[0]).toFixed(2)}`, s);
    }
    const modelSwing = quintile(rows, axis, (r) => r.pred);
    const actualSwing = quintile(rows, axis, (r) => r.actual);
    console.log(`  SWING easiest fifth - hardest fifth:  model ${signed(modelSwing)}   observed ${signed(actualSwing)}`);

    // The swing gap is a difference of two differences of two means, so its
    // interval is wide by construction. The mean bias inside the hardest fifth
    // is the same question asked with one fewer subtraction, and it resolves.
    const gap = interval((smp) => quintile(smp, axis, (r) => r.pred) - quintile(smp, axis, (r) => r.actual));
    const verdict = (lo: number, hi: number) => (hi < 0 ? "MODEL TOO FLAT" : lo > 0 ? "MODEL TOO STEEP" : "cannot resolve");
    console.log(`  model minus observed swing: ${signed(modelSwing - actualSwing)}  [${signed(gap[0])}, ${signed(gap[1])}]  ${verdict(gap[0], gap[1])}`);
    const hardBias = mean(hardest(rows, axis).map((r) => r.pred - r.actual));
    const hb = interval((smp) => mean(hardest(smp, axis).map((r) => r.pred - r.actual)));
    console.log(`  bias inside the hardest fifth: ${signed(hardBias)}  [${signed(hb[0])}, ${signed(hb[1])}]  `
      + `${hb[0] > 0 ? "OVER-PROJECTED in hard fixtures" : hb[1] < 0 ? "UNDER-PROJECTED in hard fixtures" : "cannot resolve"}`);
  }

  const atCeiling = rows.filter((r) => r.attackMultiplier >= 1.5999).length;
  const atFloor = rows.filter((r) => r.attackMultiplier <= 0.5501).length;
  const mults = rows.map((r) => r.attackMultiplier).sort((a, b) => a - b);
  console.log(`\nattack multiplier ${mults[0].toFixed(2)}-${mults[mults.length - 1].toFixed(2)}`
    + `   pinned at a clamp: ${atCeiling + atFloor} of ${rows.length} (${(100 * (atCeiling + atFloor) / rows.length).toFixed(1)}%)`);

  // The clean-sheet lookup snaps each side to the nearest of five tiers with no
  // interpolation, so any strength outside 0.84-1.16 lands on an end tier and
  // everything between two tiers is rounded. Both the clean-sheet points and the
  // goals-conceded deduction read that one cell, so a snapping error is counted
  // twice in the same direction.
  const outDef = rows.filter((r) => outsideTiers(r.ownDefence)).length;
  const outAtt = rows.filter((r) => outsideTiers(r.oppAttack)).length;
  const outEither = rows.filter((r) => outsideTiers(r.ownDefence) || outsideTiers(r.oppAttack)).length;
  const defs = rows.map((r) => r.ownDefence).sort((a, b) => a - b);
  const atts = rows.map((r) => r.oppAttack).sort((a, b) => a - b);
  console.log(`clean-sheet tier grid 0.84-1.16   own defence ${defs[0].toFixed(2)}-${defs[defs.length - 1].toFixed(2)}`
    + `   opponent attack ${atts[0].toFixed(2)}-${atts[atts.length - 1].toFixed(2)}`);
  console.log(`  pinned to an end tier: own defence ${outDef} (${(100 * outDef / rows.length).toFixed(1)}%)`
    + `, opponent attack ${outAtt} (${(100 * outAtt / rows.length).toFixed(1)}%)`
    + `, either ${outEither} (${(100 * outEither / rows.length).toFixed(1)}%)`);
  const csp = rows.map((r) => r.cleanSheetProbability).sort((a, b) => a - b);
  console.log(`  distinct clean-sheet probabilities used: ${new Set(rows.map((r) => r.cleanSheetProbability)).size}`
    + `   range ${csp[0].toFixed(2)}-${csp[csp.length - 1].toFixed(2)}`);
  // Does the snapping cost anything measurable, and in which direction? A
  // defence stronger than the top tier is the case where it should hurt most:
  // the grid cannot price it above the 1.16 row.
  const biasOf = (list: readonly Row[]) => mean(list.map((r) => r.pred - r.actual));
  for (const [label, list] of [
    ["own defence above the grid (>1.16)", rows.filter((r) => r.ownDefence > TIERS[4])],
    ["own defence below the grid (<0.84)", rows.filter((r) => r.ownDefence < TIERS[0])],
    ["opponent attack above the grid", rows.filter((r) => r.oppAttack > TIERS[4])],
    ["both sides inside the grid", rows.filter((r) => !outsideTiers(r.ownDefence) && !outsideTiers(r.oppAttack))],
  ] as const) {
    if (!list.length) continue;
    const ci = interval((smp) => {
      const l = smp.filter((r) => list.some((x) => x === r));
      return l.length ? biasOf(l) : NaN;
    });
    console.log(`  ${label.padEnd(36)} n=${String(list.length).padStart(4)}  bias ${signed(biasOf(list))}`
      + `  [${signed(ci[0])}, ${signed(ci[1])}]`
      + `   clean sheets ${mean(list.map((r) => r.parts.cleanSheets)).toFixed(3)}`);
  }

  const named = (process.env.PLAYERS ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
  const byPlayer = new Map<number, Row[]>();
  for (const r of rows) (byPlayer.get(r.playerId) ?? byPlayer.set(r.playerId, []).get(r.playerId)!).push(r);
  const picked = [...byPlayer.values()].filter((rs) => rs.length >= 12
    && (named.length ? named.some((n) => rs[0].name.toLowerCase().includes(n)) : rs[0].seasonXgi >= 0.5));
  // A single player's split has no interval and no way to earn one: a defender
  // scores in four-point clean-sheet lumps, so five fixtures against five is a
  // coin-flip dressed as a measurement. Read the model column; the observed
  // column is here for completeness, not for drawing a conclusion from.
  console.log("\nnamed players - easiest third of his own fixtures minus hardest third:");
  console.log("player                       n   xGI/90   axis      easy xP  hard xP   model   observed   range        pinned");
  for (const rs of picked.sort((a, b) => b[0].seasonXgi - a[0].seasonXgi)) {
    for (const axis of [ATTACK_AXIS, DEFENCE_AXIS]) {
      const s = [...rs].sort((a, b) => axis.key(b) - axis.key(a));
      const h = Math.max(2, Math.floor(s.length / 3));
      const e = s.slice(0, h), hd = s.slice(-h);
      const ms = mean(e.map((r) => r.pred)) - mean(hd.map((r) => r.pred));
      const as = mean(e.map((r) => r.actual)) - mean(hd.map((r) => r.actual));
      const raw = rs.map(axis.key).sort((a, b) => a - b);
      const pin = rs.filter((r) => r.attackMultiplier >= 1.5999 || r.attackMultiplier <= 0.5501).length;
      console.log(`${rs[0].name.slice(0, 27).padEnd(28)} ${String(rs.length).padStart(2)}   ${rs[0].seasonXgi.toFixed(2)}     `
        + `${(axis === ATTACK_AXIS ? "attack" : "defence").padEnd(8)}  ${mean(e.map((r) => r.pred)).toFixed(2)}     ${mean(hd.map((r) => r.pred)).toFixed(2)}   `
        + `${signed(ms, 2)}     ${signed(as, 2)}     ${raw[0].toFixed(2)}-${raw[raw.length - 1].toFixed(2)}    ${pin}/${rs.length}`);
    }
  }
}
main();
