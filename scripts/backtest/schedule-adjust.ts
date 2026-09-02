/**
 * Does schedule-adjusting a player's own form help?
 *
 * blendPlayerRate averages a player's past match xG/xA rates with no regard for
 * who he faced, and the result is then multiplied by the upcoming fixture's
 * attack multiplier. A player on a soft run is therefore counted twice. The
 * proposed fix ("1a") divides each past match rate by the multiplier that
 * applied to that match, blends the normalized rates, and re-applies the
 * upcoming multiplier.
 *
 * Three arms:
 *   A shipped   blend(r_i)                      x m_next
 *   B form-only blend(r_i / m_i)                x m_next
 *   C both      blend(r_i / m_i, prior / m_bar) x m_next
 *
 * B alone mixes scales: a player on a strong team keeps an inflated anchor
 * while his form half is deflated. C normalizes the anchor by its own realized
 * mean multiplier, and is the honest version of the change.
 *
 * One season per process; season.ts reads BACKTEST_DATA_DIR at import.
 *   BACKTEST_DATA_DIR=... npx tsx scripts/backtest/schedule-adjust.ts [label]
 */
import { loadSeason, strengthsBefore, type MatchRow } from "./season";
import { calculateFixtureAdjustment } from "@/lib/projections/fixtureAdjustment";
import { blendPlayerRate, PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES } from "@/lib/projections/playerForm";
import type { TeamStrength } from "@/types/projection";

/** Production clamps the blended rate to [0, RATE_CEILING.goalInvolvement]. */
const CEILING = 3;
const blend = (rates: number[], prior: number) =>
  Math.min(CEILING, Math.max(0, blendPlayerRate(rates, prior, PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES)));

const label = process.argv[2] ?? process.env.BACKTEST_DATA_DIR ?? "season";
const ANCHOR_MATCHES = 12;
const MIN_FORM = 3;   // need a form window before the arms can differ
const BOOTSTRAP = 2000;

const season = loadSeason();
/**
 * FPL only began publishing xG partway through 2022/23, so that season's first
 * 15 gameweeks carry minutes with a hard zero for expectedGoals. Blending those
 * as real zeros would poison every prior, and nothing downstream would notice,
 * so any gameweek with no xG at all is dropped rather than trusted.
 */
const gameweeks = [...season.rowsByGameweek.keys()]
  .filter((gw) => (season.rowsByGameweek.get(gw) ?? []).reduce((a, r) => a + (r.expectedGoals ?? 0), 0) > 0)
  .sort((a, b) => a - b);
const dropped = season.rowsByGameweek.size - gameweeks.length;
if (dropped > 0) console.log(`note: dropped ${dropped} gameweeks with no xG recorded`);
const keep = new Set(gameweeks);
for (const gw of [...season.rowsByGameweek.keys()]) if (!keep.has(gw)) season.rowsByGameweek.delete(gw);
for (const [pid, rows] of season.rowsByPlayer) season.rowsByPlayer.set(pid, rows.filter((r) => keep.has(r.gameweek)));
// Fixtures too, or strengthsBefore folds 15 zero-xG gameweeks into every team's
// in-season form and flattens the whole strength table toward the prior.
season.fixtures = season.fixtures.filter((f) => keep.has(f.gameweek));
for (const gw of [...season.fixturesByGameweek.keys()]) if (!keep.has(gw)) season.fixturesByGameweek.delete(gw);
season.leagueAverageXg = season.fixtures.reduce((a, f) => a + f.homeXg + f.awayXg, 0) / (season.fixtures.length * 2);
const FIRST_GW = gameweeks[0];
const LAST_GW = gameweeks[gameweeks.length - 1];
const ANCHOR_THROUGH = FIRST_GW + ANCHOR_MATCHES - 1;

const strengthCache = new Map<number, Record<number, TeamStrength>>();
function strengths(gw: number): Record<number, TeamStrength> {
  let s = strengthCache.get(gw);
  if (!s) { s = strengthsBefore(season, gw); strengthCache.set(gw, s); }
  return s;
}

const fixtureById = new Map(season.fixtures.map((f) => [f.fixtureId, f]));

/** The attack multiplier that applied to one player-match, walked forward. */
function multiplier(row: MatchRow): number | undefined {
  const fx = fixtureById.get(row.fixtureId);
  if (!fx) return undefined;
  const s = strengths(row.gameweek);
  const own = row.wasHome ? fx.homeTeamId : fx.awayTeamId;
  const opp = row.wasHome ? fx.awayTeamId : fx.homeTeamId;
  if (!s[own] || !s[opp]) return undefined;
  return calculateFixtureAdjustment(
    { gameweek: row.gameweek, opponentTeamId: opp, opponentShortName: "OPP", isHome: row.wasHome, difficulty: 3 },
    { ownTeam: s[own], opponentTeam: s[opp] },
  ).attackMultiplier;
}
const multCache = new Map<number, number | undefined>();
const mult = (row: MatchRow) => {
  const key = row.fixtureId * 2 + (row.wasHome ? 1 : 0);
  if (!multCache.has(key)) multCache.set(key, multiplier(row));
  return multCache.get(key);
};

interface Sample {
  gw: number;
  name: string;
  position: string;
  minutes: number;
  actualXg: number;    // per 90, the match being predicted
  actualXa: number;
  mNext: number;
  mBarForm: number;    // decay-weighted mean multiplier over the form window
  mBarAnchor: number;
  predA: { xg: number; xa: number };
  predB: { xg: number; xa: number };
  predC: { xg: number; xa: number };
  /** Arm C restricted to what production can actually compute. See ARM D below. */
  predD: { xg: number; xa: number };
  predE: { xg: number; xa: number };
  actualPoints: number;
}

const samples: Sample[] = [];

for (let gw = ANCHOR_THROUGH + 1; gw <= LAST_GW; gw += 1) {
  for (const row of season.rowsByGameweek.get(gw) ?? []) {
    if (row.minutes <= 0) continue;
    const source = season.players.get(row.historicalPlayerId);
    if (!source) continue;
    const mNext = mult(row);
    if (mNext === undefined) continue;
    /**
     * ARM E - arm D as production will actually run it. D normalized past and
     * upcoming multipliers alike with base = 1, because no season here had FDR.
     * Production has live FDR on the upcoming fixture and none stored for past
     * ones, so the base term survives inside the normalized rate. This measures
     * that asymmetry rather than assuming it away.
     */
    const fxNow = fixtureById.get(row.fixtureId);
    const sNow = strengths(gw);
    const ownNow = row.wasHome ? fxNow!.homeTeamId : fxNow!.awayTeamId;
    const oppNow = row.wasHome ? fxNow!.awayTeamId : fxNow!.homeTeamId;
    const realDifficulty = (row.wasHome ? fxNow!.homeDifficulty : fxNow!.awayDifficulty) ?? 3;
    const mNextFdr = sNow[ownNow] && sNow[oppNow]
      ? calculateFixtureAdjustment(
          { gameweek: gw, opponentTeamId: oppNow, opponentShortName: "OPP", isHome: row.wasHome, difficulty: realDifficulty },
          { ownTeam: sNow[ownNow], opponentTeam: sNow[oppNow] },
        ).attackMultiplier
      : mNext;

    const all = season.rowsByPlayer.get(row.historicalPlayerId) ?? [];
    const anchorRows = all.filter((r) => r.gameweek <= ANCHOR_THROUGH && r.minutes > 0);
    const formRows = all.filter((r) => r.gameweek > ANCHOR_THROUGH && r.gameweek < gw && r.minutes > 0);
    if (anchorRows.length === 0 || formRows.length < MIN_FORM) continue;

    const anchorMinutes = anchorRows.reduce((a, r) => a + r.minutes, 0);
    if (anchorMinutes <= 0) continue;
    const priorXg = (anchorRows.reduce((a, r) => a + (r.expectedGoals ?? 0), 0) / anchorMinutes) * 90;
    const priorXa = (anchorRows.reduce((a, r) => a + (r.expectedAssists ?? 0), 0) / anchorMinutes) * 90;

    // Anchor's own realized mean multiplier, minutes-weighted.
    let am = 0, amw = 0;
    for (const r of anchorRows) {
      const m = mult(r);
      if (m === undefined) continue;
      am += m * r.minutes; amw += r.minutes;
    }
    const mBarAnchor = amw > 0 ? am / amw : 1;

    /**
     * ARM D - arm C on production's information set.
     *
     * Two things arm C uses that production does not have:
     *   1. a past match's multiplier from the strengths as they stood *then*.
     *      Production keeps one current strength table, so every past fixture
     *      has to be re-scored with today's strengths.
     *   2. the anchor's realized mean multiplier. Production's anchor is last
     *      season's aggregate, with no per-match opponents on the same team-id
     *      space. Over a balanced 38-match season opponents average to the
     *      league mean and venue averages to 1.0, so that mean multiplier is
     *      approximately the team's own attack strength - which production has.
     *
     * A 12-match within-season anchor is less balanced than a full season, so
     * this understates how well approximation 2 does in production.
     */
    const now = strengths(gw);
    const ownTeamId = season.teamOf.get(row.historicalPlayerId);
    const multNow = (r: MatchRow): number | undefined => {
      const fx = fixtureById.get(r.fixtureId);
      if (!fx) return undefined;
      const own = r.wasHome ? fx.homeTeamId : fx.awayTeamId;
      const opp = r.wasHome ? fx.awayTeamId : fx.homeTeamId;
      if (!now[own] || !now[opp]) return undefined;
      return calculateFixtureAdjustment(
        { gameweek: r.gameweek, opponentTeamId: opp, opponentShortName: "OPP", isHome: r.wasHome, difficulty: 3 },
        { ownTeam: now[own], opponentTeam: now[opp] },
      ).attackMultiplier;
    };
    const ownAttack = ownTeamId !== undefined && now[ownTeamId]
      ? (now[ownTeamId].attackHome + now[ownTeamId].attackAway) / 2
      : 1;

    const mults = formRows.map((r) => mult(r));
    if (mults.some((m) => m === undefined)) continue;
    const ms = mults as number[];

    const rawXg = formRows.map((r) => (r.expectedGoals ?? 0) / r.minutes * 90);
    const rawXa = formRows.map((r) => (r.expectedAssists ?? 0) / r.minutes * 90);
    const normXg = rawXg.map((v, i) => v / ms[i]);
    const normXa = rawXa.map((v, i) => v / ms[i]);

    // Decay-weighted mean of m over the form window: the factor separating A from B.
    const n = ms.length;
    let ws = 0, wm = 0;
    for (let i = 0; i < n; i += 1) { const w = PLAYER_FORM_DECAY ** i; ws += w; wm += w * ms[n - 1 - i]; }
    const mBarForm = wm / ws;

    samples.push({
      gw, name: source.displayName, position: source.position, minutes: row.minutes,
      actualXg: (row.expectedGoals ?? 0) / row.minutes * 90,
      actualXa: (row.expectedAssists ?? 0) / row.minutes * 90,
      mNext, mBarForm, mBarAnchor,
      predA: { xg: blend(rawXg, priorXg) * mNext, xa: blend(rawXa, priorXa) * mNext },
      predB: { xg: blend(normXg, priorXg) * mNext, xa: blend(normXa, priorXa) * mNext },
      predC: { xg: blend(normXg, priorXg / mBarAnchor) * mNext, xa: blend(normXa, priorXa / mBarAnchor) * mNext },
      actualPoints: row.totalPoints,
      predE: (() => {
        const mn = formRows.map((r) => multNow(r) ?? 1);
        return {
          xg: blend(rawXg.map((v, i) => v / mn[i]), priorXg / ownAttack) * mNextFdr,
          xa: blend(rawXa.map((v, i) => v / mn[i]), priorXa / ownAttack) * mNextFdr,
        };
      })(),
      predD: (() => {
        const mn = formRows.map((r) => multNow(r) ?? 1);
        return {
          xg: blend(rawXg.map((v, i) => v / mn[i]), priorXg / ownAttack) * mNext,
          xa: blend(rawXa.map((v, i) => v / mn[i]), priorXa / ownAttack) * mNext,
        };
      })(),
    });
  }
}

// ---------- diagnostic ----------
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rmse = (xs: number[]) => Math.sqrt(mean(xs.map((x) => x * x)));

const mb = samples.map((s) => s.mBarForm);
const gap = samples.map((s) => Math.abs(s.predA.xg - s.predC.xg));
console.log(`\n=== ${label} ===`);
console.log(`gameweeks ${FIRST_GW}-${LAST_GW}, anchor ${FIRST_GW}-${ANCHOR_THROUGH}, scored ${ANCHOR_THROUGH + 1}-${LAST_GW}`);
console.log(`mBar(form) mean ${mean(mb).toFixed(4)}  p05 ${q(mb, .05).toFixed(3)}  p50 ${q(mb, .5).toFixed(3)}  p95 ${q(mb, .95).toFixed(3)}`);
console.log(`|A-C| xg   mean ${mean(gap).toFixed(5)}  p95 ${q(gap, .95).toFixed(5)}  vs mean prediction ${mean(samples.map((s) => s.predA.xg)).toFixed(4)}`);

// ---------- metric 1: next match, started rows only ----------
const started = samples.filter((s) => s.minutes >= 60);
type Arm = "predA" | "predB" | "predC" | "predD" | "predE";
const names: Record<Arm, string> = { predA: "A shipped", predB: "B form-only", predC: "C both", predD: "D C@production", predE: "E D+live FDR" };
const nextErr = (rows: Sample[], arm: Arm) =>
  rows.flatMap((s) => [s[arm].xg - s.actualXg, s[arm].xa - s.actualXa]);

console.log(`\n-- NEXT: xGI/90, started rows only (${started.length} rows) --`);
for (const arm of ["predA", "predB", "predC", "predD", "predE"] as Arm[]) {
  console.log(`   ${names[arm].padEnd(12)} RMSE ${rmse(nextErr(started, arm)).toFixed(5)}  bias ${mean(nextErr(started, arm)).toFixed(5)}`);
}

// ---------- metric 2: rest of season, one row per player per cutoff ----------
interface RestRow { player: number; predA: number; predC: number; predD: number; target: number; }
const restRows: RestRow[] = [];
const CUTOFFS: number[] = [];
for (let c = ANCHOR_THROUGH + 5; c <= LAST_GW - 6; c += 4) CUTOFFS.push(c);

for (const cutoff of CUTOFFS) {
  const s = strengths(cutoff);
  for (const [playerId, all] of season.rowsByPlayer) {
    const anchorRows = all.filter((r) => r.gameweek <= ANCHOR_THROUGH && r.minutes > 0);
    const formRows = all.filter((r) => r.gameweek > ANCHOR_THROUGH && r.gameweek < cutoff && r.minutes > 0);
    const future = all.filter((r) => r.gameweek >= cutoff && r.minutes > 0);
    if (anchorRows.length === 0 || formRows.length < MIN_FORM) continue;
    const futureMinutes = future.reduce((a, r) => a + r.minutes, 0);
    if (futureMinutes < 270) continue;

    const anchorMinutes = anchorRows.reduce((a, r) => a + r.minutes, 0);
    if (anchorMinutes <= 0) continue;
    const priorXg = (anchorRows.reduce((a, r) => a + (r.expectedGoals ?? 0), 0) / anchorMinutes) * 90;
    const priorXa = (anchorRows.reduce((a, r) => a + (r.expectedAssists ?? 0), 0) / anchorMinutes) * 90;
    let am = 0, amw = 0;
    for (const r of anchorRows) { const m = mult(r); if (m === undefined) continue; am += m * r.minutes; amw += r.minutes; }
    const mBarAnchor = amw > 0 ? am / amw : 1;

    const fm = formRows.map((r) => mult(r));
    if (fm.some((m) => m === undefined)) continue;
    const ms = fm as number[];
    const rawXg = formRows.map((r) => (r.expectedGoals ?? 0) / r.minutes * 90);
    const rawXa = formRows.map((r) => (r.expectedAssists ?? 0) / r.minutes * 90);

    // Future schedule as known at the cutoff: strengths frozen, fixtures known.
    let fw = 0, fmw = 0;
    for (const r of future) {
      const fx = fixtureById.get(r.fixtureId);
      if (!fx) continue;
      const own = r.wasHome ? fx.homeTeamId : fx.awayTeamId;
      const opp = r.wasHome ? fx.awayTeamId : fx.homeTeamId;
      if (!s[own] || !s[opp]) continue;
      const m = calculateFixtureAdjustment(
        { gameweek: r.gameweek, opponentTeamId: opp, opponentShortName: "OPP", isHome: r.wasHome, difficulty: 3 },
        { ownTeam: s[own], opponentTeam: s[opp] },
      ).attackMultiplier;
      fw += m * r.minutes; fmw += r.minutes;
    }
    if (fmw <= 0) continue;
    const mBarFuture = fw / fmw;

    const ownTeamId = season.teamOf.get(playerId);
    const ownAttack = ownTeamId !== undefined && s[ownTeamId]
      ? (s[ownTeamId].attackHome + s[ownTeamId].attackAway) / 2 : 1;
    const msNow = formRows.map((r) => {
      const fx = fixtureById.get(r.fixtureId);
      if (!fx) return 1;
      const own = r.wasHome ? fx.homeTeamId : fx.awayTeamId;
      const opp = r.wasHome ? fx.awayTeamId : fx.homeTeamId;
      if (!s[own] || !s[opp]) return 1;
      return calculateFixtureAdjustment(
        { gameweek: r.gameweek, opponentTeamId: opp, opponentShortName: "OPP", isHome: r.wasHome, difficulty: 3 },
        { ownTeam: s[own], opponentTeam: s[opp] },
      ).attackMultiplier;
    });
    const rateD = blend(rawXg.map((v, i) => v / msNow[i]), priorXg / ownAttack)
      + blend(rawXa.map((v, i) => v / msNow[i]), priorXa / ownAttack);
    const rateA = blend(rawXg, priorXg) + blend(rawXa, priorXa);
    const rateC = blend(rawXg.map((v, i) => v / ms[i]), priorXg / mBarAnchor)
      + blend(rawXa.map((v, i) => v / ms[i]), priorXa / mBarAnchor);
    restRows.push({
      player: playerId,
      predA: rateA * mBarFuture,
      predC: rateC * mBarFuture,
      predD: rateD * mBarFuture,
      target: (future.reduce((a, r) => a + (r.expectedGoals ?? 0) + (r.expectedAssists ?? 0), 0) / futureMinutes) * 90,
    });
  }
}

console.log(`\n-- REST: xGI/90 over remaining season, ${CUTOFFS.length} cutoffs x players = ${restRows.length} rows --`);
const rA = rmse(restRows.map((r) => r.predA - r.target));
const rC = rmse(restRows.map((r) => r.predC - r.target));
console.log(`   A shipped    RMSE ${rA.toFixed(5)}  bias ${mean(restRows.map((r) => r.predA - r.target)).toFixed(5)}`);
console.log(`   C both       RMSE ${rC.toFixed(5)}  bias ${mean(restRows.map((r) => r.predC - r.target)).toFixed(5)}`);
console.log(`   D C@production RMSE ${rmse(restRows.map((r) => r.predD - r.target)).toFixed(5)}  bias ${mean(restRows.map((r) => r.predD - r.target)).toFixed(5)}`);
{
  const [p, lo, hi] = boot(restRows.map((r) => ({ predA: r.predA, predC: r.predD, target: r.target, player: r.player })), (r) => r.player);
  console.log(`   D - A = ${p.toFixed(5)}  CI95 [${lo.toFixed(5)}, ${hi.toFixed(5)}]`);
}

// paired bootstrap, clustered by player
interface Scored { predA: number; predC: number; target: number }
function boot<T extends Scored>(rows: T[], key: (row: T) => number): [number, number, number] {
  const by = new Map<number, T[]>();
  rows.forEach((r) => { (by.get(key(r)) ?? by.set(key(r), []).get(key(r))!).push(r); });
  const cl = [...by.values()];
  const delta = (rs: Scored[]) => rmse(rs.map((r) => r.predC - r.target)) - rmse(rs.map((r) => r.predA - r.target));
  const point = delta(rows);
  const draws: number[] = [];
  for (let b = 0; b < BOOTSTRAP; b += 1) {
    const pick: T[] = [];
    for (let k = 0; k < cl.length; k += 1) pick.push(...cl[Math.floor(Math.random() * cl.length)]);
    draws.push(delta(pick));
  }
  draws.sort((a, b) => a - b);
  return [point, draws[Math.floor(.025 * BOOTSTRAP)], draws[Math.floor(.975 * BOOTSTRAP)]];
}
const [pR, loR, hiR] = boot(restRows, (r) => r.player);
console.log(`   C - A = ${pR.toFixed(5)}  CI95 [${loR.toFixed(5)}, ${hiR.toFixed(5)}]  (negative favours C)`);

const nextPairs = started.map((s) => ({ gw: s.gw, predA: s.predA.xg + s.predA.xa, predC: s.predC.xg + s.predC.xa, target: s.actualXg + s.actualXa }));
const [pN, loN, hiN] = boot(nextPairs, (r) => r.gw);
console.log(`\n   NEXT clustered by gameweek: C - A = ${pN.toFixed(5)}  CI95 [${loN.toFixed(5)}, ${hiN.toFixed(5)}]`);


// ---------- bias by schedule of the form window ----------
// Arm A multiplies a rate that already contains the past schedule by the next
// fixture's multiplier, so its bias should climb with mBar(form) and C's should
// not. Bias is estimated far more precisely than an RMSE difference, so this is
// the test with power; the RMSE arms above are underpowered by construction.
const byM = [...started].sort((a, b) => a.mBarForm - b.mBarForm);
const Q = 5;
console.log(`\n-- bias by mBar(form) quintile, started rows (xGI/90) --`);
console.log(`   quintile  mBar range      n     A bias     C bias`);
for (let i = 0; i < Q; i += 1) {
  const lo = Math.floor((i * byM.length) / Q), hi = Math.floor(((i + 1) * byM.length) / Q);
  const cut = byM.slice(lo, hi);
  const bias = (arm: Arm) => mean(cut.map((s) => (s[arm].xg + s[arm].xa) - (s.actualXg + s.actualXa)));
  console.log(`   ${String(i + 1).padStart(5)}     ${cut[0].mBarForm.toFixed(2)}-${cut[cut.length - 1].mBarForm.toFixed(2)}   ${String(cut.length).padStart(5)}   ${bias("predA").toFixed(5).padStart(8)}   ${bias("predC").toFixed(5).padStart(8)}`);
}

// Head-to-tail gradient: how much of the schedule tilt each arm leaves behind.
function gradient(rows: Sample[], arm: Arm): number {
  const s = [...rows].sort((a, b) => a.mBarForm - b.mBarForm);
  const k = Math.floor(s.length / Q);
  const bias = (cut: Sample[]) => mean(cut.map((r) => (r[arm].xg + r[arm].xa) - (r.actualXg + r.actualXa)));
  return bias(s.slice(s.length - k)) - bias(s.slice(0, k));
}
const gA = gradient(started, "predA"), gC = gradient(started, "predC"), gD = gradient(started, "predD"), gE = gradient(started, "predE");
const gdraws: number[] = [];
const gwCl = [...new Map(started.map((s) => [s.gw, 0])).keys()].map((gw) => started.filter((s) => s.gw === gw));
for (let b = 0; b < BOOTSTRAP; b += 1) {
  const pick: Sample[] = [];
  for (let k = 0; k < gwCl.length; k += 1) pick.push(...gwCl[Math.floor(Math.random() * gwCl.length)]);
  gdraws.push(Math.abs(gradient(pick, "predC")) - Math.abs(gradient(pick, "predA")));
}
gdraws.sort((a, b) => a - b);
console.log(`   Q5-Q1 gradient:  A ${gA.toFixed(5)}   C ${gC.toFixed(5)}   D ${gD.toFixed(5)}   E ${gE.toFixed(5)}`);
console.log(`   |C|-|A| = ${(Math.abs(gC) - Math.abs(gA)).toFixed(5)}  CI95 [${gdraws[Math.floor(.025 * BOOTSTRAP)].toFixed(5)}, ${gdraws[Math.floor(.975 * BOOTSTRAP)].toFixed(5)}]  (negative = C leaves less tilt)`);

/**
 * Is the tilt above the double count, or just an over-steep multiplier?
 *
 * mBar(form) quintiles load heavily on team strength - a strong attack clears
 * 1.0 in nearly every fixture - so a bias rising with it is equally consistent
 * with the multiplier's slope being too steep and applied once. The ratio
 * mBarForm/mBarAnchor is the player's recent run against their own baseline and
 * is roughly orthogonal to team level; mBarAnchor alone is team level with the
 * swing averaged out. Whichever carries the gradient names the defect.
 */
function biasBy(pick: (s: Sample) => number, title: string): void {
  const sorted = [...started].sort((a, b) => pick(a) - pick(b));
  console.log(`\n-- A bias by ${title} --`);
  for (let i = 0; i < Q; i += 1) {
    const cut = sorted.slice(Math.floor((i * sorted.length) / Q), Math.floor(((i + 1) * sorted.length) / Q));
    const bias = (arm: Arm) => mean(cut.map((s) => (s[arm].xg + s[arm].xa) - (s.actualXg + s.actualXa)));
    console.log(`   Q${i + 1}  ${pick(cut[0]).toFixed(2)}-${pick(cut[cut.length - 1]).toFixed(2)}  n ${String(cut.length).padStart(4)}   A ${bias("predA").toFixed(5).padStart(8)}   C ${bias("predC").toFixed(5).padStart(8)}`);
  }
}
biasBy((s) => s.mBarForm / s.mBarAnchor, "mBarForm / mBarAnchor (own recent run vs own baseline)");
biasBy((s) => s.mBarAnchor, "mBarAnchor (team level, swing averaged out)");
