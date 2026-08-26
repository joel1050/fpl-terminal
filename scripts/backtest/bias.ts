/** Where section 8 is systematically high or low, walk-forward over 2025/26. */
import { loadSeason, strengthsBefore, formBefore, playerAt } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";

function main(): void {
  const season = loadSeason();
  interface Row { position: string; minutes: number; actual: number; pred: number; priorMatches: number; seasonXgiPer90: number; parts: Record<string, number> }
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
      const form = formBefore(season, r.historicalPlayerId, gw);
      const c = expectedPoints(p, p.fixtures[0], r.minutes,
        playerRates(p, form, gw), strengths, BASELINE);
      rows.push({
        position: p.position, minutes: r.minutes, actual: r.totalPoints, pred: c.total, priorMatches: form.length,
        seasonXgiPer90: (() => {
          const st = season.players.get(r.historicalPlayerId)!.stats;
          return st.minutes > 0 ? (((st.expectedGoals ?? 0) + (st.expectedAssists ?? 0)) / st.minutes) * 90 : 0;
        })(),
        parts: { appearance: c.appearance, goals: c.goals, assists: c.assists, cleanSheets: c.cleanSheets,
                 goalsConceded: c.goalsConceded, saves: c.saves, defCon: c.defensiveContribution, bonus: c.bonus },
      });
    }
  }
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const show = (label: string, list: Row[]) => {
    if (!list.length) return;
    const pred = mean(list.map((r) => r.pred)), act = mean(list.map((r) => r.actual));
    console.log(`${label.padEnd(22)} n=${String(list.length).padStart(5)}  predicted ${pred.toFixed(3)}  actual ${act.toFixed(3)}  bias ${pred - act >= 0 ? "+" : ""}${(pred - act).toFixed(3)}`);
  };
  console.log("SECTION 8 BIAS - mean expected points vs mean actual, per appearance\n");
  show("all played rows", rows);
  for (const pos of ["GK", "DEF", "MID", "FWD"]) show(pos, rows.filter((r) => r.position === pos));
  console.log();
  show("started (60+ min)", rows.filter((r) => r.minutes >= 60));
  show("cameo (<60 min)", rows.filter((r) => r.minutes < 60));

  // Does the bias shrink as a player's own in-season sample grows? If it does,
  // it is the position prior doing the damage, not the scoring rules.
  console.log("\nMID bias by size of the player's own prior match history:");
  for (const [label, lo, hi] of [["1-4 matches", 1, 4], ["5-9", 5, 9], ["10-19", 10, 19], ["20+", 20, 99]] as const) {
    const list = rows.filter((r) => r.position === "MID" && r.priorMatches >= lo && r.priorMatches <= hi);
    show(`  ${label}`, list);
  }
  console.log("\nsame, high-minutes regulars only (60+ min this match):");
  for (const [label, lo, hi] of [["1-4 matches", 1, 4], ["5-9", 5, 9], ["10-19", 10, 19], ["20+", 20, 99]] as const) {
    const list = rows.filter((r) => r.position === "MID" && r.minutes >= 60 && r.priorMatches >= lo && r.priorMatches <= hi);
    show(`  ${label}`, list);
  }

  // Decisive test. If a missing scoring term (cards) drives the bias, it is
  // roughly constant across output levels. If the prior pulling everyone toward
  // the pool mean drives it, low-output players are inflated and high-output
  // players are deflated, and the mean is positive only because the pool is skewed.
  console.log("\nbias by the player's own actual season xGI per 90 (MID + FWD):");
  const attackers = rows.filter((r) => r.position === "MID" || r.position === "FWD");
  const sorted = [...attackers].sort((a, b) => a.seasonXgiPer90 - b.seasonXgiPer90);
  const q = Math.floor(sorted.length / 5);
  for (let i = 0; i < 5; i += 1) {
    const slice = sorted.slice(i * q, i === 4 ? sorted.length : (i + 1) * q);
    const lo = slice[0].seasonXgiPer90.toFixed(2), hi = slice[slice.length - 1].seasonXgiPer90.toFixed(2);
    show(`  xGI/90 ${lo}-${hi}`, slice);
  }

  console.log("\nmean predicted points by component, per appearance:");
  const keys = Object.keys(rows[0].parts);
  console.log("position  " + keys.map((k) => k.padStart(13)).join(""));
  for (const pos of ["GK", "DEF", "MID", "FWD"]) {
    const list = rows.filter((r) => r.position === pos);
    console.log(pos.padEnd(10) + keys.map((k) => mean(list.map((r) => r.parts[k])).toFixed(3).padStart(13)).join(""));
  }
}
main();
