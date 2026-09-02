/**
 * Multi-season walk-forward backtest of flaw solutions.
 * Run once per season:
 *   BACKTEST_DATA_DIR=/tmp/fpl-backtest-seasons/2023-24 npx tsx scripts/backtest/test-candidates.ts 2023-24
 *   BACKTEST_DATA_DIR=/tmp/fpl-backtest-seasons/2024-25 npx tsx scripts/backtest/test-candidates.ts 2024-25
 *   BACKTEST_DATA_DIR=/tmp/fpl-backtest-seasons/2025-26 npx tsx scripts/backtest/test-candidates.ts 2025-26
 */
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";
import { blendStartRate, MINUTES_FOR_START, type StartObservation } from "@/lib/availability/startRate";

const label = process.argv[2] ?? process.env.BACKTEST_DATA_DIR ?? "season";

function brier(preds: readonly number[], actuals: readonly number[]): number {
  return preds.reduce((sum, p, i) => sum + (p - actuals[i]) ** 2, 0) / preds.length;
}

function logLoss(preds: readonly number[], actuals: readonly number[]): number {
  return -preds.reduce((sum, raw, i) => {
    const p = Math.min(Math.max(raw, 1e-6), 1 - 1e-6);
    return sum + (actuals[i] === 1 ? Math.log(p) : Math.log(1 - p));
  }, 0) / preds.length;
}

function rmse(preds: readonly number[], actuals: readonly number[]): number {
  return Math.sqrt(preds.reduce((sum, p, i) => sum + (p - actuals[i]) ** 2, 0) / preds.length);
}

function mean(vals: readonly number[]): number {
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ---------------------------------------------------------------------------
// EXPERIMENT 1: Start Rate EWMA & Layoff Dampening
// ---------------------------------------------------------------------------
function blendStartRateLayoffDampened(
  seed: number,
  observations: readonly StartObservation[],
  alpha: number = 0.4,
): number {
  let rate = Math.min(Math.max(seed, 0), 1);
  let consecutiveZeros = 0;
  for (const obs of observations) {
    if (obs.started) {
      consecutiveZeros = 0;
      rate = rate * (1 - alpha) + 1 * alpha;
    } else if (obs.appeared) {
      consecutiveZeros = 0;
      rate = rate * (1 - alpha);
    } else {
      consecutiveZeros += 1;
      if (consecutiveZeros === 1) {
        rate = rate * (1 - alpha);
      } else {
        // Layoff / injury: gentle decay rather than exponential role-loss
        rate = rate * 0.92;
      }
    }
  }
  return rate;
}

interface StartObs {
  seed: number;
  history: StartObservation[];
  actual: number;
  isReturnAfterLayoff: boolean;
}

function evaluateStartRates(season: Season, anchorThrough = 10) {
  const allObs: StartObs[] = [];
  for (const rows of season.rowsByPlayer.values()) {
    const sorted = [...rows].sort((a, b) => a.gameweek - b.gameweek);
    const anchor = sorted.filter((r) => r.gameweek <= anchorThrough);
    if (anchor.length < 3) continue;
    const seed = anchor.filter((r) => r.minutes >= MINUTES_FOR_START).length / anchor.length;
    const history: StartObservation[] = [];
    let consecutiveZeros = 0;

    for (const row of sorted) {
      if (row.gameweek > anchorThrough) {
        const isReturn = consecutiveZeros >= 2;
        allObs.push({
          seed,
          history: [...history],
          actual: row.minutes >= MINUTES_FOR_START ? 1 : 0,
          isReturnAfterLayoff: isReturn,
        });
      }
      const started = row.minutes >= MINUTES_FOR_START;
      const appeared = row.minutes > 0;
      history.push({ started, appeared });
      if (!appeared) consecutiveZeros += 1;
      else consecutiveZeros = 0;
    }
  }

  const actualsAll = allObs.map((o) => o.actual);
  const pShippedAll = allObs.map((o) => blendStartRate(o.seed, o.history, 0.6));
  const pAlpha40All = allObs.map((o) => blendStartRate(o.seed, o.history, 0.4));
  const pDampenedAll = allObs.map((o) => blendStartRateLayoffDampened(o.seed, o.history, 0.4));

  const layoffObs = allObs.filter((o) => o.isReturnAfterLayoff);
  const actualsLayoff = layoffObs.map((o) => o.actual);
  const pShippedLayoff = layoffObs.map((o) => blendStartRate(o.seed, o.history, 0.6));
  const pAlpha40Layoff = layoffObs.map((o) => blendStartRate(o.seed, o.history, 0.4));
  const pDampenedLayoff = layoffObs.map((o) => blendStartRateLayoffDampened(o.seed, o.history, 0.4));

  return {
    countAll: allObs.length,
    brierShipped: brier(pShippedAll, actualsAll),
    loglossShipped: logLoss(pShippedAll, actualsAll),
    brierAlpha40: brier(pAlpha40All, actualsAll),
    loglossAlpha40: logLoss(pAlpha40All, actualsAll),
    brierDampened: brier(pDampenedAll, actualsAll),
    loglossDampened: logLoss(pDampenedAll, actualsAll),

    countLayoff: layoffObs.length,
    brierShippedLayoff: brier(pShippedLayoff, actualsLayoff),
    loglossShippedLayoff: logLoss(pShippedLayoff, actualsLayoff),
    brierAlpha40Layoff: brier(pAlpha40Layoff, actualsLayoff),
    loglossAlpha40Layoff: logLoss(pAlpha40Layoff, actualsLayoff),
    brierDampenedLayoff: brier(pDampenedLayoff, actualsLayoff),
    loglossDampenedLayoff: logLoss(pDampenedLayoff, actualsLayoff),
  };
}

// ---------------------------------------------------------------------------
// EXPERIMENT 2: Clean Sheet Duration & Sub Adjustments (60-85 mins)
// ---------------------------------------------------------------------------
interface SubbedDefenderRow {
  minutes: number;
  cleanSheetActual: number;
  pCS90: number;
  pCSMinutes: number;
}

function evaluateCleanSheetSubRule(season: Season) {
  const rows: SubbedDefenderRow[] = [];
  for (let gw = 6; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const fixtureById = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    for (const row of season.rowsByGameweek.get(gw) ?? []) {
      if (row.minutes < 60 || row.minutes > 85) continue;
      const player = season.players.get(row.historicalPlayerId);
      if (!player || (player.position !== "DEF" && player.position !== "GK")) continue;
      const fixture = fixtureById.get(row.fixtureId);
      if (!fixture) continue;
      const pPlayer = playerAt(season, row.historicalPlayerId, gw, fixture, row.wasHome);
      if (!pPlayer) continue;
      const rates = playerRates(pPlayer, formBefore(season, row.historicalPlayerId, gw), gw);

      const comp = expectedPoints(pPlayer, pPlayer.fixtures[0], row.minutes, rates, strengths, BASELINE, true);
      const pCS90 = comp.cleanSheets / 4;
      const pCSMinutes = Math.pow(Math.max(pCS90, 0.01), row.minutes / 90);

      const pointsExCS = 2 + (row.goals ?? 0) * 6 + (row.assists ?? 0) * 3 + (row.bonus ?? 0);
      const earnedCS = (row.totalPoints - pointsExCS) >= 3 ? 1 : 0;

      rows.push({
        minutes: row.minutes,
        cleanSheetActual: earnedCS,
        pCS90,
        pCSMinutes,
      });
    }
  }

  const actuals = rows.map((r) => r.cleanSheetActual);
  const p90 = rows.map((r) => r.pCS90);
  const pMin = rows.map((r) => r.pCSMinutes);

  return {
    count: rows.length,
    actualMean: mean(actuals),
    p90Mean: mean(p90),
    pMinMean: mean(pMin),
    brierP90: brier(p90, actuals),
    loglossP90: logLoss(p90, actuals),
    brierPMin: brier(pMin, actuals),
    loglossPMin: logLoss(pMin, actuals),
  };
}

// ---------------------------------------------------------------------------
// EXPERIMENT 3: Defender Bonus Point Environment
// ---------------------------------------------------------------------------
function evaluateDefenderBonus(season: Season) {
  interface BonusRow {
    actualBonus: number;
    predShipped: number;
    predDefEnv: number;
    predFlat: number;
  }
  const rows: BonusRow[] = [];
  for (let gw = 6; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const fixtureById = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    for (const row of season.rowsByGameweek.get(gw) ?? []) {
      if (row.minutes <= 0) continue;
      const player = season.players.get(row.historicalPlayerId);
      if (!player || (player.position !== "DEF" && player.position !== "GK")) continue;
      const fixture = fixtureById.get(row.fixtureId);
      if (!fixture) continue;
      const pPlayer = playerAt(season, row.historicalPlayerId, gw, fixture, row.wasHome);
      if (!pPlayer) continue;
      const rates = playerRates(pPlayer, formBefore(season, row.historicalPlayerId, gw), gw);

      const shippedComp = expectedPoints(pPlayer, pPlayer.fixtures[0], row.minutes, rates, strengths, BASELINE, true);
      const defEnvComp = expectedPoints(pPlayer, pPlayer.fixtures[0], row.minutes, rates, strengths, BASELINE, true, true, undefined, undefined, { bonusEnvironment: "DEFENCE" });
      const flatComp = expectedPoints(pPlayer, pPlayer.fixtures[0], row.minutes, rates, strengths, BASELINE, false);

      rows.push({
        actualBonus: row.bonus,
        predShipped: shippedComp.bonus,
        predDefEnv: defEnvComp.bonus,
        predFlat: flatComp.bonus,
      });
    }
  }

  const actuals = rows.map((r) => r.actualBonus);
  const shipped = rows.map((r) => r.predShipped);
  const defEnv = rows.map((r) => r.predDefEnv);
  const flat = rows.map((r) => r.predFlat);

  return {
    count: rows.length,
    actualMean: mean(actuals),
    shippedMean: mean(shipped),
    defEnvMean: mean(defEnv),
    flatMean: mean(flat),
    rmseShipped: rmse(shipped, actuals),
    rmseDefEnv: rmse(defEnv, actuals),
    rmseFlat: rmse(flat, actuals),
  };
}

// ---------------------------------------------------------------------------
// EXPERIMENT 4: Early Gameweek Prior Normalization (GW 1-5)
// ---------------------------------------------------------------------------
function evaluateEarlyGameweekPrior(season: Season) {
  interface EarlyRow {
    actualXg: number;
    predShipped: number;
    predNormalized: number;
    ownAttack: number;
  }
  const rows: EarlyRow[] = [];
  for (let gw = 1; gw <= 5; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const fixtureById = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    for (const row of season.rowsByGameweek.get(gw) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = fixtureById.get(row.fixtureId);
      if (!fixture) continue;
      const pPlayer = playerAt(season, row.historicalPlayerId, gw, fixture, row.wasHome);
      if (!pPlayer || (pPlayer.position !== "MID" && pPlayer.position !== "FWD")) continue;
      const rates = playerRates(pPlayer, formBefore(season, row.historicalPlayerId, gw), gw);
      const ownTeam = strengths[pPlayer.teamId];
      if (!ownTeam) continue;
      const ownAttack = (ownTeam.attackHome + ownTeam.attackAway) / 2;

      // Shipped: basePrior is used as rates.xg, multiplied by attackMultiplier downstream
      const shippedComp = expectedPoints(pPlayer, pPlayer.fixtures[0], row.minutes, rates, strengths, BASELINE, true);
      // Normalized: rates.xg is normalized by ownAttack before fixture multiplier
      const normRates = { ...rates, xg: ownAttack > 0 ? rates.xg / ownAttack : rates.xg };
      const normComp = expectedPoints(pPlayer, pPlayer.fixtures[0], row.minutes, normRates, strengths, BASELINE, true);

      rows.push({
        actualXg: (row.expectedGoals / row.minutes) * 90,
        predShipped: shippedComp.goals / (row.minutes / 90) / 5, // approx per-90 xG
        predNormalized: normComp.goals / (row.minutes / 90) / 5,
        ownAttack,
      });
    }
  }

  // Split by top attacking teams (ownAttack >= 1.05)
  const topRows = rows.filter((r) => r.ownAttack >= 1.05);

  return {
    allCount: rows.length,
    allActualMean: mean(rows.map((r) => r.actualXg)),
    allShippedMean: mean(rows.map((r) => r.predShipped)),
    allNormMean: mean(rows.map((r) => r.predNormalized)),
    allRmseShipped: rmse(rows.map((r) => r.predShipped), rows.map((r) => r.actualXg)),
    allRmseNorm: rmse(rows.map((r) => r.predNormalized), rows.map((r) => r.actualXg)),

    topCount: topRows.length,
    topActualMean: mean(topRows.map((r) => r.actualXg)),
    topShippedMean: mean(topRows.map((r) => r.predShipped)),
    topNormMean: mean(topRows.map((r) => r.predNormalized)),
    topRmseShipped: rmse(topRows.map((r) => r.predShipped), topRows.map((r) => r.actualXg)),
    topRmseNorm: rmse(topRows.map((r) => r.predNormalized), topRows.map((r) => r.actualXg)),
  };
}

async function main() {
  const season = loadSeason();

  console.log(`================================================================================`);
  console.log(`BACKTEST RESULTS FOR SEASON: ${label}`);
  console.log(`================================================================================\n`);

  // 1. Start Rate Test
  const sr = evaluateStartRates(season, 10);
  console.log(`[EXPERIMENT 1] Start-Rate EWMA Updating (n = ${sr.countAll} player-weeks)`);
  console.log(`  ALL ROWS:`);
  console.log(`    Shipped (alpha=0.60):           Brier = ${sr.brierShipped.toFixed(4)}  |  LogLoss = ${sr.loglossShipped.toFixed(4)}`);
  console.log(`    Alpha 0.40:                     Brier = ${sr.brierAlpha40.toFixed(4)}  |  LogLoss = ${sr.loglossAlpha40.toFixed(4)}`);
  console.log(`    Layoff-Dampened (injury freeze): Brier = ${sr.brierDampened.toFixed(4)}  |  LogLoss = ${sr.loglossDampened.toFixed(4)}`);

  console.log(`  RETURNING FROM 2+ MATCH LAYOFF (n = ${sr.countLayoff}):`);
  console.log(`    Shipped (alpha=0.60):           Brier = ${sr.brierShippedLayoff.toFixed(4)}  |  LogLoss = ${sr.loglossShippedLayoff.toFixed(4)}`);
  console.log(`    Alpha 0.40:                     Brier = ${sr.brierAlpha40Layoff.toFixed(4)}  |  LogLoss = ${sr.loglossAlpha40Layoff.toFixed(4)}`);
  console.log(`    Layoff-Dampened (injury freeze): Brier = ${sr.brierDampenedLayoff.toFixed(4)}  |  LogLoss = ${sr.loglossDampenedLayoff.toFixed(4)}`);

  // 2. Clean Sheet Sub Test
  const cs = evaluateCleanSheetSubRule(season);
  console.log(`\n[EXPERIMENT 2] Clean Sheet Sub Rule (60-85m subs, n = ${cs.count})`);
  console.log(`  Actual Clean Sheet Rate:          ${(cs.actualMean * 100).toFixed(1)}%`);
  console.log(`  Shipped Flat P(CS_90) Mean:       ${(cs.p90Mean * 100).toFixed(1)}%   |  Brier = ${cs.brierP90.toFixed(4)}  |  LogLoss = ${cs.loglossP90.toFixed(4)}`);
  console.log(`  On-Pitch P(CS_90)^(m/90) Mean:    ${(cs.pMinMean * 100).toFixed(1)}%   |  Brier = ${cs.brierPMin.toFixed(4)}  |  LogLoss = ${cs.loglossPMin.toFixed(4)}`);

  // 3. Defender Bonus Test
  const bn = evaluateDefenderBonus(season);
  console.log(`\n[EXPERIMENT 3] GK/DEF Bonus Point Scaling (n = ${bn.count})`);
  console.log(`  Actual Mean Bonus:                ${bn.actualMean.toFixed(3)}`);
  console.log(`  Shipped (attackMultiplier):       ${bn.shippedMean.toFixed(3)}  |  RMSE = ${bn.rmseShipped.toFixed(4)}`);
  console.log(`  Defensive Environment:            ${bn.defEnvMean.toFixed(3)}  |  RMSE = ${bn.rmseDefEnv.toFixed(4)}`);
  console.log(`  Flat (No Fixture Multiplier):     ${bn.flatMean.toFixed(3)}  |  RMSE = ${bn.rmseFlat.toFixed(4)}`);

  // 4. Early Gameweek Prior Normalization
  const eg = evaluateEarlyGameweekPrior(season);
  console.log(`\n[EXPERIMENT 4] Early Gameweek (GW 1-5) Prior Normalization on Attackers`);
  console.log(`  Top Attacking Teams (ownAttack >= 1.05, n = ${eg.topCount}):`);
  console.log(`    Actual Mean xG/90:              ${eg.topActualMean.toFixed(3)}`);
  console.log(`    Shipped (Double-Counted):       ${eg.topShippedMean.toFixed(3)}  |  RMSE = ${eg.topRmseShipped.toFixed(4)}`);
  console.log(`    Normalized (Divided by own):    ${eg.topNormMean.toFixed(3)}  |  RMSE = ${eg.topRmseNorm.toFixed(4)}`);
}

main().catch(console.error);
