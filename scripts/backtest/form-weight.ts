/**
 * How much should this season's form outweigh the player's prior-season rate?
 *
 * Sweeps blendPlayerRate's two parameters - the recency decay and the anchor's
 * weight in "matches worth" - which are the only constants in the model with no
 * runnable backtest behind them. PLAYER_FORM_DECAY and
 * PLAYER_FORM_PRIOR_WEIGHT_MATCHES cite a 2023/24 + 2024/25 corpus that is not
 * in this repository, so nothing here can confirm or refute that fit; this
 * measures them against the one season that is.
 *
 * The corpus has no previous season, so a block of early gameweeks plays that
 * part, exactly as anchor.ts and players.ts do. Two splits are run because the
 * answer depends on how good the anchor is, and production's anchor is a full
 * 38-match season - longer than either. The transferable quantity is therefore
 * the ratio priorWeight / anchorMatches, not the raw weight.
 *
 * Two metrics:
 *   RATE  predicted xGI against the player's actual xGI in the next match,
 *         started rows only. This is what blendPlayerRate estimates, and it
 *         carries most of the signal.
 *   xP    full expected points against actual FPL points, every row. The
 *         deliverable, but single-match points are noisy enough that it mostly
 *         confirms rather than discriminates.
 *
 * Every reported winner is picked on 4 folds and scored on the 5th, because the
 * clean-sheet arms in README.md all improved in sample and lost out of it.
 *
 *   npx tsx scripts/backtest/form-weight.ts
 */
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";
import { PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES } from "@/lib/projections/playerForm";
import type { PlayerMatchRate } from "@/types/projection";
import type { Player, PlayerFixture } from "@/types/player";
import type { TeamStrength } from "@/types/projection";

const DECAYS = [0.8, 0.85, 0.9, 0.95, 1.0] as const;
const WEIGHTS = [0, 2, 4, 6, 8, 12, 16, 24, 32, 48, 1e9] as const;
const FOLDS = 5;
const label = (w: number) => (w >= 1e9 ? "anchor-only" : w === 0 ? "form-only" : String(w));

interface Row {
  player: Player;
  fixture: PlayerFixture;
  form: PlayerMatchRate[];
  strengths: Record<number, TeamStrength>;
  gameweek: number;
  minutes: number;
  actualPoints: number;
  actualXgi: number;
  position: string;
  name: string;
}

function collect(season: Season, anchorThrough: number): Row[] {
  const rows: Row[] = [];
  for (let gw = anchorThrough + 1; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const byId = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    for (const r of season.rowsByGameweek.get(gw) ?? []) {
      if (r.minutes <= 0) continue;
      const fx = byId.get(r.fixtureId);
      if (!fx) continue;
      const p = playerAt(season, r.historicalPlayerId, gw, fx, r.wasHome, anchorThrough);
      if (!p || !p.historical?.expectedGoals) continue;
      // Form starts after the anchor block so no match is counted twice.
      const anchored = (season.rowsByPlayer.get(r.historicalPlayerId) ?? [])
        .filter((x) => x.gameweek <= anchorThrough && x.minutes > 0).length;
      rows.push({
        player: p, fixture: p.fixtures[0], form: formBefore(season, r.historicalPlayerId, gw).slice(anchored),
        strengths, gameweek: gw, minutes: r.minutes, actualPoints: r.totalPoints,
        actualXgi: (r.expectedGoals ?? 0) + (r.expectedAssists ?? 0),
        position: p.position, name: p.displayName,
      });
    }
  }
  return rows;
}

/** Per-row squared errors for one (decay, weight) pair. */
function errors(rows: readonly Row[], decay: number, weight: number) {
  const rate: { gw: number; e: number; row: number }[] = [];
  const xp: { gw: number; e: number }[] = [];
  rows.forEach((r, row) => {
    const rates = playerRates(r.player, r.form, r.gameweek, { formDecay: decay, formPriorWeight: weight });
    if (r.minutes >= 60) {
      const predicted = (rates.xg + rates.xa) * (r.minutes / 90);
      rate.push({ gw: r.gameweek, e: (predicted - r.actualXgi) ** 2, row });
    }
    const total = expectedPoints(r.player, r.fixture, r.minutes, rates, r.strengths, BASELINE).total;
    xp.push({ gw: r.gameweek, e: (total - r.actualPoints) ** 2 });
  });
  return { rate, xp };
}

const rmse = (e: readonly { e: number }[]) =>
  Math.sqrt(e.reduce((s, x) => s + x.e, 0) / Math.max(e.length, 1));

/** Paired bootstrap over gameweek clusters: rows in one gameweek are not independent. */
function pairedCI(a: readonly { gw: number; e: number }[], b: readonly { gw: number; e: number }[]): [number, number] {
  const byGw = new Map<number, { a: number[]; b: number[] }>();
  a.forEach((x, i) => {
    const e = byGw.get(x.gw) ?? { a: [], b: [] };
    e.a.push(x.e); e.b.push(b[i].e); byGw.set(x.gw, e);
  });
  const clusters = [...byGw.values()];
  let seed = 20260831;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const diffs: number[] = [];
  for (let boot = 0; boot < 2000; boot += 1) {
    let sa = 0, sb = 0, n = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      const c = clusters[Math.floor(rand() * clusters.length)];
      for (let j = 0; j < c.a.length; j += 1) { sa += c.a[j]; sb += c.b[j]; n += 1; }
    }
    diffs.push(Math.sqrt(sa / n) - Math.sqrt(sb / n));
  }
  diffs.sort((x, y) => x - y);
  return [diffs[50], diffs[1949]];
}

function run(season: Season, anchorThrough: number): void {
  const rows = collect(season, anchorThrough);
  const anchorMatches = 
    rows.length === 0 ? 0 :
    rows.reduce((s, r) => s + (r.player.historical!.minutes / 90), 0) / rows.length;
  const gameweeks = [...new Set(rows.map((r) => r.gameweek))].sort((a, b) => a - b);

  console.log("\n" + "=".repeat(104));
  console.log(`ANCHOR gameweeks 1-${anchorThrough}  |  EVALUATE gameweeks ${anchorThrough + 1}-38`);
  console.log(`${rows.length} rows, ${rows.filter((r) => r.minutes >= 60).length} started; mean anchor = ${anchorMatches.toFixed(1)} matches (90-min equivalents)`);
  console.log("=".repeat(104));

  const cache = new Map<string, ReturnType<typeof errors>>();
  const get = (d: number, w: number) => {
    const key = `${d}|${w}`;
    let v = cache.get(key);
    if (!v) { v = errors(rows, d, w); cache.set(key, v); }
    return v;
  };

  console.log("\nIN-SAMPLE RATE RMSE (predicted xGI vs actual, started rows)   lower is better");
  console.log("decay \\ prior  " + WEIGHTS.map((w) => label(w).padStart(8)).join(""));
  for (const d of DECAYS) {
    console.log(`${d.toFixed(2).padEnd(14)}` + WEIGHTS.map((w) => rmse(get(d, w).rate).toFixed(4).padStart(8)).join(""));
  }

  console.log("\nIN-SAMPLE xP RMSE (all rows)");
  console.log("decay \\ prior  " + WEIGHTS.map((w) => label(w).padStart(8)).join(""));
  for (const d of DECAYS) {
    console.log(`${d.toFixed(2).padEnd(14)}` + WEIGHTS.map((w) => rmse(get(d, w).xp).toFixed(4).padStart(8)).join(""));
  }

  // Is the decay dimension flat? Compare its spread to the weight dimension's.
  const atShipped = DECAYS.map((d) => rmse(get(d, PLAYER_FORM_PRIOR_WEIGHT_MATCHES).rate));
  const atShippedDecay = WEIGHTS.filter((w) => w < 1e9).map((w) => rmse(get(PLAYER_FORM_DECAY, w).rate));
  const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
  console.log(`\nRATE RMSE spread across decay (at prior 24):  ${spread(atShipped).toFixed(4)}`);
  console.log(`RATE RMSE spread across prior (at decay 0.9): ${spread(atShippedDecay).toFixed(4)}`);

  // 5-fold cross-validation on gameweek clusters, interleaved so each fold spans the season.
  console.log(`\n${FOLDS}-FOLD CV over gameweek clusters - winner chosen on 4 folds, scored on the 5th`);
  console.log("fold   held-out GWs                      picked (decay, prior)    held-out RATE RMSE   shipped (0.9, 24)");
  console.log("-".repeat(104));
  let cvPicked = 0, cvShipped = 0, cvN = 0;
  const picks: string[] = [];
  for (let f = 0; f < FOLDS; f += 1) {
    const held = new Set(gameweeks.filter((_, i) => i % FOLDS === f));
    let best = { d: PLAYER_FORM_DECAY, w: PLAYER_FORM_PRIOR_WEIGHT_MATCHES, e: Infinity };
    for (const d of DECAYS) for (const w of WEIGHTS) {
      const train = get(d, w).rate.filter((x) => !held.has(x.gw));
      const e = rmse(train);
      if (e < best.e) best = { d, w, e };
    }
    const heldPicked = get(best.d, best.w).rate.filter((x) => held.has(x.gw));
    const heldShipped = get(PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES).rate.filter((x) => held.has(x.gw));
    cvPicked += heldPicked.reduce((s, x) => s + x.e, 0);
    cvShipped += heldShipped.reduce((s, x) => s + x.e, 0);
    cvN += heldPicked.length;
    picks.push(`${best.d}/${label(best.w)}`);
    console.log(`${String(f + 1).padEnd(6)} ${[...held].join(",").padEnd(33)} ${`${best.d}, ${label(best.w)}`.padEnd(24)} ${rmse(heldPicked).toFixed(4).padStart(18)}   ${rmse(heldShipped).toFixed(4).padStart(17)}`);
  }
  console.log("-".repeat(104));
  console.log(`pooled held-out RATE RMSE   picked ${Math.sqrt(cvPicked / cvN).toFixed(4)}   shipped ${Math.sqrt(cvShipped / cvN).toFixed(4)}   `
    + `delta ${(Math.sqrt(cvPicked / cvN) - Math.sqrt(cvShipped / cvN)).toFixed(4)}`);
  console.log(`fold picks: ${picks.join("  ")}   ${new Set(picks).size === 1 ? "(stable)" : "(UNSTABLE - the surface is flat or the fit is noise)"}`);

  // Best at the shipped decay, with a paired CI against the shipped pair.
  const shipped = get(PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES);
  let bestW = PLAYER_FORM_PRIOR_WEIGHT_MATCHES, bestE = rmse(shipped.rate);
  for (const w of WEIGHTS) { const e = rmse(get(PLAYER_FORM_DECAY, w).rate); if (e < bestE) { bestW = w; bestE = e; } }
  const [lo, hi] = pairedCI(get(PLAYER_FORM_DECAY, bestW).rate, shipped.rate);
  console.log(`\nAt the shipped decay ${PLAYER_FORM_DECAY}: best prior weight = ${label(bestW)}`);
  console.log(`  RATE RMSE ${bestE.toFixed(4)} vs shipped ${rmse(shipped.rate).toFixed(4)}`
    + `   delta ${(bestE - rmse(shipped.rate)).toFixed(4)}  95% CI [${lo.toFixed(4)}, ${hi.toFixed(4)}]`
    + `  ${lo < 0 && hi < 0 ? "SIGNIFICANT" : "not resolved"}`);
  if (bestW < 1e9 && anchorMatches > 0) {
    console.log(`  as a ratio to the anchor: ${(bestW / anchorMatches).toFixed(2)} x anchor length`
      + `   (shipped 24 against a 38-match season = 0.63 x)`);
  }

  // The aggregate is dominated by players whose rate never moved, and they
  // cannot distinguish the arms. The question "is the anchor over-trusted?" is
  // really about the players whose in-season form diverged from it, so split by
  // how far apart the two signals are and score each band separately.
  const anchorRate = (r: Row) => {
    const h = r.player.historical!;
    return (((h.expectedGoals ?? 0) + (h.expectedAssists ?? 0)) / h.minutes) * 90;
  };
  const formRate = (r: Row) => {
    const played = r.form.filter((m) => m.minutes > 0);
    if (!played.length) return undefined;
    const mins = played.reduce((s, m) => s + m.minutes, 0);
    return (played.reduce((s, m) => s + m.xg + m.xa, 0) / mins) * 90;
  };
  const started = rows.map((r, i) => ({ r, i })).filter((x) => x.r.minutes >= 60);
  const withDiv = started
    .map((x) => ({ ...x, f: formRate(x.r), a: anchorRate(x.r) }))
    .filter((x) => x.f !== undefined && x.r.form.filter((m) => m.minutes > 0).length >= 4)
    .map((x) => ({ ...x, div: Math.abs(x.f! - x.a) }))
    .sort((p, q) => p.div - q.div);
  console.log(`\nBY HOW FAR THIS SEASON'S FORM DIVERGES FROM THE ANCHOR (started rows, 4+ form matches, n=${withDiv.length})`);
  console.log("  the aggregate above is carried by players whose rate never moved; these are the ones it turns on");
  console.log("divergence band            n     anchor/90  form/90   RATE RMSE at prior weight");
  console.log("                                                     " + [4, 8, 16, 24, 48, 1e9].map((w) => label(w).padStart(9)).join(""));
  console.log("-".repeat(104));
  const q = Math.floor(withDiv.length / 4);
  for (let b = 0; b < 4; b += 1) {
    const band = withDiv.slice(b * q, b === 3 ? withDiv.length : (b + 1) * q);
    const idx = new Set(band.map((x) => x.i));
    const cells = [4, 8, 16, 24, 48, 1e9].map((w) =>
      rmse(get(PLAYER_FORM_DECAY, w).rate.filter((x) => idx.has(x.row))).toFixed(4).padStart(9));
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    console.log(`${(b === 3 ? "widest 25%" : b === 0 ? "narrowest 25%" : `band ${b + 1}`).padEnd(22)} ${String(band.length).padStart(5)}`
      + `      ${mean(band.map((x) => x.a)).toFixed(3)}    ${mean(band.map((x) => x.f!)).toFixed(3)}   ` + cells.join(""));
  }

  // Do the two null arms earn the mechanism its place?
  const anchorOnly = rmse(get(PLAYER_FORM_DECAY, 1e9).rate);
  const formOnly = rmse(get(PLAYER_FORM_DECAY, 0).rate);
  const [alo, ahi] = pairedCI(shipped.rate, get(PLAYER_FORM_DECAY, 1e9).rate);
  console.log(`\nDoes in-season form earn its place?`);
  console.log(`  anchor only (form ignored)  ${anchorOnly.toFixed(4)}`);
  console.log(`  shipped (0.9, 24)           ${rmse(shipped.rate).toFixed(4)}   delta vs anchor-only ${(rmse(shipped.rate) - anchorOnly).toFixed(4)}  95% CI [${alo.toFixed(4)}, ${ahi.toFixed(4)}]  ${alo < 0 && ahi < 0 ? "form helps" : "NOT RESOLVED"}`);
  console.log(`  form only (anchor ignored)  ${formOnly.toFixed(4)}`);
}

/**
 * The other current-season weight: regressedPlayerRate's
 * `clamp(gameweek / divisor, 0, cap)`, which caps this season at 60% by
 * gameweek 6 while the xG/xA blend above caps it at 29% forever.
 *
 * In this harness only bonus (and goals/assists as xG/xA fallbacks) has a
 * walk-forward current value. `currentBefore` carries no defensive
 * contributions, saves or cards, so `currentRate` returns undefined for those
 * and they never enter the blend at all. This is therefore a bonus-rate sweep,
 * and bonus is about a tenth of a forward's expected points - expect it to be
 * underpowered rather than wrong.
 */
function currentWeightSweep(season: Season, anchorThrough: number): void {
  const rows = collect(season, anchorThrough);
  console.log("\n" + "=".repeat(104));
  console.log(`SECOND KNOB: regressedPlayerRate current-season weight (anchor 1-${anchorThrough}) - bonus only in this harness`);
  console.log("=".repeat(104));
  console.log("cap \\ divisor" + [5, 10, 20, 38].map((d) => String(d).padStart(10)).join("") + "      xP RMSE");
  const base = { formDecay: PLAYER_FORM_DECAY, formPriorWeight: PLAYER_FORM_PRIOR_WEIGHT_MATCHES };
  for (const cap of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    const cells = [5, 10, 20, 38].map((div) => {
      const e = rows.map((r) => {
        const rates = playerRates(r.player, r.form, r.gameweek, { ...base, currentWeightDivisor: div, currentWeightCap: cap });
        return { gw: r.gameweek, e: (expectedPoints(r.player, r.fixture, r.minutes, rates, r.strengths, BASELINE).total - r.actualPoints) ** 2 };
      });
      return rmse(e).toFixed(4).padStart(10);
    });
    console.log(`${cap.toFixed(1).padEnd(13)}` + cells.join("") + (cap === 0.6 ? "   <- shipped at divisor 10" : ""));
  }
}

/**
 * Does the blend get a player's LEVEL right when it genuinely changed?
 *
 * The divergence bands above cannot answer this. They are sorted by how far
 * form sits from the anchor, and most of that gap is noise, so the band
 * averages are carried by players who never changed and revert. A real level
 * change has to be identified by whether it PERSISTS.
 *
 * So the target here is not the next match - single-match xGI is too noisy to
 * resolve a subgroup - but the player's actual rate over the rest of the
 * season. That is what a projection is really estimating. Each player is scored
 * once, at a fixed point `OBSERVE` matches into the evaluation window, so the
 * rows are independent and the counts mean what they say.
 */
let OBSERVE = 8;
const RISE = 1.5, FALL = 1 / 1.5;
const MIN_FUTURE_MATCHES = 6, MIN_FUTURE_MINUTES = 400;

function levelChange(season: Season, anchorThrough: number, quiet = false): { obs: number; bestAll: number; bestMovers: number; biasRose: number; biasFell: number; n: number;
     allShipped: number; allProposed: number; movShipped: number; movProposed: number;
     biasRoseProposed: number; biasFellProposed: number } {
  const at = anchorThrough + OBSERVE;
  const strengths = strengthsBefore(season, at + 1);
  interface P {
    name: string; position: string; anchor: number; form: number; future: number;
    pred: Map<number, number>; formMatches: number;
  }
  const out: P[] = [];
  for (const [playerId, all] of season.rowsByPlayer) {
    const formRows = all.filter((r) => r.gameweek > anchorThrough && r.gameweek <= at && r.minutes > 0);
    const futureRows = all.filter((r) => r.gameweek > at && r.minutes > 0);
    if (formRows.length < 4) continue;
    const futureMinutes = futureRows.reduce((s, r) => s + r.minutes, 0);
    if (futureRows.length < MIN_FUTURE_MATCHES || futureMinutes < MIN_FUTURE_MINUTES) continue;
    const fx = (season.fixturesByGameweek.get(at + 1) ?? [])[0];
    if (!fx) continue;
    const player = playerAt(season, playerId, at + 1, fx, true, anchorThrough);
    if (!player?.historical?.expectedGoals || !player.historical.minutes) continue;
    const h = player.historical;
    const anchor = (((h.expectedGoals ?? 0) + (h.expectedAssists ?? 0)) / h.minutes) * 90;
    if (anchor <= 0.02) continue;
    const formMinutes = formRows.reduce((s, r) => s + r.minutes, 0);
    const form = (formRows.reduce((s, r) => s + (r.expectedGoals ?? 0) + (r.expectedAssists ?? 0), 0) / formMinutes) * 90;
    const future = (futureRows.reduce((s, r) => s + (r.expectedGoals ?? 0) + (r.expectedAssists ?? 0), 0) / futureMinutes) * 90;
    const formInput = formRows.map((r) => ({ xg: r.expectedGoals ?? 0, xa: r.expectedAssists ?? 0, minutes: r.minutes }));
    const pred = new Map<number, number>();
    for (const w of [0, 4, 8, 12, 16, 24, 48, 1e9]) {
      const rates = playerRates(player, formInput, at + 1, { formDecay: PLAYER_FORM_DECAY, formPriorWeight: w });
      pred.set(w, rates.xg + rates.xa);
    }
    // The proposed shape: same anchor weight, but let the form side keep
    // accumulating instead of asymptoting at 10 effective matches.
    const flat = playerRates(player, formInput, at + 1, { formDecay: 1, formPriorWeight: 24 });
    pred.set(-1, flat.xg + flat.xa);
    out.push({ name: player.displayName, position: player.position, anchor, form, future, pred, formMatches: formRows.length });
  }
  void strengths;

  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const rms = (a: number[]) => Math.sqrt(mean(a.map((x) => x * x)));
  const WS = [0, 4, 8, 12, 16, 24, 48, 1e9];

  const groups: [string, P[]][] = [
    [`ROSE (form >= ${RISE}x anchor)`, out.filter((p) => p.form / p.anchor >= RISE)],
    ["STABLE", out.filter((p) => p.form / p.anchor < RISE && p.form / p.anchor > FALL)],
    [`FELL (form <= ${FALL.toFixed(2)}x anchor)`, out.filter((p) => p.form / p.anchor <= FALL)],
  ];
  const movers = out.filter((p) => p.form / p.anchor >= RISE || p.form / p.anchor <= FALL);
  if (!quiet) {
  console.log("\n" + "=".repeat(112));
  console.log(`DID THE LEVEL REALLY CHANGE? anchor 1-${anchorThrough}, form observed over the next ${OBSERVE} matches,`);
  console.log(`scored against each player's ACTUAL rate over the rest of the season. One row per player, n=${out.length}.`);
  console.log("=".repeat(112));


  console.log("\nWHERE DID THE FUTURE ACTUALLY LAND? (xGI per 90)");
  console.log("  NOTE: a 1.5x threshold is easier to cross from a low anchor, so ROSE carries more noise");
  console.log("  than FELL by construction. FELL is the cleaner group; prefer it when the two disagree.");
  console.log("group                          n    anchor     form    FUTURE   future sits at");
  console.log("-".repeat(112));
  for (const [name, list] of groups) {
    if (!list.length) continue;
    const a = mean(list.map((p) => p.anchor)), f = mean(list.map((p) => p.form)), u = mean(list.map((p) => p.future));
    // Meaningless when the two signals barely differ - the ratio divides by that gap.
    const gap = f - a;
    const pos = Math.abs(gap) < 0.05 * a ? undefined : (u - a) / gap;
    console.log(`${name.padEnd(30)} ${String(list.length).padStart(3)}    ${a.toFixed(3)}    ${f.toFixed(3)}    ${u.toFixed(3)}   `
      + (pos === undefined ? "(anchor and form agree; ratio not meaningful)" : `${(pos * 100).toFixed(0)}% of the way from anchor to form`));
  }

  console.log("\nBIAS in predicted xGI/90 (predicted - actual future). Negative = under-projecting.");
  console.log("group                          " + WS.map((w) => label(w).padStart(12)).join(""));
  console.log("-".repeat(112));
  for (const [name, list] of groups) {
    if (!list.length) continue;
    console.log(`${name.padEnd(30)} ` + WS.map((w) => {
      const b = mean(list.map((p) => p.pred.get(w)! - p.future));
      return `${b >= 0 ? "+" : ""}${b.toFixed(3)}`.padStart(12);
    }).join(""));
  }

  console.log("\nRMSE against the actual rest-of-season rate");
  console.log("group                          " + WS.map((w) => label(w).padStart(12)).join(""));
  console.log("-".repeat(112));
  for (const [name, list] of groups.concat([["ALL", out]])) {
    if (!list.length) continue;
    const cells = WS.map((w) => rms(list.map((p) => p.pred.get(w)! - p.future)));
    const best = Math.min(...cells);
    console.log(`${name.padEnd(30)} ` + cells.map((c) => `${c.toFixed(4)}${c === best ? "*" : " "}`.padStart(12)).join("")
      + `   best ${label(WS[cells.indexOf(best)])}`);
  }

  console.log(`\n${movers.length} of ${out.length} players (${(movers.length / out.length * 100).toFixed(0)}%) moved by more than 1.5x in either direction.`);
  const worst = movers.map((p) => ({ ...p, miss: p.pred.get(24)! - p.future })).sort((a, b) => a.miss - b.miss);
  console.log("\nbiggest under-projections at the shipped weight of 24 (xGI/90):");
  for (const p of worst.slice(0, 6)) {
    console.log(`  ${p.name.padEnd(30)} ${p.position}  anchor ${p.anchor.toFixed(3)}  form ${p.form.toFixed(3)}  future ${p.future.toFixed(3)}`
      + `  predicted ${p.pred.get(24)!.toFixed(3)}  miss ${p.miss.toFixed(3)}`);
  }
  }
  const pick = (list: P[]) => { const c = WS.map((w) => rms(list.map((q) => q.pred.get(w)! - q.future))); return WS[c.indexOf(Math.min(...c))]; };
  return {
    obs: OBSERVE, bestAll: pick(out), bestMovers: pick(movers), n: out.length,
    biasRose: mean(groups[0][1].map((q) => q.pred.get(24)! - q.future)),
    biasFell: mean(groups[2][1].map((q) => q.pred.get(24)! - q.future)),
    allShipped: rms(out.map((q) => q.pred.get(24)! - q.future)),
    allProposed: rms(out.map((q) => q.pred.get(-1)! - q.future)),
    movShipped: rms(movers.map((q) => q.pred.get(24)! - q.future)),
    movProposed: rms(movers.map((q) => q.pred.get(-1)! - q.future)),
    biasRoseProposed: mean(groups[0][1].map((q) => q.pred.get(-1)! - q.future)),
    biasFellProposed: mean(groups[2][1].map((q) => q.pred.get(-1)! - q.future)),
  };
}

/** Scores one concrete fix: keep the anchor at 24, stop capping the form side. */
function adaptiveArm(season: Season, anchorThrough: number): void {
  console.log("\n" + "=".repeat(112));
  console.log("ONE CONCRETE FIX: decay 1.0 (form weight grows with matches played) against the shipped decay 0.9");
  console.log("anchor weight stays 24 in both. RMSE and bias against the actual rest-of-season rate.");
  console.log("=".repeat(112));
  console.log("form matches        ALL players                      MOVERS (>1.5x either way)");
  console.log("               shipped   proposed   delta      shipped   proposed   delta      signed bias, shipped -> proposed");
  console.log("                                                                                 risers            fallers");
  console.log("-".repeat(112));
  const saved = OBSERVE;
  for (const o of [4, 8, 12, 16]) {
    OBSERVE = o;
    const r = levelChange(season, anchorThrough, true);
    console.log(`${String(o).padEnd(14)} ${r.allShipped.toFixed(4)}     ${r.allProposed.toFixed(4)}  ${(r.allProposed - r.allShipped >= 0 ? "+" : "") + (r.allProposed - r.allShipped).toFixed(4)}`
      + `      ${r.movShipped.toFixed(4)}     ${r.movProposed.toFixed(4)}  ${(r.movProposed - r.movShipped >= 0 ? "+" : "") + (r.movProposed - r.movShipped).toFixed(4)}`
      + `   ${(r.biasRose >= 0 ? "+" : "") + r.biasRose.toFixed(3)}->${(r.biasRoseProposed >= 0 ? "+" : "") + r.biasRoseProposed.toFixed(3)}`
      + `   ${(r.biasFell >= 0 ? "+" : "") + r.biasFell.toFixed(3)}->${(r.biasFellProposed >= 0 ? "+" : "") + r.biasFellProposed.toFixed(3)}`);
  }
  OBSERVE = saved;
}

/** Does more accumulated form justify trusting form more? */
function evidenceScaling(season: Season, anchorThrough: number): void {
  console.log("\n" + "=".repeat(112));
  console.log("DOES THE RIGHT WEIGHT MOVE AS FORM ACCUMULATES?");
  console.log("form matches observed -> best prior weight, scored on actual rest-of-season rate");
  console.log("=".repeat(112));
  console.log("form matches   players   best weight (all)   best weight (movers)   bias at shipped 24: risers / fallers");
  console.log("-".repeat(112));
  const saved = OBSERVE;
  for (const o of [4, 6, 8, 12, 16]) {
    OBSERVE = o;
    const r = levelChange(season, anchorThrough, true);
    console.log(`${String(o).padEnd(14)} ${String(r.n).padStart(7)}   ${label(r.bestAll).padStart(17)}   ${label(r.bestMovers).padStart(20)}`
      + `   ${(r.biasRose >= 0 ? "+" : "") + r.biasRose.toFixed(3)} / ${(r.biasFell >= 0 ? "+" : "") + r.biasFell.toFixed(3)}`);
  }
  OBSERVE = saved;
}

function main(): void {
  const season = loadSeason();
  run(season, 12);
  run(season, 19);
  currentWeightSweep(season, 12);
  levelChange(season, 12);
  evidenceScaling(season, 12);
  adaptiveArm(season, 12);
  shareCurve(season, 12);
  shareCurve(season, 19);
}

main();

/**
 * What curve should the current season's weight follow?
 *
 * The sweeps above ask which fixed prior weight is best. This asks the question
 * directly: blend the anchor and the form average at an explicit share `s`, and
 * find the `s` that best predicts the player's actual rest-of-season rate, once
 * for each amount of form observed. That traces the optimal curve rather than
 * inferring it from a shrinkage parameter.
 *
 * The share is the operative quantity. blendPlayerRate reaches it only through
 * decay and prior weight together, which is why no single constant can trace a
 * curve at all: with decay 0.9 the form side asymptotes at 10 effective matches,
 * so the share it implies stops rising at 29.4% however long the season runs.
 *
 * Run for two anchor lengths, because the optimal share depends on how good the
 * anchor is, and production's is longer than either.
 */
function shareCurve(season: Season, anchorThrough: number): void {
  const impliedShipped = (n: number) => {
    const ws = (1 - PLAYER_FORM_DECAY ** n) / (1 - PLAYER_FORM_DECAY);
    return ws / (PLAYER_FORM_PRIOR_WEIGHT_MATCHES + ws);
  };
  interface Obs { n: number; anchor: number; form: number; future: number; moved: boolean }

  /**
   * Players are bucketed by the number of matches they ACTUALLY played in the
   * window, not by the window's length - a player who appeared three times in a
   * sixteen-week window carries three matches of evidence, not sixteen.
   * Several window ends are pooled so each bucket has a usable sample.
   */
  const collect = (at: number): Obs[] => {
    const out: Obs[] = [];
    for (const [playerId, all] of season.rowsByPlayer) {
      const formRows = all.filter((r) => r.gameweek > anchorThrough && r.gameweek <= at && r.minutes > 0);
      const futureRows = all.filter((r) => r.gameweek > at && r.minutes > 0);
      if (formRows.length < 2) continue;
      const futureMinutes = futureRows.reduce((s, r) => s + r.minutes, 0);
      if (futureRows.length < MIN_FUTURE_MATCHES || futureMinutes < MIN_FUTURE_MINUTES) continue;
      const fx = (season.fixturesByGameweek.get(at + 1) ?? [])[0];
      if (!fx) continue;
      const player = playerAt(season, playerId, at + 1, fx, true, anchorThrough);
      const h = player?.historical;
      if (!h?.expectedGoals || !h.minutes) continue;
      const anchor = (((h.expectedGoals ?? 0) + (h.expectedAssists ?? 0)) / h.minutes) * 90;
      if (anchor <= 0.02) continue;
      let wsum = 0, acc = 0;
      formRows.forEach((r, i) => {
        const w = PLAYER_FORM_DECAY ** (formRows.length - 1 - i);
        wsum += w; acc += w * (((r.expectedGoals ?? 0) + (r.expectedAssists ?? 0)) / r.minutes) * 90;
      });
      const form = acc / wsum;
      const future = (futureRows.reduce((s, r) => s + (r.expectedGoals ?? 0) + (r.expectedAssists ?? 0), 0) / futureMinutes) * 90;
      out.push({ n: formRows.length, anchor, form, future, moved: form / anchor >= RISE || form / anchor <= FALL });
    }
    return out;
  };

  const pooled: Obs[] = [];
  for (const at of [anchorThrough + 6, anchorThrough + 10, anchorThrough + 14, anchorThrough + 18]) {
    if (at + MIN_FUTURE_MATCHES <= 38) pooled.push(...collect(at));
  }
  const rms = (a: number[]) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / Math.max(a.length, 1));
  const score = (list: readonly Obs[], s: number) => rms(list.map((o) => o.anchor * (1 - s) + o.form * s - o.future));
  const bestShare = (list: readonly Obs[]) => {
    let best = 0, bestE = Infinity;
    for (let s = 0; s <= 1.0001; s += 0.05) { const e = score(list, s); if (e < bestE) { best = s; bestE = e; } }
    return best;
  };

  /**
   * The optimal share in closed form: minimising sum (anchor + s(form-anchor) - future)^2
   * gives s = sum d*(future-anchor) / sum d^2 with d = form - anchor. Reported
   * beside the grid search because the two disagreeing would mean a heavy tail
   * is driving the answer, and beside a 5%-trimmed version that shows whether
   * it is.
   */
  const olsShare = (list: readonly Obs[], trim = 0): number => {
    let rows = list.map((o) => ({ d: o.form - o.anchor, y: o.future - o.anchor }));
    if (trim > 0) {
      const cut = Math.floor(rows.length * trim);
      rows = [...rows].sort((a, b) => Math.abs(a.d) - Math.abs(b.d)).slice(0, rows.length - cut);
    }
    const num = rows.reduce((s2, r) => s2 + r.d * r.y, 0);
    const den = rows.reduce((s2, r) => s2 + r.d * r.d, 0);
    return den === 0 ? NaN : num / den;
  };

  const BINS: [number, number][] = [[2, 3], [4, 5], [6, 8], [9, 12], [13, 25]];
  console.log("\n" + "=".repeat(112));
  console.log(`OPTIMAL CURRENT-SEASON SHARE by matches actually played, anchor = gameweeks 1-${anchorThrough}`);
  console.log("=".repeat(112));
  console.log("matches      players   OPTIMAL SHARE (grid)   OPTIMAL SHARE (closed form)   shipped   linear");
  console.log("played                 all      movers         all    trimmed 5%             blend     to 100%");
  console.log("-".repeat(112));
  const bins: { mid: number; all: number; trimmed: number; list: Obs[] }[] = [];
  for (const [lo, hi] of BINS) {
    const list = pooled.filter((o) => o.n >= lo && o.n <= hi);
    if (list.length < 40) continue;
    const movers = list.filter((o) => o.moved);
    const mid = list.reduce((s, o) => s + o.n, 0) / list.length;
    const a = bestShare(list), m = movers.length >= 30 ? bestShare(movers) : NaN;
    bins.push({ mid, all: a, trimmed: olsShare(list, 0.05), list });
    console.log(`${`${lo}-${hi}`.padEnd(12)} ${String(list.length).padStart(7)}   ${(a * 100).toFixed(0).padStart(4)}%   ${(m * 100).toFixed(0).padStart(9)}%`
      + `   ${(olsShare(list) * 100).toFixed(0).padStart(9)}%   ${(olsShare(list, 0.05) * 100).toFixed(0).padStart(9)}%`
      + `        ${(impliedShipped(mid) * 100).toFixed(0).padStart(5)}%   ${(Math.min(1, mid / 37) * 100).toFixed(0).padStart(6)}%`);
  }

  const fitK = (pick: (b: { mid: number; all: number; trimmed: number }) => number) => {
    let bk = 1, be = Infinity;
    for (let k = 0.5; k <= 200; k += 0.5) {
      const e = bins.reduce((s2, b) => s2 + (b.mid / (b.mid + k) - pick(b)) ** 2, 0);
      if (e < be) { be = e; bk = k; }
    }
    return bk;
  };
  const bestK = fitK((b) => b.all);
  const trimK = fitK((b) => b.trimmed);
  const anchorMatches = anchorThrough === 12 ? 7.1 : 10.8;
  console.log(`\nbest fit to s = n / (n + k):  k = ${bestK.toFixed(1)}   (= ${(bestK / anchorMatches).toFixed(2)} x the ${anchorMatches}-match anchor)`);
  console.log("  fitted: " + bins.map((b) => `n=${b.mid.toFixed(0)}: ${((b.mid / (b.mid + bestK)) * 100).toFixed(0)}%`).join("   "));
  console.log(`fit to the TRIMMED shares:   k = ${trimK.toFixed(1)}   (= ${(trimK / anchorMatches).toFixed(2)} x the ${anchorMatches}-match anchor)`);
  console.log("  fitted: " + bins.map((b) => `n=${b.mid.toFixed(0)}: ${((b.mid / (b.mid + trimK)) * 100).toFixed(0)}%`).join("   "));

  const rules: [string, (n: number) => number][] = [
    ["shipped blend (asymptotes at 29%)", impliedShipped],
    ["linear to 100% by 38 matches", (n) => Math.min(1, n / 37)],
    [`fitted n/(n+${bestK.toFixed(1)})`, (n) => n / (n + bestK)],
    ["flat 50%", () => 0.5],
  ];
  // Winsorising the form ratio is what separates the two answers above: the
  // untrimmed optimum is near zero only because a handful of extreme
  // divergences dominate a sum of squares, and those revert hardest.
  const WINSOR = 2.5;
  const wins = (o: Obs) => Math.min(Math.max(o.form, o.anchor / WINSOR), o.anchor * WINSOR);
  console.log("\npooled RMSE against actual rest-of-season rate");
  console.log("rule                                         all players     movers");
  console.log("-".repeat(112));
  const report = (name: string, predict: (o: Obs) => number) => {
    const all: number[] = [], mov: number[] = [];
    for (const o of pooled) { const e = predict(o) - o.future; all.push(e); if (o.moved) mov.push(e); }
    console.log(`${name.padEnd(44)} ${rms(all).toFixed(4)}      ${rms(mov).toFixed(4)}`);
  };
  for (const [name, f] of rules) report(name, (o) => o.anchor * (1 - f(o.n)) + o.form * f(o.n));
  report(`winsorised form + n/(n+${trimK.toFixed(0)})`,
    (o) => { const sh = o.n / (o.n + trimK); return o.anchor * (1 - sh) + wins(o) * sh; });
  report(`winsorised form + linear to 100%`,
    (o) => { const sh = Math.min(1, o.n / 37); return o.anchor * (1 - sh) + wins(o) * sh; });
  report("winsorised form, shipped share", (o) => {
    const sh = impliedShipped(o.n); return o.anchor * (1 - sh) + wins(o) * sh;
  });
}
