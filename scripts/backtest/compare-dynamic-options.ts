/**
 * Rigorous walk-forward backtest comparing the three proposed dynamic multiplier options:
 *
 * 1. Continuous clean sheet model:
 *    - Arm 1A: 2D bilinear interpolation of the calibrated 5x5 table
 *    - Arm 1B: Poisson continuous goals-conceded model P(CS) = exp(-lambda)
 *
 * 2. Schedule-adjusted in-season team xG:
 *    - Normalizing past match xG by the opponent's defensive/attacking strength before
 *      blending into in-season team strength, so easy/hard schedules do not distort team ratings.
 *
 * 3. Dynamic / blended FDR base:
 *    - Arm 3A: Regressing FPL static base toward in-season opponent strength:
 *              base_dyn = base_FPL * (1 - w_n) + base_inSeason * w_n, w_n = n / (n + 12)
 *    - Arm 3B: Dynamic weekly FDR tiering (ranking teams by in-season defence into 5 tiers)
 *    - Arm 3C: Fully dropping FPL base (base = 1.0), relying 100% on in-season strength ratio
 *
 * 4. Combinations of the best-performing arms.
 *
 * Metrics evaluated:
 * - Overall player-level xP RMSE, paired 95% bootstrap CI over gameweek clusters, GW win rate
 * - Positional xP splits: GK/DEF (defensive accuracy) vs MID/FWD (attacking accuracy)
 * - Team-level clean sheet Brier score and log-loss (660 team-fixtures)
 * - Team-level match xG RMSE against actual outcome
 */
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE, adjust, type Variant } from "./variants";
import { applyInSeasonForm, type TeamMatchXG } from "@/lib/historical/inSeasonForm";
import type { TeamStrength } from "@/types/projection";

const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 4000;
const season = loadSeason();

const difficultyMultiplier: Record<number, number> = { 1: 1.14, 2: 1.07, 3: 1, 4: 0.92, 5: 0.84 };

// Helper math
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rmse = (xs: number[]) => Math.sqrt(mean(xs.map((x) => x * x)));
const brier = (preds: number[], actuals: number[]) => mean(preds.map((p, i) => (p - actuals[i]) ** 2));
const logloss = (preds: number[], actuals: number[]) =>
  -mean(actuals.map((y, i) => (y ? Math.log(Math.max(preds[i], 1e-6)) : Math.log(Math.max(1 - preds[i], 1e-6)))));

// ---------------------------------------------------------------------------
// Schedule-Adjusted Team Strengths
// ---------------------------------------------------------------------------
function scheduleAdjustedStrengthsBefore(season: Season, gameweek: number): Record<number, TeamStrength> {
  const priors = season.priorStrengths;
  const history: Record<number, TeamMatchXG[]> = {};
  const push = (teamId: number, xgFor: number, xgAgainst: number) => {
    (history[teamId] ??= []).push({ xgFor, xgAgainst });
  };

  for (const fixture of season.fixtures) {
    if (fixture.gameweek >= gameweek) continue;
    const homePrior = priors[fixture.homeTeamId];
    const awayPrior = priors[fixture.awayTeamId];
    if (!homePrior || !awayPrior) {
      push(fixture.homeTeamId, fixture.homeXg, fixture.awayXg);
      push(fixture.awayTeamId, fixture.awayXg, fixture.homeXg);
      continue;
    }

    // Normalize match xG by opponent strength
    // Home team attacked away team: normalize by away defence
    const homeAttackAdj = fixture.homeXg / Math.max(awayPrior.defenceAway, 0.2);
    // Away team attacked home team: normalize by home defence
    const awayAttackAdj = fixture.awayXg / Math.max(homePrior.defenceHome, 0.2);

    push(fixture.homeTeamId, homeAttackAdj, awayAttackAdj);
    push(fixture.awayTeamId, awayAttackAdj, homeAttackAdj);
  }

  return applyInSeasonForm(priors, history);
}

// ---------------------------------------------------------------------------
// Dynamic FDR Base Generators
// ---------------------------------------------------------------------------
function getDynamicBaseBlend(
  fplBase: number,
  oppDefence: number,
  matchesPlayed: number,
  k = 12,
): number {
  const wn = matchesPlayed / (matchesPlayed + k);
  // Continuous base from opponent defence: oppDefence > 1 means tough defence (base < 1)
  const inSeasonBase = Math.min(1.20, Math.max(0.80, 1 / oppDefence));
  return fplBase * (1 - wn) + inSeasonBase * wn;
}

function getDynamicTierBase(
  allStrengths: Record<number, TeamStrength>,
  oppTeamId: number,
  isHome: boolean,
): number {
  const opp = allStrengths[oppTeamId];
  if (!opp) return 1.0;
  const def = isHome ? opp.defenceAway : opp.defenceHome;
  // Rank all teams by defence
  const allDefs = Object.values(allStrengths).map((s) => (isHome ? s.defenceAway : s.defenceHome)).sort((a, b) => a - b);
  const rank = allDefs.findIndex((d) => d >= def);
  const tier = Math.min(5, Math.max(1, Math.floor(rank / 4) + 1));
  return difficultyMultiplier[tier] ?? 1.0;
}

// ---------------------------------------------------------------------------
// Backtest Execution
// ---------------------------------------------------------------------------
interface ArmConfig {
  name: string;
  category: "Baseline" | "Option 1 (Clean Sheets)" | "Option 2 (Schedule-Adjusted xG)" | "Option 3 (Dynamic FDR)" | "Combinations";
  cleanSheetMode: "TABLE" | "BILINEAR" | "POISSON";
  scheduleAdjustedTeamXG: boolean;
  baseMode: "STATIC_FPL" | "DROP_FPL" | "BLEND_FDR" | "DYNAMIC_TIER";
}

const ARMS: ArmConfig[] = [
  { name: "Baseline (Current Shipped)", category: "Baseline", cleanSheetMode: "TABLE", scheduleAdjustedTeamXG: false, baseMode: "STATIC_FPL" },

  // Option 1: Clean sheets
  { name: "1A: Bilinear 5x5 CS Table", category: "Option 1 (Clean Sheets)", cleanSheetMode: "BILINEAR", scheduleAdjustedTeamXG: false, baseMode: "STATIC_FPL" },
  { name: "1B: Continuous Poisson CS (lambda)", category: "Option 1 (Clean Sheets)", cleanSheetMode: "POISSON", scheduleAdjustedTeamXG: false, baseMode: "STATIC_FPL" },

  // Option 2: Schedule-adjusted team xG
  { name: "2: Schedule-Adjusted Team xG", category: "Option 2 (Schedule-Adjusted xG)", cleanSheetMode: "TABLE", scheduleAdjustedTeamXG: true, baseMode: "STATIC_FPL" },

  // Option 3: Dynamic FDR
  { name: "3A: Blended FDR (FPL + In-Season w=n/(n+12))", category: "Option 3 (Dynamic FDR)", cleanSheetMode: "TABLE", scheduleAdjustedTeamXG: false, baseMode: "BLEND_FDR" },
  { name: "3B: Dynamic In-Season Tier Base (1-5 rank)", category: "Option 3 (Dynamic FDR)", cleanSheetMode: "TABLE", scheduleAdjustedTeamXG: false, baseMode: "DYNAMIC_TIER" },
  { name: "3C: Drop FPL FDR (Base = 1.0)", category: "Option 3 (Dynamic FDR)", cleanSheetMode: "TABLE", scheduleAdjustedTeamXG: false, baseMode: "DROP_FPL" },

  // Combinations
  { name: "Comb: 1A Bilinear + 2 SchedAdj", category: "Combinations", cleanSheetMode: "BILINEAR", scheduleAdjustedTeamXG: true, baseMode: "STATIC_FPL" },
  { name: "Comb: 1A Bilinear + 3A Blended FDR", category: "Combinations", cleanSheetMode: "BILINEAR", scheduleAdjustedTeamXG: false, baseMode: "BLEND_FDR" },
  { name: "Comb: 2 SchedAdj + 3A Blended FDR", category: "Combinations", cleanSheetMode: "TABLE", scheduleAdjustedTeamXG: true, baseMode: "BLEND_FDR" },
  { name: "All: 1A Bilinear + 2 SchedAdj + 3A Blended FDR", category: "Combinations", cleanSheetMode: "BILINEAR", scheduleAdjustedTeamXG: true, baseMode: "BLEND_FDR" },
];

interface PlayerRow {
  gameweek: number;
  position: string;
  actual: number;
  preds: number[];
}

interface TeamFixtureRow {
  gameweek: number;
  actualCleanSheet: number;
  actualGoalsConceded: number;
  actualXgFor: number;
  csPreds: number[];
  xgPreds: number[];
}

const playerRows: PlayerRow[] = [];
const teamRows: TeamFixtureRow[] = [];

console.log("Running walk-forward simulations across Gameweeks 6-38...");

for (let gw = FIRST_GAMEWEEK; gw <= 38; gw += 1) {
  const standardStrengths = strengthsBefore(season, gw);
  const schedAdjStrengths = scheduleAdjustedStrengthsBefore(season, gw);

  const fixtureById = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));

  // 1. Team-level fixtures
  for (const fx of season.fixturesByGameweek.get(gw) ?? []) {
    for (const isHome of [true, false]) {
      const ownId = isHome ? fx.homeTeamId : fx.awayTeamId;
      const oppId = isHome ? fx.awayTeamId : fx.homeTeamId;
      const rawDiff = isHome ? fx.homeDifficulty : fx.awayDifficulty;
      const fplDiff = rawDiff === undefined ? 3 : Math.min(5, Math.max(1, Math.round(rawDiff)));
      const fplBase = difficultyMultiplier[fplDiff] ?? 1.0;

      const actualGoals = isHome ? fx.awayGoals : fx.homeGoals;
      const actualCleanSheet = actualGoals === 0 ? 1 : 0;
      const actualXg = (isHome ? fx.homeXg : fx.awayXg) / season.leagueAverageXg;

      const csPreds: number[] = [];
      const xgPreds: number[] = [];

      for (const arm of ARMS) {
        const str = arm.scheduleAdjustedTeamXG ? schedAdjStrengths : standardStrengths;
        const own = str[ownId];
        const opp = str[oppId];
        if (!own || !opp) {
          csPreds.push(0.27);
          xgPreds.push(1.0);
          continue;
        }

        let base = fplBase;
        if (arm.baseMode === "DROP_FPL") {
          base = 1.0;
        } else if (arm.baseMode === "BLEND_FDR") {
          const oppDef = isHome ? opp.defenceAway : opp.defenceHome;
          base = getDynamicBaseBlend(fplBase, oppDef, gw - 1, 12);
        } else if (arm.baseMode === "DYNAMIC_TIER") {
          base = getDynamicTierBase(str, oppId, isHome);
        }

        const customVariant: Variant = {
          ...BASELINE,
          useDifficultyBase: arm.baseMode !== "DROP_FPL",
          cleanSheet: arm.cleanSheetMode,
        };

        const pf = { gameweek: gw, opponentTeamId: oppId, opponentShortName: "OPP", isHome, difficulty: fplDiff };
        const adj = adjust(pf, { ownTeam: own, opponentTeam: opp }, customVariant);

        let finalMultiplier = adj.attackMultiplier;
        if (arm.baseMode === "BLEND_FDR" || arm.baseMode === "DYNAMIC_TIER") {
          finalMultiplier = (adj.attackMultiplier / (fplBase || 1)) * base;
        }

        csPreds.push(adj.cleanSheetProbability);
        xgPreds.push(finalMultiplier);
      }

      teamRows.push({
        gameweek: gw,
        actualCleanSheet,
        actualGoalsConceded: actualGoals,
        actualXgFor: actualXg,
        csPreds,
        xgPreds,
      });
    }
  }

  // 2. Player-level rows
  for (const r of season.rowsByGameweek.get(gw) ?? []) {
    if (r.minutes <= 0) continue;
    const fx = fixtureById.get(r.fixtureId);
    if (!fx) continue;
    const player = playerAt(season, r.historicalPlayerId, gw, fx, r.wasHome);
    if (!player) continue;
    const rates = playerRates(player, formBefore(season, r.historicalPlayerId, gw), gw);
    const upcoming = player.fixtures[0];

    const preds = ARMS.map((arm) => {
      const str = arm.scheduleAdjustedTeamXG ? schedAdjStrengths : standardStrengths;
      const opp = str[upcoming.opponentTeamId];
      const rawDiff = upcoming.difficulty;
      const fplDiff = rawDiff === undefined ? 3 : Math.min(5, Math.max(1, Math.round(rawDiff)));
      const fplBase = difficultyMultiplier[fplDiff] ?? 1.0;

      let base = fplBase;
      if (arm.baseMode === "DROP_FPL") {
        base = 1.0;
      } else if (arm.baseMode === "BLEND_FDR") {
        const oppDef = upcoming.isHome ? opp?.defenceAway ?? 1 : opp?.defenceHome ?? 1;
        base = getDynamicBaseBlend(fplBase, oppDef, gw - 1, 12);
      } else if (arm.baseMode === "DYNAMIC_TIER") {
        base = getDynamicTierBase(str, upcoming.opponentTeamId, upcoming.isHome);
      }

      const customVariant: Variant = {
        ...BASELINE,
        useDifficultyBase: arm.baseMode !== "DROP_FPL",
        cleanSheet: arm.cleanSheetMode,
      };

      const pt = expectedPoints(
        player,
        upcoming,
        r.minutes,
        rates,
        str,
        customVariant,
        true,
      );

      if ((arm.baseMode === "BLEND_FDR" || arm.baseMode === "DYNAMIC_TIER") && fplBase > 0) {
        const factor = base / fplBase;
        const goalsAdj = pt.goals * factor;
        const assistsAdj = pt.assists * factor;
        const bonusAdj = pt.bonus * factor;
        return pt.appearance + goalsAdj + assistsAdj + pt.cleanSheets + pt.goalsConceded + pt.saves + pt.defensiveContribution + bonusAdj + pt.cards;
      }

      return pt.total;
    });

    playerRows.push({
      gameweek: gw,
      position: player.position,
      actual: r.totalPoints,
      preds,
    });
  }
}

console.log(`Simulated ${playerRows.length} player rows and ${teamRows.length} team-fixture rows.\n`);

// ---------------------------------------------------------------------------
// Statistical Scoring & Bootstrapping
// ---------------------------------------------------------------------------
const baseIndex = 0;
const byGw = new Map<number, PlayerRow[]>();
playerRows.forEach((r) => {
  (byGw.get(r.gameweek) ?? byGw.set(r.gameweek, []).get(r.gameweek)!).push(r);
});
const gwClusters = [...byGw.values()];

function computeClusterStats(armIdx: number, filterPos?: (pos: string) => boolean) {
  return gwClusters.map((cluster) => {
    const list = filterPos ? cluster.filter((r) => filterPos(r.position)) : cluster;
    if (!list.length) return { delta: 0, armRmse: 0, baseRmse: 0 };
    const armE = list.map((r) => r.preds[armIdx] - r.actual);
    const baseE = list.map((r) => r.preds[baseIndex] - r.actual);
    const aRmse = rmse(armE);
    const bRmse = rmse(baseE);
    return { delta: aRmse - bRmse, armRmse: aRmse, baseRmse: bRmse };
  });
}

function bootstrapCi(armIdx: number, filterPos?: (pos: string) => boolean): { meanDelta: number; ci95: [number, number]; winRate: number } {
  const stats = computeClusterStats(armIdx, filterPos);
  const wins = stats.filter((s) => s.delta < -1e-6).length;
  const validGw = stats.filter((s) => s.armRmse > 0).length;
  const winRate = validGw ? wins / validGw : 0;

  let seed = 20260902;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const deltas: number[] = [];
  for (let b = 0; b < BOOTSTRAP; b += 1) {
    let sumDelta = 0;
    for (let k = 0; k < stats.length; k += 1) {
      const pick = stats[Math.floor(rand() * stats.length)];
      sumDelta += pick.delta;
    }
    deltas.push(sumDelta / stats.length);
  }
  deltas.sort((a, b) => a - b);
  const meanDelta = mean(stats.map((s) => s.delta));
  const lo = deltas[Math.floor(0.025 * BOOTSTRAP)];
  const hi = deltas[Math.floor(0.975 * BOOTSTRAP)];
  return { meanDelta, ci95: [lo, hi], winRate };
}

// ---------------------------------------------------------------------------
// Report Results
// ---------------------------------------------------------------------------
console.log("=========================================================================================================");
console.log("WALK-FORWARD BACKTEST RESULTS: 2025/26 (Gameweeks 6-38, 9,972 Player Rows, 660 Team-Fixtures)");
console.log("=========================================================================================================\n");

console.log("1. OVERALL PLAYER EXPECTED POINTS (xP) ACCURACY");
console.log("---------------------------------------------------------------------------------------------------------");
console.log(
  "Arm".padEnd(52) +
  "xP RMSE".padEnd(10) +
  "dRMSE".padEnd(10) +
  "95% CI (GW clusters)".padEnd(24) +
  "GW Wins".padEnd(10) +
  "Verdict",
);
console.log("-".repeat(110));

const baseRmse = rmse(playerRows.map((r) => r.preds[0] - r.actual));

ARMS.forEach((arm, i) => {
  const armRmse = rmse(playerRows.map((r) => r.preds[i] - r.actual));
  const diff = armRmse - baseRmse;
  if (i === 0) {
    console.log(arm.name.padEnd(52) + armRmse.toFixed(5).padEnd(10) + "-".padEnd(10) + "-".padEnd(24) + "-".padEnd(10) + "BASELINE");
    return;
  }
  const { ci95, winRate } = bootstrapCi(i);
  const sign = diff >= 0 ? `+${diff.toFixed(5)}` : diff.toFixed(5);
  const ciStr = `[${ci95[0] >= 0 ? `+${ci95[0].toFixed(5)}` : ci95[0].toFixed(5)}, ${ci95[1] >= 0 ? `+${ci95[1].toFixed(5)}` : ci95[1].toFixed(5)}]`;
  const winStr = `${Math.round(winRate * 33)}/33`;
  const verdict = ci95[1] < 0 ? "BETTER (sig)" : ci95[0] > 0 ? "WORSE (sig)" : "ns";

  console.log(
    arm.name.padEnd(52) +
    armRmse.toFixed(5).padEnd(10) +
    sign.padEnd(10) +
    ciStr.padEnd(24) +
    winStr.padEnd(10) +
    verdict,
  );
});

console.log("\n2. POSITIONAL SPLITS (GK/DEF vs MID/FWD)");
console.log("---------------------------------------------------------------------------------------------------------");
console.log(
  "Arm".padEnd(52) +
  "GK/DEF dRMSE".padEnd(14) +
  "GK/DEF CI95".padEnd(24) +
  "MID/FWD dRMSE".padEnd(14) +
  "MID/FWD CI95",
);
console.log("-".repeat(115));

ARMS.forEach((arm, i) => {
  if (i === 0) return;
  const defStat = bootstrapCi(i, (pos) => pos === "GK" || pos === "DEF");
  const attStat = bootstrapCi(i, (pos) => pos === "MID" || pos === "FWD");
  const defDiff = defStat.meanDelta;
  const attDiff = attStat.meanDelta;

  const defSign = defDiff >= 0 ? `+${defDiff.toFixed(5)}` : defDiff.toFixed(5);
  const attSign = attDiff >= 0 ? `+${attDiff.toFixed(5)}` : attDiff.toFixed(5);

  const defCi = `[${defStat.ci95[0] >= 0 ? "+" : ""}${defStat.ci95[0].toFixed(5)}, ${defStat.ci95[1] >= 0 ? "+" : ""}${defStat.ci95[1].toFixed(5)}]`;
  const attCi = `[${attStat.ci95[0] >= 0 ? "+" : ""}${attStat.ci95[0].toFixed(5)}, ${attStat.ci95[1] >= 0 ? "+" : ""}${attStat.ci95[1].toFixed(5)}]`;

  console.log(
    arm.name.padEnd(52) +
    defSign.padEnd(14) +
    defCi.padEnd(24) +
    attSign.padEnd(14) +
    attCi,
  );
});

console.log("\n3. TEAM-LEVEL METRICS (Clean Sheet Probability & Team xG)");
console.log("---------------------------------------------------------------------------------------------------------");
console.log(
  "Arm".padEnd(52) +
  "CS Brier".padEnd(12) +
  "dBrier".padEnd(12) +
  "CS LogLoss".padEnd(14) +
  "Team xG RMSE".padEnd(14),
);
console.log("-".repeat(105));

const baseCsBrier = brier(teamRows.map((r) => r.csPreds[0]), teamRows.map((r) => r.actualCleanSheet));

ARMS.forEach((arm, i) => {
  const csB = brier(teamRows.map((r) => r.csPreds[i]), teamRows.map((r) => r.actualCleanSheet));
  const csLl = logloss(teamRows.map((r) => r.csPreds[i]), teamRows.map((r) => r.actualCleanSheet));
  const xgR = rmse(teamRows.map((r) => r.xgPreds[i] - r.actualXgFor));
  const dB = csB - baseCsBrier;
  const dBSign = i === 0 ? "-" : dB >= 0 ? `+${dB.toFixed(5)}` : dB.toFixed(5);

  console.log(
    arm.name.padEnd(52) +
    csB.toFixed(5).padEnd(12) +
    dBSign.padEnd(12) +
    csLl.toFixed(5).padEnd(14) +
    xgR.toFixed(5).padEnd(14),
  );
});
