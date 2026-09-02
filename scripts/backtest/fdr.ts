/**
 * Does FPL's difficulty rating still say anything once team strengths are known?
 *
 * Section 7 multiplies two terms that encode the same thing: `base`, read from
 * FPL's 1-5 fixture difficulty, and `ownAttack / opponentDefence`, read from the
 * model's own strengths. When they agree the opponent is counted twice; when
 * they disagree, `base` quietly wins a share of the argument.
 *
 * This was recorded in README.md as untestable because merged_gw.csv carries no
 * difficulty. It does exist: vaastav's fixtures.csv has team_h_difficulty and
 * team_a_difficulty for every season, ingested here as fixture-difficulty.json.
 *
 * Two arms, everything else held at BASELINE:
 *   with base    what section 7 does today
 *   without base `base = 1` whenever both strengths exist, leaving FDR as the
 *                no-strengths fallback it already is at fixtureAdjustment.ts:129
 *
 *   BACKTEST_DATA_DIR=... npx tsx scripts/backtest/fdr.ts 2024-25
 */
import { loadSeason, strengthsBefore, formBefore, playerAt } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE, adjust, type Variant } from "./variants";

const label = process.argv[2] ?? "season";
const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 4000;

const WITH: Variant = { ...BASELINE };
const WITHOUT: Variant = { ...BASELINE, useDifficultyBase: false };

const season = loadSeason();
if (!season.fixtures.some((f) => f.homeDifficulty !== undefined)) {
  console.error("no fixture-difficulty.json in BACKTEST_DATA_DIR; nothing to test");
  process.exit(1);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rmse = (xs: number[]) => Math.sqrt(mean(xs.map((x) => x * x)));
const corr = (a: number[], b: number[]) => {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
};

// ---------- team-fixture level: base, ratio, and what actually happened ----------
interface TeamRow { gameweek: number; base: number; ratio: number; mWith: number; mWithout: number; actual: number; }
const teamRows: TeamRow[] = [];
const difficultyMultiplier: Record<number, number> = { 1: 1.14, 2: 1.07, 3: 1, 4: 0.92, 5: 0.84 };

for (let gw = FIRST_GAMEWEEK; gw <= 38; gw += 1) {
  const s = strengthsBefore(season, gw);
  for (const fx of season.fixturesByGameweek.get(gw) ?? []) {
    for (const isHome of [true, false]) {
      const own = isHome ? fx.homeTeamId : fx.awayTeamId;
      const opp = isHome ? fx.awayTeamId : fx.homeTeamId;
      const d = isHome ? fx.homeDifficulty : fx.awayDifficulty;
      if (!s[own] || !s[opp] || d === undefined) continue;
      const pf = { gameweek: gw, opponentTeamId: opp, opponentShortName: "OPP", isHome, difficulty: d };
      teamRows.push({
        gameweek: gw,
        base: difficultyMultiplier[Math.min(5, Math.max(1, Math.round(d)))] ?? 1,
        ratio: (isHome ? s[own].attackHome : s[own].attackAway) / (isHome ? s[opp].defenceAway : s[opp].defenceHome),
        mWith: adjust(pf, { ownTeam: s[own], opponentTeam: s[opp] }, WITH).attackMultiplier,
        mWithout: adjust(pf, { ownTeam: s[own], opponentTeam: s[opp] }, WITHOUT).attackMultiplier,
        actual: (isHome ? fx.homeXg : fx.awayXg) / season.leagueAverageXg,
      });
    }
  }
}

console.log(`\n=== ${label} ===`);
console.log(`team-fixtures ${teamRows.length}`);
console.log(`corr(base, strength ratio) = ${corr(teamRows.map((r) => r.base), teamRows.map((r) => r.ratio)).toFixed(4)}`);
const disagree = teamRows.filter((r) => (r.base - 1) * (r.ratio - 1) < 0).length;
console.log(`they point opposite ways on ${(100 * disagree / teamRows.length).toFixed(1)}% of team-fixtures`);
console.log(`corr with actual xG:  with base ${corr(teamRows.map((r) => r.mWith), teamRows.map((r) => r.actual)).toFixed(4)}   without ${corr(teamRows.map((r) => r.mWithout), teamRows.map((r) => r.actual)).toFixed(4)}   base alone ${corr(teamRows.map((r) => r.base), teamRows.map((r) => r.actual)).toFixed(4)}   ratio alone ${corr(teamRows.map((r) => r.ratio), teamRows.map((r) => r.actual)).toFixed(4)}`);
console.log(`team xG RMSE:         with base ${rmse(teamRows.map((r) => r.mWith - r.actual)).toFixed(5)}   without ${rmse(teamRows.map((r) => r.mWithout - r.actual)).toFixed(5)}`);

// Does base carry signal the ratio misses? Regress actual on the ratio, then ask
// whether the residual still moves with base.
const lr = teamRows.map((r) => Math.log(r.ratio));
const la = teamRows.map((r) => r.actual);
const slope = (() => { const mx = mean(lr), my = mean(la); let n = 0, d = 0; for (let i = 0; i < lr.length; i += 1) { n += (lr[i] - mx) * (la[i] - my); d += (lr[i] - mx) ** 2; } return n / d; })();
const intercept = mean(la) - slope * mean(lr);
const resid = teamRows.map((r, i) => la[i] - (intercept + slope * lr[i]));
console.log(`residual-after-ratio correlation with base = ${corr(teamRows.map((r) => r.base), resid).toFixed(4)}  (0 = FDR adds nothing)`);

// How often does the outer multiplier clamp bind now that base is live?
const bound = teamRows.filter((r) => r.mWith <= 0.5501 || r.mWith >= 1.5999).length;
console.log(`outer multiplier clamp binds on ${(100 * bound / teamRows.length).toFixed(1)}% of team-fixtures (with base)`);

// ---------- player xP ----------
interface Row { gameweek: number; actual: number; withBase: number; withoutBase: number }
const rows: Row[] = [];
for (let gw = FIRST_GAMEWEEK; gw <= 38; gw += 1) {
  const s = strengthsBefore(season, gw);
  const byId = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
  for (const r of season.rowsByGameweek.get(gw) ?? []) {
    if (r.minutes <= 0) continue;
    const fx = byId.get(r.fixtureId);
    if (!fx) continue;
    const player = playerAt(season, r.historicalPlayerId, gw, fx, r.wasHome);
    if (!player) continue;
    const rates = playerRates(player, formBefore(season, r.historicalPlayerId, gw), gw);
    rows.push({
      gameweek: gw, actual: r.totalPoints,
      withBase: expectedPoints(player, player.fixtures[0], r.minutes, rates, s, WITH).total,
      withoutBase: expectedPoints(player, player.fixtures[0], r.minutes, rates, s, WITHOUT).total,
    });
  }
}

const rW = rmse(rows.map((r) => r.withBase - r.actual));
const rO = rmse(rows.map((r) => r.withoutBase - r.actual));
console.log(`\nplayer rows ${rows.length}`);
console.log(`xP RMSE:  with base ${rW.toFixed(5)}   without base ${rO.toFixed(5)}   without - with = ${(rO - rW).toFixed(5)}`);

const byGw = new Map<number, Row[]>();
rows.forEach((r) => { (byGw.get(r.gameweek) ?? byGw.set(r.gameweek, []).get(r.gameweek)!).push(r); });
const clusters = [...byGw.values()];
const delta = (rs: Row[]) => rmse(rs.map((r) => r.withoutBase - r.actual)) - rmse(rs.map((r) => r.withBase - r.actual));
const draws: number[] = [];
for (let b = 0; b < BOOTSTRAP; b += 1) {
  const pick: Row[] = [];
  for (let k = 0; k < clusters.length; k += 1) pick.push(...clusters[Math.floor(Math.random() * clusters.length)]);
  draws.push(delta(pick));
}
draws.sort((a, b) => a - b);
console.log(`   CI95 [${draws[Math.floor(.025 * BOOTSTRAP)].toFixed(5)}, ${draws[Math.floor(.975 * BOOTSTRAP)].toFixed(5)}]  (positive = dropping base is worse)`);
const wins = clusters.filter((c) => delta(c) > 0).length;
console.log(`   dropping base is worse in ${wins}/${clusters.length} gameweeks`);
