/**
 * Does the level bias survive a real per-player anchor?
 *
 * The other scripts have no previous season, so `basePrior` falls back to the
 * position prior and every player is dragged toward the pool average. This
 * mimics production instead: for gameweeks 20-38, a player's own gameweek 1-19
 * record plays the part of "last season". If the bias collapses, it was the
 * harness. If it survives, it is the model.
 */
import type { HistoricalStats, Player } from "@/types/player";
import { loadSeason, strengthsBefore, formBefore, playerAt, type Season } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";

const FIRST = 20;
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

/** The player's own gameweek 1-19 record, shaped as a previous-season anchor. */
function firstHalf(season: Season, playerId: number): HistoricalStats | undefined {
  const rows = (season.rowsByPlayer.get(playerId) ?? []).filter((r) => r.gameweek < FIRST);
  const minutes = rows.reduce((s, r) => s + r.minutes, 0);
  if (minutes <= 0) return undefined;
  const stats = season.players.get(playerId)!.stats;
  // saves and defensive contributions exist only as season totals; scale them to
  // this window so their per-90 rate is unchanged and they stay neutral here.
  const scale = stats.minutes > 0 ? minutes / stats.minutes : 0;
  return {
    season: "first-half",
    minutes,
    expectedGoals: rows.reduce((s, r) => s + (r.expectedGoals ?? 0), 0),
    expectedAssists: rows.reduce((s, r) => s + (r.expectedAssists ?? 0), 0),
    bonus: rows.reduce((s, r) => s + (r.bonus ?? 0), 0),
    saves: (stats.saves ?? 0) * scale,
    defensiveContribution: (stats.defensiveContribution ?? 0) * scale,
  };
}

function main(): void {
  const season = loadSeason();
  interface Row { position: string; minutes: number; actual: number; noAnchor: number; anchored: number; seasonXg: number }
  const rows: Row[] = [];

  for (let gw = FIRST; gw <= 38; gw += 1) {
    const strengths = strengthsBefore(season, gw);
    const byId = new Map((season.fixturesByGameweek.get(gw) ?? []).map((f) => [f.fixtureId, f]));
    for (const r of season.rowsByGameweek.get(gw) ?? []) {
      if (r.minutes <= 0) continue;
      const fx = byId.get(r.fixtureId);
      if (!fx) continue;
      const base = playerAt(season, r.historicalPlayerId, gw, fx, r.wasHome);
      if (!base) continue;
      const form = formBefore(season, r.historicalPlayerId, gw);
      const anchor = firstHalf(season, r.historicalPlayerId);
      if (!anchor) continue;
      const withAnchor: Player = { ...base, historical: anchor };
      const st = season.players.get(r.historicalPlayerId)!.stats;
      rows.push({
        position: base.position, minutes: r.minutes, actual: r.totalPoints,
        noAnchor: expectedPoints(withAnchor, withAnchor.fixtures[0], r.minutes, playerRates(withAnchor, form, gw), strengths, BASELINE, true, false).total,
        anchored: expectedPoints(withAnchor, withAnchor.fixtures[0], r.minutes, playerRates(withAnchor, form, gw), strengths, BASELINE, true, true).total,
        seasonXg: st.minutes > 0 ? (((st.expectedGoals ?? 0) + (st.expectedAssists ?? 0)) / st.minutes) * 90 : 0,
      });
    }
  }

  const show = (label: string, list: readonly Row[]) => {
    if (!list.length) return;
    const act = mean(list.map((r) => r.actual));
    const b1 = mean(list.map((r) => r.noAnchor - r.actual));
    const b2 = mean(list.map((r) => r.anchored - r.actual));
    const rm = (pick: (r: Row) => number) => Math.sqrt(mean(list.map((r) => (pick(r) - r.actual) ** 2)));
    console.log(`${label.padEnd(24)} n=${String(list.length).padStart(5)}  actual ${act.toFixed(3)}`
      + `   bias no-cards ${b1 >= 0 ? "+" : ""}${b1.toFixed(3)}  cards ${b2 >= 0 ? "+" : ""}${b2.toFixed(3)}`
      + `   RMSE ${rm((r) => r.noAnchor).toFixed(3)} -> ${rm((r) => r.anchored).toFixed(3)}`);
  };

  console.log(`gameweeks ${FIRST}-38, anchored on the player's own gameweeks 1-19; comparing cards off vs on\n`);
  show("all", rows);
  for (const p of ["GK", "DEF", "MID", "FWD"]) show(p, rows.filter((r) => r.position === p));
  console.log();
  show("FWD started (60+)", rows.filter((r) => r.position === "FWD" && r.minutes >= 60));
  show("MID started (60+)", rows.filter((r) => r.position === "MID" && r.minutes >= 60));

  console.log("\nattackers by their own season xGI/90 - does the anchor fix the fan-out?");
  const att = rows.filter((r) => r.position === "MID" || r.position === "FWD").sort((a, b) => a.seasonXg - b.seasonXg);
  const q = Math.floor(att.length / 5);
  for (let i = 0; i < 5; i += 1) {
    const s = att.slice(i * q, i === 4 ? att.length : (i + 1) * q);
    show(`  xGI/90 ${s[0].seasonXg.toFixed(2)}-${s[s.length - 1].seasonXg.toFixed(2)}`, s);
  }
}
main();
