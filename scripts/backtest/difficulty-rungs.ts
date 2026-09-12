/**
 * Fit the five FDR difficulty rungs on 2025/26 using current ClubElo numbers.
 *
 * Rungs are the inherited constants in lib/projections/fixtureAdjustment.ts
 * ([1.14, 1.07, 1.00, 0.92, 0.84]); this script searches for the set that
 * best predicts what actually happened, holding venue and strength ratio at
 * their shipped values so only `base` varies.
 *
 * SCOPE LIMIT, read before quoting a number: the Elo values are the CURRENT
 * snapshot (data/generated/club-elo.json), applied retroactively to 2025/26
 * fixtures. That leaks the future (transfers, promoted sides resolved). The
 * result fits the *transformation* from an Elo gap to a multiplier, not
 * ClubElo as a live input. Confirm any winner on walk-forward
 * backtest-elo.json ratings before shipping. See scripts/backtest/elo-history.ts.
 *
 * Method: walk-forward throughout (strengthsBefore / formBefore / playerAt).
 * Primary loss is team-xG Poisson deviance on team-fixtures; player xP RMSE
 * is the secondary gate. Fit on GW6-25, validate once on GW26-38.
 * Uncertainty is a paired gameweek-cluster bootstrap, same convention as
 * sweep.ts / fdr.ts.
 *
 *   BACKTEST_DATA_DIR=/tmp/fpl-backtest-seasons/2025-26 npx tsx scripts/backtest/difficulty-rungs.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { playerRates, type Rates } from "./xp";
import { BASELINE, adjust } from "./variants";
import { expectedFloorDivision, thresholdProbability } from "@/lib/projections/distributions";
import type { Player, PlayerFixture, Position } from "@/types/player";
import type { TeamStrength } from "@/types/projection";
import { CLUB_ELO_SNAPSHOT, clubEloForFplShortName } from "@/lib/clubElo";

const dataDir = process.env.BACKTEST_DATA_DIR ?? "/tmp/fpl-backtest-seasons/2025-26";
const FIRST_GAMEWEEK = 6;
const FIT_THROUGH = 25;
const BOOTSTRAP = 4000;
const SHIPPED = [1.14, 1.07, 1.0, 0.92, 0.84] as const;
const VENUE_HOME = 1.102;
const VENUE_AWAY = 0.898;
const RATIO_CLAMP: readonly [number, number] = [0.7, 1.35];
const OUTER_CLAMP: readonly [number, number] = [0.55, 1.6];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Rungs = readonly [number, number, number, number, number];

function baseFromRungs(exact: number, rungs: readonly number[]): number {
  const c = clamp(exact, 1, 5);
  const lo = Math.floor(c);
  const hi = Math.ceil(c);
  if (lo === hi) return rungs[lo - 1] ?? 1;
  const frac = c - lo;
  return (rungs[lo - 1] ?? 1) * (1 - frac) + (rungs[hi - 1] ?? 1) * frac;
}

/** Current-snapshot Elo gap for one side of a fixture, venue-agnostic like production. */
function exactFromCurrentElo(ownShort: string | undefined, oppShort: string | undefined): number {
  const own = clubEloForFplShortName(ownShort)?.elo;
  const opp = clubEloForFplShortName(oppShort)?.elo;
  if (!Number.isFinite(own) || !Number.isFinite(opp)) return 3;
  return clamp(3 + ((opp as number) - (own as number)) / 150, 1, 5);
}

interface TeamCase {
  gameweek: number;
  exact: number;
  isHome: boolean;
  ownAttack: number;
  oppDefence: number;
  actualGoals: number;
}

function buildTeamCases(season: Season, shortOf: Map<number, string>): TeamCase[] {
  const cases: TeamCase[] = [];
  for (let gw = FIRST_GAMEWEEK; gw <= 38; gw += 1) {
    const s = strengthsBefore(season, gw);
    for (const fx of season.fixturesByGameweek.get(gw) ?? []) {
      const h = s[fx.homeTeamId];
      const a = s[fx.awayTeamId];
      if (!h || !a) continue;
      const homeShort = shortOf.get(fx.homeTeamId);
      const awayShort = shortOf.get(fx.awayTeamId);
      cases.push({
        gameweek: gw,
        exact: exactFromCurrentElo(homeShort, awayShort),
        isHome: true,
        ownAttack: h.attackHome,
        oppDefence: a.defenceAway,
        actualGoals: fx.homeXg,
      });
      cases.push({
        gameweek: gw,
        exact: exactFromCurrentElo(awayShort, homeShort),
        isHome: false,
        ownAttack: a.attackAway,
        oppDefence: h.defenceHome,
        actualGoals: fx.awayXg,
      });
    }
  }
  return cases;
}

function multiplierFor(c: TeamCase, rungs: readonly number[]): number {
  const base = baseFromRungs(c.exact, rungs);
  const venue = c.isHome ? VENUE_HOME : VENUE_AWAY;
  const ratio = c.ownAttack > 0 && c.oppDefence > 0
    ? clamp(c.ownAttack / c.oppDefence, RATIO_CLAMP[0], RATIO_CLAMP[1])
    : 1;
  return clamp(base * venue * ratio, OUTER_CLAMP[0], OUTER_CLAMP[1]);
}

/** Mean Poisson deviance of leagueMean*m against actual team xG. */
function deviance(cases: readonly TeamCase[], rungs: readonly number[], leagueMean: number): number {
  let sum = 0;
  for (const c of cases) {
    const m = Math.max(leagueMean * multiplierFor(c, rungs), 1e-6);
    const y = Math.max(c.actualGoals, 0);
    sum += 2 * ((y > 0 ? y * Math.log(y / m) : 0) - (y - m));
  }
  return sum / cases.length;
}

function rmse(values: number[]): number {
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}

let seed = 20260911;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

function clusterInterval(
  cases: readonly TeamCase[],
  stat: (sample: TeamCase[]) => number,
): [number, number] {
  const byGw = new Map<number, TeamCase[]>();
  for (const c of cases) (byGw.get(c.gameweek) ?? byGw.set(c.gameweek, []).get(c.gameweek)!).push(c);
  const gws = [...byGw.keys()];
  const draws: number[] = [];
  for (let b = 0; b < BOOTSTRAP; b += 1) {
    const sample: TeamCase[] = [];
    for (let i = 0; i < gws.length; i += 1) sample.push(...byGw.get(gws[Math.floor(rand() * gws.length)])!);
    draws.push(stat(sample));
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * BOOTSTRAP)], draws[Math.floor(0.975 * BOOTSTRAP)]];
}

function isValid(r: readonly number[]): boolean {
  const [m1, m2, m3, m4, m5] = r;
  if (Math.abs(m3 - 1) > 1e-12) return false;
  if (!(m1 >= m2 && m2 >= m3 && m3 >= m4 && m4 >= m5)) return false;
  if (m1 > 1.4 || m5 < 0.6) return false;
  return true;
}

function main(): void {
  const season = loadSeason();
  if (!season.hasPreparedPriors) {
    console.error("refusing to run on the legacy corpus: prepare 2025-26 first (prepare-seasons.ts).");
    process.exit(1);
  }
  const teamFile = JSON.parse(
    readFileSync(path.join(dataDir, "team-strength.json"), "utf8"),
  ) as { teamId: number; shortName: string }[];
  const shortOf = new Map(teamFile.map((t) => [t.teamId, t.shortName]));

  // Coverage of current Elo over this season's clubs.
  const missing = [...shortOf.values()].filter((s) => !clubEloForFplShortName(s));
  console.log(`clubs: ${shortOf.size}, missing current Elo: ${missing.length ? missing.join(",") : "none"}`);
  console.log(`ClubElo snapshot: ${CLUB_ELO_SNAPSHOT.snapshotDate} (fetched ${CLUB_ELO_SNAPSHOT.fetchedAt})`);

  // Parity gate: local base must reproduce variants.adjust on integer difficulties.
  const probe = { ...BASELINE };
  let maxDiff = 0;
  for (const d of [1, 2, 3, 4, 5]) {
    for (const home of [true, false]) {
      const local = baseFromRungs(d, [...SHIPPED]);
      const ref = adjust(
        { gameweek: 1, opponentTeamId: 0, opponentShortName: "X", isHome: home, difficulty: d },
        {},
        probe,
      ).attackMultiplier / (home ? VENUE_HOME : VENUE_AWAY);
      maxDiff = Math.max(maxDiff, Math.abs(local - ref));
    }
  }
  console.log(`parity vs variants.adjust base: max diff ${maxDiff.toExponential(2)}`);
  if (maxDiff > 1e-9) {
    console.error("parity gate failed; local base does not reproduce the hardcoded table.");
    process.exit(1);
  }

  const all = buildTeamCases(season, shortOf);
  const fit = all.filter((c) => c.gameweek <= FIT_THROUGH);
  const holdout = all.filter((c) => c.gameweek > FIT_THROUGH);
  console.log(`team-fixtures: ${all.length} (fit GW${FIRST_GAMEWEEK}-${FIT_THROUGH}: ${fit.length}, holdout GW${FIT_THROUGH + 1}-38: ${holdout.length})`);
  console.log(`league mean xG: ${season.leagueAverageXg.toFixed(4)}`);

  const shippedFit = deviance(fit, [...SHIPPED], season.leagueAverageXg);
  console.log(`\nshipped rungs [${[...SHIPPED].join(", ")}] fit deviance: ${shippedFit.toFixed(5)}`);

  // Stage 1: coarse grid on the fit block.
  const grid1 = [1.08, 1.14, 1.2];
  const grid2 = [1.03, 1.07, 1.11];
  const grid4 = [0.88, 0.92, 0.96];
  const grid5 = [0.78, 0.84, 0.9];
  const scored: { rungs: Rungs; dev: number }[] = [];
  for (const m1 of grid1) {
    for (const m2 of grid2) {
      for (const m4 of grid4) {
        for (const m5 of grid5) {
          const r: Rungs = [m1, m2, 1, m4, m5];
          if (!isValid(r)) continue;
          scored.push({ rungs: r, dev: deviance(fit, r, season.leagueAverageXg) });
        }
      }
    }
  }
  scored.sort((a, b) => a.dev - b.dev);
  console.log(`\nTop 10 of ${scored.length} grid arms (fit block):`);
  scored.slice(0, 10).forEach((s, i) => {
    console.log(`  ${i + 1}. [${s.rungs.map((v) => v.toFixed(2)).join(", ")}] dev ${s.dev.toFixed(5)} (d ${s.dev - shippedFit >= 0 ? "+" : ""}${(s.dev - shippedFit).toFixed(5)})`);
  });

  // Stage 2: coordinate descent from the top 3 grid points.
  let best = scored[0];
  const stepRefine = (start: { rungs: Rungs; dev: number }, steps: number[]) => {
    let cur = start;
    for (const step of steps) {
      let improved = true;
      while (improved) {
        improved = false;
        for (const idx of [0, 1, 3, 4]) {
          for (const dir of [-1, 1]) {
            const next = [...cur.rungs] as [number, number, number, number, number];
            next[idx] = Math.round((next[idx] + dir * step) * 100) / 100;
            if (!isValid(next)) continue;
            const dev = deviance(fit, next, season.leagueAverageXg);
            if (dev < cur.dev - 1e-9) {
              cur = { rungs: next, dev };
              improved = true;
            }
          }
        }
      }
    }
    return cur;
  };
  const seeds = scored.slice(0, 3).map((s) => stepRefine(s, [0.04, 0.02, 0.01]));
  seeds.sort((a, b) => a.dev - b.dev);
  best = seeds[0].dev < best.dev ? seeds[0] : best;
  console.log(`\nRefined winner (fit block): [${best.rungs.map((v) => v.toFixed(2)).join(", ")}] dev ${best.dev.toFixed(5)}`);

  // Fit-block inference for the winner vs shipped.
  const dFit = best.dev - shippedFit;
  const [loFit, hiFit] = clusterInterval(fit, (s) =>
    deviance(s, best.rungs, season.leagueAverageXg) - deviance(s, [...SHIPPED], season.leagueAverageXg));
  console.log(`fit dDev (winner - shipped): ${dFit >= 0 ? "+" : ""}${dFit.toFixed(5)}  95% CI [${loFit >= 0 ? "+" : ""}${loFit.toFixed(5)}, ${hiFit >= 0 ? "+" : ""}${hiFit.toFixed(5)}]`);

  // Stage 3: single locked validation on the holdout.
  const shippedHold = deviance(holdout, [...SHIPPED], season.leagueAverageXg);
  const bestHold = deviance(holdout, best.rungs, season.leagueAverageXg);
  const dHold = bestHold - shippedHold;
  const [loHold, hiHold] = clusterInterval(holdout, (s) =>
    deviance(s, best.rungs, season.leagueAverageXg) - deviance(s, [...SHIPPED], season.leagueAverageXg));
  const gwWins = (() => {
    const byGw = new Map<number, TeamCase[]>();
    for (const c of holdout) (byGw.get(c.gameweek) ?? byGw.set(c.gameweek, []).get(c.gameweek)!).push(c);
    let wins = 0;
    for (const list of byGw.values()) {
      if (deviance(list, best.rungs, season.leagueAverageXg) < deviance(list, [...SHIPPED], season.leagueAverageXg)) wins += 1;
    }
    return `${wins}/${byGw.size}`;
  })();
  console.log(`\nHOLDOUT GW${FIT_THROUGH + 1}-38 (locked, scored once):`);
  console.log(`  shipped dev ${shippedHold.toFixed(5)}, winner dev ${bestHold.toFixed(5)}`);
  console.log(`  dDev ${dHold >= 0 ? "+" : ""}${dHold.toFixed(5)}  95% CI [${loHold >= 0 ? "+" : ""}${loHold.toFixed(5)}, ${hiHold >= 0 ? "+" : ""}${hiHold.toFixed(5)}]  gw wins ${gwWins}`);

  // Secondary gate: player xP RMSE on the holdout for shipped vs winner.
  // Player path reuses xp.ts rates; only the base comes from the candidate rungs
  // via exactDifficulty, mirroring production's continuous read.
  // Secondary gate: player xP RMSE on the holdout for shipped vs winner.
  // xp.ts pins the hardcoded table, so this local scorer mirrors
  // xp.expectedPoints exactly except the attack multiplier comes from the
  // candidate rungs via the continuous Elo exact. Clean sheets, saves env,
  // defcon and cards are untouched by base when strengths exist, so they are
  // read from adjust() with useDifficultyBase=false and only the attacking
  // terms (goals/assists/bonus) feel the candidate base.
  const GOAL_POINTS: Record<Position, number> = { GK: 10, DEF: 6, MID: 5, FWD: 4 };
  const GOAL_CONVERSION: Record<Position, number> = { GK: 1, DEF: 0.7, MID: 0.981, FWD: 0.988 };
  const ASSIST_CONVERSION: Record<Position, number> = { GK: 1, DEF: 1.272, MID: 1.207, FWD: 2.114 };
  const CLEAN_SHEET_POINTS: Record<Position, number> = { GK: 4, DEF: 4, MID: 1, FWD: 0 };
  const DEF_T: Record<Position, number> = { GK: 0, DEF: 10, MID: 12, FWD: 12 };
  const noBase = { ...BASELINE, useDifficultyBase: false };
  function xpWithRungs(
    player: Player, fixture: PlayerFixture, exact: number, minutes: number,
    rates: Rates, strengths: Record<number, TeamStrength>, rungs: readonly number[],
  ): number {
    const own = strengths[player.teamId];
    const opp = strengths[fixture.opponentTeamId];
    const base = baseFromRungs(exact, rungs);
    const venue = fixture.isHome ? VENUE_HOME : VENUE_AWAY;
    const ratio = own && opp
      ? clamp(
        (fixture.isHome ? own.attackHome : own.attackAway) /
          (fixture.isHome ? opp.defenceAway : opp.defenceHome),
        RATIO_CLAMP[0], RATIO_CLAMP[1],
      )
      : 1;
    const attack = clamp(base * venue * ratio, OUTER_CLAMP[0], OUTER_CLAMP[1]);
    const a = adjust(fixture, { position: player.position, ownTeam: own, opponentTeam: opp }, noBase);
    const share = clamp(minutes, 0, 90) / 90;
    if (share <= 0) return 0;
    let total = minutes >= 60 ? 2 : 1;
    if (player.position !== "GK") {
      total += rates.xg * GOAL_CONVERSION[player.position] * share * attack * GOAL_POINTS[player.position];
    }
    total += rates.xa * ASSIST_CONVERSION[player.position] * share * attack * 3;
    if (minutes >= 60) total += a.cleanSheetProbability * CLEAN_SHEET_POINTS[player.position];
    if (player.position === "GK" || player.position === "DEF") {
      total -= expectedFloorDivision(a.expectedGoalsAgainst * share, 2);
    }
    if (player.position === "GK") {
      total += expectedFloorDivision(rates.saves * share * a.savesEnvironment, 3);
    }
    const threshold = DEF_T[player.position];
    if (threshold > 0) {
      total += 2 * thresholdProbability(rates.defensiveContribution * share, threshold);
    }
    total += rates.bonus * share * attack;
    total -= 1 * (1 - Math.exp(-rates.yellowCards * share)) + 3 * (1 - Math.exp(-rates.redCards * share));
    return total;
  }

  interface PRow { gameweek: number; actual: number; shipped: number; winner: number }
  const pRows: PRow[] = [];
  const shippedRungs: Rungs = [SHIPPED[0], SHIPPED[1], SHIPPED[2], SHIPPED[3], SHIPPED[4]];
  for (let gw = FIT_THROUGH + 1; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const fixtureById = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    for (const row of season.rowsByGameweek.get(gw) ?? []) {
      if (row.minutes <= 0) continue;
      const fx = fixtureById.get(row.fixtureId);
      if (!fx) continue;
      const player = playerAt(season, row.historicalPlayerId, gw, fx, row.wasHome);
      if (!player) continue;
      const rates = playerRates(player, formBefore(season, row.historicalPlayerId, gw), gw);
      const ownShort = shortOf.get(season.teamOf.get(row.historicalPlayerId) ?? -1);
      const oppId = row.wasHome ? fx.awayTeamId : fx.homeTeamId;
      const oppShort = shortOf.get(oppId);
      const exact = exactFromCurrentElo(row.wasHome ? ownShort : oppShort, row.wasHome ? oppShort : ownShort);
      const pf: PlayerFixture = {
        gameweek: gw, opponentTeamId: oppId, opponentShortName: "OPP", isHome: row.wasHome, difficulty: 3,
      };
      pRows.push({
        gameweek: gw,
        actual: row.totalPoints,
        shipped: xpWithRungs(player, pf, exact, row.minutes, rates, strengths, shippedRungs),
        winner: xpWithRungs(player, pf, exact, row.minutes, rates, strengths, best.rungs),
      });
    }
  }
  const rmseOf = (pick: (r: PRow) => number) =>
    Math.sqrt(pRows.reduce((s, r) => s + (pick(r) - r.actual) ** 2, 0) / Math.max(pRows.length, 1));
  const rShipped = rmseOf((r) => r.shipped);
  const rWinner = rmseOf((r) => r.winner);
  const dXp = rWinner - rShipped;
  const pByGw = new Map<number, PRow[]>();
  for (const r of pRows) (pByGw.get(r.gameweek) ?? pByGw.set(r.gameweek, []).get(r.gameweek)!).push(r);
  const pGws = [...pByGw.keys()];
  const xpDraws: number[] = [];
  for (let b = 0; b < BOOTSTRAP; b += 1) {
    const sample: PRow[] = [];
    for (let i = 0; i < pGws.length; i += 1) sample.push(...pByGw.get(pGws[Math.floor(rand() * pGws.length)])!);
    const rs = Math.sqrt(sample.reduce((s, r) => s + (r.shipped - r.actual) ** 2, 0) / sample.length);
    const rw = Math.sqrt(sample.reduce((s, r) => s + (r.winner - r.actual) ** 2, 0) / sample.length);
    xpDraws.push(rw - rs);
  }
  xpDraws.sort((a, b) => a - b);
  const xpLo = xpDraws[Math.floor(0.025 * BOOTSTRAP)];
  const xpHi = xpDraws[Math.floor(0.975 * BOOTSTRAP)];
  const xpWins = pGws.filter((gw) => {
    const list = pByGw.get(gw)!;
    const rs = Math.sqrt(list.reduce((s, r) => s + (r.shipped - r.actual) ** 2, 0) / list.length);
    const rw = Math.sqrt(list.reduce((s, r) => s + (r.winner - r.actual) ** 2, 0) / list.length);
    return rw < rs;
  }).length;
  console.log(`\nSECONDARY GATE, player xP on holdout (${pRows.length.toLocaleString()} played rows):`);
  console.log(`  shipped RMSE ${rShipped.toFixed(5)}, winner RMSE ${rWinner.toFixed(5)}`);
  console.log(`  dRMSE ${dXp >= 0 ? "+" : ""}${dXp.toFixed(5)}  95% CI [${xpLo >= 0 ? "+" : ""}${xpLo.toFixed(5)}, ${xpHi >= 0 ? "+" : ""}${xpHi.toFixed(5)}]  gw wins ${xpWins}/${pGws.length}`);

  const spreadOk = Math.max(
    Math.abs(best.rungs[0] - best.rungs[1]),
    Math.abs(best.rungs[1] - best.rungs[2]),
    Math.abs(best.rungs[2] - best.rungs[3]),
    Math.abs(best.rungs[3] - best.rungs[4]),
  ) <= 0.08 + 1e-9;
  console.log(`\nVERDICT (ship needs all three): holdout team-xG CI excludes zero in the right direction,`);
  console.log(`xP not regressed, max rung kink ${spreadOk ? "OK (<=0.08)" : "TOO SHARP (>0.08)"}.`);
  console.log(`Winner [${best.rungs.map((v) => v.toFixed(2)).join(", ")}] vs shipped [${[...SHIPPED].join(", ")}].`);
}

main();
