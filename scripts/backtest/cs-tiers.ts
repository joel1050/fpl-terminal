/**
 * Is the bottom of the clean-sheet table really too generous?
 *
 * Two things this gets right that the earlier look did not:
 *  - counts clean sheets once per TEAM-FIXTURE, not once per defender. Player
 *    rows inside one fixture are the same event, so treating them as 478
 *    independent observations overstates the evidence by roughly 3.7x.
 *  - puts a confidence interval on each tier before calling anything a defect.
 */
import { loadSeason, strengthsBefore, formBefore, playerAt } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";

const FIRST = 13, ANCHOR = 12;
const TIERS = [0.84, 0.92, 1, 1.08, 1.16];
const tierOf = (v: number) => TIERS.reduce((b, t, i) => (Math.abs(v - t) < Math.abs(v - TIERS[b]) ? i : b), 0);

let seed = 20260824;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function bootCI(vals: readonly number[]): [number, number] {
  if (vals.length < 5) return [NaN, NaN];
  const d: number[] = [];
  for (let b = 0; b < 4000; b += 1) {
    let s = 0;
    for (let i = 0; i < vals.length; i += 1) s += vals[Math.floor(rand() * vals.length)];
    d.push(s / vals.length);
  }
  d.sort((a, b) => a - b);
  return [d[100], d[3899]];
}
const mean = (a: readonly number[]) => a.reduce((s, x) => s + x, 0) / a.length;

function main(): void {
  const season = loadSeason();

  // ---- 1. clean sheets, one observation per team-fixture ----
  interface Case { tier: number; pred: number; actual: number }
  const cases: Case[] = [];
  for (let gw = FIRST; gw <= 38; gw += 1) {
    const s = strengthsBefore(season, gw);
    for (const fx of season.fixturesByGameweek.get(gw) ?? []) {
      const h = s[fx.homeTeamId], a = s[fx.awayTeamId];
      if (!h || !a) continue;
      const table = (isHome: boolean, def: number, att: number) => {
        const T = {
          home: [[.26,.24,.20,.15,.11],[.36,.31,.27,.24,.17],[.39,.33,.28,.24,.17],[.42,.36,.31,.27,.19],[.50,.42,.39,.33,.27]],
          away: [[.23,.16,.15,.12,.06],[.31,.25,.20,.17,.11],[.33,.27,.22,.18,.13],[.36,.30,.25,.21,.15],[.42,.35,.34,.30,.18]],
        } as const;
        return T[isHome ? "home" : "away"][tierOf(def)][tierOf(att)];
      };
      cases.push({ tier: tierOf(h.defenceHome), pred: table(true, h.defenceHome, a.attackAway), actual: fx.awayGoals === 0 ? 1 : 0 });
      cases.push({ tier: tierOf(a.defenceAway), pred: table(false, a.defenceAway, h.attackHome), actual: fx.homeGoals === 0 ? 1 : 0 });
    }
  }
  console.log(`CLEAN SHEETS BY DEFENCE TIER - one row per team-fixture (${cases.length} total)\n`);
  console.log("defence tier      n   predicted   actual     miss    95% CI on miss");
  console.log("-".repeat(72));
  for (let t = 0; t < 5; t += 1) {
    const list = cases.filter((c) => c.tier === t);
    if (!list.length) continue;
    const errs = list.map((c) => c.pred - c.actual);
    const [lo, hi] = bootCI(errs);
    const flag = lo > 0 || hi < 0 ? "  <-- excludes zero" : "";
    console.log(`tier ${t + 1}       ${String(list.length).padStart(5)}      ${mean(list.map((c) => c.pred)).toFixed(3)}    ${mean(list.map((c) => c.actual)).toFixed(3)}   ${(mean(errs) >= 0 ? "+" : "") + mean(errs).toFixed(3)}   [${lo.toFixed(3)}, ${hi.toFixed(3)}]${flag}`);
  }

  // ---- 2. where does the tier-1 defender bias actually come from? ----
  interface Row { tier: number; position: string; actual: number; parts: Record<string, number> }
  const rows: Row[] = [];
  for (let gw = FIRST; gw <= 38; gw += 1) {
    const s = strengthsBefore(season, gw);
    const byId = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    const anchorApps = (id: number) => (season.rowsByPlayer.get(id) ?? []).filter((x) => x.gameweek <= ANCHOR && x.minutes > 0).length;
    for (const r of season.rowsByGameweek.get(gw) ?? []) {
      if (r.minutes <= 0) continue;
      const fx = byId.get(r.fixtureId);
      if (!fx) continue;
      const p = playerAt(season, r.historicalPlayerId, gw, fx, r.wasHome, ANCHOR);
      if (!p || (p.position !== "DEF" && p.position !== "GK")) continue;
      const own = s[p.teamId];
      if (!own) continue;
      const c = expectedPoints(p, p.fixtures[0], r.minutes,
        playerRates(p, formBefore(season, r.historicalPlayerId, gw).slice(anchorApps(r.historicalPlayerId)), gw), s, BASELINE);
      rows.push({ tier: tierOf(own.overall), position: p.position, actual: r.totalPoints,
        parts: { appearance: c.appearance, cleanSheets: c.cleanSheets, goalsConceded: c.goalsConceded,
                 saves: c.saves, defCon: c.defensiveContribution, bonus: c.bonus, goals: c.goals + c.assists, total: c.total } });
    }
  }
  console.log("\n\nDEFENDERS + KEEPERS: mean predicted points by component, by team tier");
  console.log("tier      n   appear    cleanS   concede    saves   defCon    bonus  goals+A     total   actual     bias");
  console.log("-".repeat(112));
  for (let t = 0; t < 5; t += 1) {
    const list = rows.filter((r) => r.tier === t);
    if (!list.length) continue;
    const m = (k: string) => mean(list.map((r) => r.parts[k]));
    const act = mean(list.map((r) => r.actual));
    console.log(`${t + 1}    ${String(list.length).padStart(5)}   ${m("appearance").toFixed(3)}    ${m("cleanSheets").toFixed(3)}    ${m("goalsConceded").toFixed(3)}    ${m("saves").toFixed(3)}    ${m("defCon").toFixed(3)}    ${m("bonus").toFixed(3)}    ${m("goals").toFixed(3)}     ${m("total").toFixed(3)}    ${act.toFixed(3)}   ${(m("total") - act >= 0 ? "+" : "") + (m("total") - act).toFixed(3)}`);
  }
  // cluster the bias CI by fixture-equivalent: scale n down by players per fixture
  console.log("\ntier-1 defender bias with a fixture-clustered interval:");
  const t1 = rows.filter((r) => r.tier === 0);
  const errs = t1.map((r) => r.parts.total - r.actual);
  const [lo, hi] = bootCI(errs);
  console.log(`  naive (treats ${t1.length} player-rows as independent): +${mean(errs).toFixed(3)}  [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
  const perFixture = t1.length / cases.filter((c) => c.tier === 0).length;
  const widen = Math.sqrt(perFixture);
  console.log(`  ~${perFixture.toFixed(1)} defenders per team-fixture, so the honest interval is about sqrt(${perFixture.toFixed(1)}) = ${widen.toFixed(2)}x wider:`);
  console.log(`  clustered: +${mean(errs).toFixed(3)}  [${(mean(errs) - (mean(errs) - lo) * widen).toFixed(3)}, ${(mean(errs) + (hi - mean(errs)) * widen).toFixed(3)}]`);
}
main();
