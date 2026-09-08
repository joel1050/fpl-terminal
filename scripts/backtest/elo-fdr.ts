/**
 * Should `base` read the gap between the two teams, or the opponent alone?
 *
 * Section 7 multiplies `base`, from a 1-5 fixture rating, by the strength ratio
 * `ownAttack / opponentDefence`. The shipped ClubElo rating is a function of the
 * Elo *difference*, so home and away difficulty always sum to 6 and a meeting of
 * two elite sides scores the same as a meeting of two poor ones. This asks
 * whether reading the opponent's rating on its own does better, given that
 * `base` multiplies the attack term and attacking output depends on the quality
 * of the defence being faced.
 *
 * Arms, everything else held at BASELINE and only `fixture.difficulty` moved:
 *   FPL        FPL's published 1-5 rating - what section 7 read before the change
 *   NONE       base = 1, the no-strengths fallback
 *   GAP(d)     round(3 + (Eopp - Eown)/d - 0.2*home)      d = 200 is the shipped formula
 *   MIX(w)     round(3 + ((Eopp - leagueMean) - w*(Eown - leagueMean))/S(w) - 0.2*home)
 *              w = 1 is the gap formula, w = 0 reads the opponent alone
 *
 * Both Elo arms carry the same 0.2-of-a-step venue tilt so the sweep over their
 * one free constant is like for like; at d = 200 that tilt is exactly the
 * shipped H = 40 Elo points. FPL's own rating carries a tilt of about the same
 * size, which is why neither Elo arm is given zero: the 1.102/0.898 venue
 * multipliers were fitted with a tilted `base` already in place.
 *
 * SCOPE. The ratings come from scripts/backtest/elo-history.ts, not from
 * ClubElo, whose history API is down. A difference between the Elo arms is a
 * difference of formula, since both read the same ratings. A difference between
 * either and FPL confounds the rating source with the formula and is reported
 * but not concluded from.
 *
 * Team xG is the headline. `base` multiplies the attack term and nothing else,
 * and minutes noise buries section-7 differences at the player level.
 *
 *   BACKTEST_DATA_DIR=.../2024-25 npx tsx scripts/backtest/elo-fdr.ts 2024-25
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadSeason, strengthsBefore, formBefore, playerAt } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE, adjust, type Variant } from "./variants";
import type { EloFixtureRow } from "./elo-history";

const label = process.argv[2] ?? "season";
const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 4000;
const VENUE_TILT = 0.2;
/** The shipped ClubElo divisor, and the sweep either side of it. */
const GAP_DIVISORS = [130, 200, 300] as const;
/**
 * How much of the own side's rating to subtract. `w = 1` is the shipped gap
 * formula; `w = 0` reads the opponent alone. The divisor grows with the spread
 * of the numerator so every weight produces a comparable 1-5 spread and the
 * sweep compares shape rather than scale.
 */
const MIX_WEIGHTS = [0, 0.25, 0.5, 0.75, 1] as const;
const MIX_BASE_DIVISOR = 200;
const mixDivisor = (w: number) => MIX_BASE_DIVISOR * Math.sqrt(1 + w * w) / Math.SQRT2;

const dataDir = process.env.BACKTEST_DATA_DIR;
if (!dataDir || !existsSync(path.join(dataDir, "backtest-elo.json"))) {
  console.error("no backtest-elo.json in BACKTEST_DATA_DIR; run scripts/backtest/elo-history.ts first");
  process.exit(1);
}
const eloRows = JSON.parse(readFileSync(path.join(dataDir, "backtest-elo.json"), "utf8")) as EloFixtureRow[];
const eloById = new Map(eloRows.map((row) => [row.fixtureId, row]));

const season = loadSeason();
if (!season.fixtures.some((f) => f.homeDifficulty !== undefined)) {
  console.error("no fixture-difficulty.json in BACKTEST_DATA_DIR; nothing to compare against");
  process.exit(1);
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rmse = (xs: number[]) => Math.sqrt(mean(xs.map((x) => x * x)));
const corr = (a: number[], b: number[]) => {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
};

/** One arm is just a rule for turning a fixture into a 1-5 rating. */
interface Arm {
  name: string;
  variant: Variant;
  difficulty: (context: {
    fplDifficulty: number | undefined;
    ownElo: number;
    opponentElo: number;
    leagueMeanElo: number;
    isHome: boolean;
  }) => number;
}

const rate = (value: number) => clamp(Math.round(value), 1, 5);
const arms: Arm[] = [
  { name: "FPL", variant: BASELINE, difficulty: (c) => rate(c.fplDifficulty ?? 3) },
  { name: "NONE", variant: { ...BASELINE, useDifficultyBase: false }, difficulty: () => 3 },
  ...GAP_DIVISORS.map((d) => ({
    name: `GAP(${d})${d === 200 ? "*" : ""}`,
    variant: BASELINE,
    difficulty: (c: Parameters<Arm["difficulty"]>[0]) =>
      rate(3 + (c.opponentElo - c.ownElo) / d - (c.isHome ? VENUE_TILT : -VENUE_TILT)),
  })),
  ...MIX_WEIGHTS.map((w) => ({
    name: `MIX(w=${w})`,
    variant: BASELINE,
    difficulty: (c: Parameters<Arm["difficulty"]>[0]) =>
      rate(3
        + ((c.opponentElo - c.leagueMeanElo) - w * (c.ownElo - c.leagueMeanElo)) / mixDivisor(w)
        - (c.isHome ? VENUE_TILT : -VENUE_TILT)),
  })),
];

const difficultyMultiplier: Record<number, number> = { 1: 1.14, 2: 1.07, 3: 1, 4: 0.92, 5: 0.84 };

// ---------- team-fixture level ----------
interface TeamRow {
  gameweek: number;
  ratio: number;
  actual: number;
  base: Record<string, number>;
  multiplier: Record<string, number>;
  difficulty: Record<string, number>;
}
const teamRows: TeamRow[] = [];

for (let gw = FIRST_GAMEWEEK; gw <= 38; gw += 1) {
  const s = strengthsBefore(season, gw);
  for (const fx of season.fixturesByGameweek.get(gw) ?? []) {
    const elo = eloById.get(fx.fixtureId);
    if (!elo) continue;
    for (const isHome of [true, false]) {
      const own = isHome ? fx.homeTeamId : fx.awayTeamId;
      const opp = isHome ? fx.awayTeamId : fx.homeTeamId;
      const fplDifficulty = isHome ? fx.homeDifficulty : fx.awayDifficulty;
      if (!s[own] || !s[opp] || fplDifficulty === undefined) continue;
      const context = {
        fplDifficulty,
        ownElo: isHome ? elo.homeElo : elo.awayElo,
        opponentElo: isHome ? elo.awayElo : elo.homeElo,
        leagueMeanElo: elo.leagueMeanElo,
        isHome,
      };
      const base: Record<string, number> = {};
      const multiplier: Record<string, number> = {};
      const difficulty: Record<string, number> = {};
      for (const arm of arms) {
        const d = arm.difficulty(context);
        difficulty[arm.name] = d;
        base[arm.name] = arm.variant.useDifficultyBase ? difficultyMultiplier[d] : 1;
        const pf = { gameweek: gw, opponentTeamId: opp, opponentShortName: "OPP", isHome, difficulty: d };
        multiplier[arm.name] = adjust(pf, { ownTeam: s[own], opponentTeam: s[opp] }, arm.variant).attackMultiplier;
      }
      teamRows.push({
        gameweek: gw,
        ratio: (isHome ? s[own].attackHome : s[own].attackAway) / (isHome ? s[opp].defenceAway : s[opp].defenceHome),
        actual: (isHome ? fx.homeXg : fx.awayXg) / season.leagueAverageXg,
        base,
        multiplier,
        difficulty,
      });
    }
  }
}

console.log(`\n=== ${label} — ${teamRows.length} team-fixtures, gameweeks ${FIRST_GAMEWEEK}-38 ===`);

// Residual after the strength ratio: does this rating say anything the model's
// own strengths do not already say?
const logRatio = teamRows.map((r) => Math.log(r.ratio));
const actual = teamRows.map((r) => r.actual);
const slope = (() => {
  const mx = mean(logRatio), my = mean(actual);
  let n = 0, d = 0;
  for (let i = 0; i < logRatio.length; i += 1) { n += (logRatio[i] - mx) * (actual[i] - my); d += (logRatio[i] - mx) ** 2; }
  return n / d;
})();
const intercept = mean(actual) - slope * mean(logRatio);
const residual = teamRows.map((r, i) => actual[i] - (intercept + slope * logRatio[i]));

const pad = (text: string, width: number) => text.padEnd(width);
console.log(`\n${pad("arm", 11)} ${pad("FDR spread", 22)} ${pad("corr(base,ratio)", 17)} ${pad("resid corr", 11)} ${pad("corr xG", 8)} ${pad("xG RMSE", 8)} clamp`);
for (const arm of arms) {
  const base = teamRows.map((r) => r.base[arm.name]);
  const multiplier = teamRows.map((r) => r.multiplier[arm.name]);
  const counts = [1, 2, 3, 4, 5].map((d) => teamRows.filter((r) => r.difficulty[arm.name] === d).length);
  const bound = teamRows.filter((r) => {
    const m = r.multiplier[arm.name];
    return m <= BASELINE.multiplierClamp[0] + 1e-4 || m >= BASELINE.multiplierClamp[1] - 1e-4;
  }).length;
  const flat = base.every((value) => value === base[0]);
  console.log(
    `${pad(arm.name, 11)} ${pad(counts.join("/"), 22)} `
    + `${pad(flat ? "—" : corr(base, teamRows.map((r) => r.ratio)).toFixed(3), 17)} `
    + `${pad(flat ? "—" : corr(base, residual).toFixed(3), 11)} `
    + `${pad(corr(multiplier, actual).toFixed(4), 8)} `
    + `${pad(rmse(multiplier.map((m, i) => m - actual[i])).toFixed(5), 8)} `
    + `${(100 * bound / teamRows.length).toFixed(1)}%`,
  );
}
console.log("FDR spread counts ratings 1/2/3/4/5. resid corr is against actual xG once the strength ratio is removed: 0 means the rating adds nothing.");

// Paired bootstrap on team xG, resampled by gameweek: rows in one gameweek
// share opponents and a week of scheduling, so row-level draws would understate
// the spread. Reference is the shipped formula.
const REFERENCE = "GAP(200)*";
const teamByGw = new Map<number, TeamRow[]>();
teamRows.forEach((r) => { (teamByGw.get(r.gameweek) ?? teamByGw.set(r.gameweek, []).get(r.gameweek)!).push(r); });
const teamClusters = [...teamByGw.values()];
const teamRmse = (rs: TeamRow[], name: string) => rmse(rs.map((r) => r.multiplier[name] - r.actual));
const teamDraws: Record<string, number[]> = Object.fromEntries(arms.map((a) => [a.name, [] as number[]]));
for (let b = 0; b < BOOTSTRAP; b += 1) {
  const pick: TeamRow[] = [];
  for (let k = 0; k < teamClusters.length; k += 1) pick.push(...teamClusters[Math.floor(Math.random() * teamClusters.length)]);
  const reference = teamRmse(pick, REFERENCE);
  for (const arm of arms) teamDraws[arm.name].push(teamRmse(pick, arm.name) - reference);
}
console.log(`\nteam xG RMSE against ${REFERENCE} (negative = better than the shipped formula)`);
console.log(`${pad("arm", 12)} ${pad("vs ref", 10)} CI95`);
for (const arm of arms) {
  const sorted = teamDraws[arm.name].sort((a, b) => a - b);
  const low = sorted[Math.floor(0.025 * BOOTSTRAP)];
  const high = sorted[Math.floor(0.975 * BOOTSTRAP)];
  console.log(
    `${pad(arm.name, 12)} ${pad((teamRmse(teamRows, arm.name) - teamRmse(teamRows, REFERENCE)).toFixed(5), 10)} `
    + `[${low.toFixed(5)}, ${high.toFixed(5)}]${low > 0 || high < 0 ? "  significant" : ""}`,
  );
}

// ---------- player xP ----------
interface Row { gameweek: number; actual: number; xp: Record<string, number> }
const rows: Row[] = [];
for (let gw = FIRST_GAMEWEEK; gw <= 38; gw += 1) {
  const s = strengthsBefore(season, gw);
  const byId = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
  for (const r of season.rowsByGameweek.get(gw) ?? []) {
    if (r.minutes <= 0) continue;
    const fx = byId.get(r.fixtureId);
    const elo = fx && eloById.get(fx.fixtureId);
    if (!fx || !elo) continue;
    const player = playerAt(season, r.historicalPlayerId, gw, fx, r.wasHome);
    if (!player) continue;
    const rates = playerRates(player, formBefore(season, r.historicalPlayerId, gw), gw);
    const upcoming = player.fixtures[0];
    const context = {
      fplDifficulty: r.wasHome ? fx.homeDifficulty : fx.awayDifficulty,
      ownElo: r.wasHome ? elo.homeElo : elo.awayElo,
      opponentElo: r.wasHome ? elo.awayElo : elo.homeElo,
      leagueMeanElo: elo.leagueMeanElo,
      isHome: r.wasHome,
    };
    const xp: Record<string, number> = {};
    for (const arm of arms) {
      xp[arm.name] = expectedPoints(
        player,
        { ...upcoming, difficulty: arm.difficulty(context) },
        r.minutes, rates, s, arm.variant,
      ).total;
    }
    rows.push({ gameweek: gw, actual: r.totalPoints, xp });
  }
}

const byGw = new Map<number, Row[]>();
rows.forEach((r) => { (byGw.get(r.gameweek) ?? byGw.set(r.gameweek, []).get(r.gameweek)!).push(r); });
const clusters = [...byGw.values()];
const armRmse = (rs: Row[], name: string) => rmse(rs.map((r) => r.xp[name] - r.actual));


console.log(`\nplayer rows ${rows.length}; xP RMSE, and the paired gap against ${REFERENCE} (negative = better than it)`);
const draws: Record<string, number[]> = {};
for (const arm of arms) draws[arm.name] = [];
for (let b = 0; b < BOOTSTRAP; b += 1) {
  const pick: Row[] = [];
  for (let k = 0; k < clusters.length; k += 1) pick.push(...clusters[Math.floor(Math.random() * clusters.length)]);
  const reference = armRmse(pick, REFERENCE);
  for (const arm of arms) draws[arm.name].push(armRmse(pick, arm.name) - reference);
}
console.log(`\n${pad("arm", 11)} ${pad("xP RMSE", 9)} ${pad("vs ref", 9)} ${pad("CI95", 20)} better in`);
for (const arm of arms) {
  const sorted = draws[arm.name].sort((a, b) => a - b);
  const wins = clusters.filter((c) => armRmse(c, arm.name) < armRmse(c, REFERENCE)).length;
  console.log(
    `${pad(arm.name, 11)} ${pad(armRmse(rows, arm.name).toFixed(5), 9)} `
    + `${pad((armRmse(rows, arm.name) - armRmse(rows, REFERENCE)).toFixed(5), 9)} `
    + `${pad(`[${sorted[Math.floor(0.025 * BOOTSTRAP)].toFixed(5)}, ${sorted[Math.floor(0.975 * BOOTSTRAP)].toFixed(5)}]`, 20)} `
    + `${wins}/${clusters.length} gws`,
  );
}
