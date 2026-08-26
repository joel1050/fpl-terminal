/**
 * How much of forward xP error is the minutes model?
 *
 * Every other script holds minutes at their actual value, which silently
 * assumes the minutes model is perfect. This swaps in a plain trailing-average
 * estimate to size what that assumption is hiding.
 */
import { loadSeason, strengthsBefore, formBefore, playerAt } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

function main(): void {
  const season = loadSeason();
  interface Row { position: string; actual: number; perfect: number; trailing: number; actualMinutes: number; estMinutes: number }
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
      const prior = (season.rowsByPlayer.get(r.historicalPlayerId) ?? []).filter((x) => x.gameweek < gw);
      if (prior.length < 3) continue;
      // A deliberately plain estimate: the player's recent average minutes,
      // recent five weighted double. No lineup data exists for this season.
      const recent = prior.slice(-5), older = prior.slice(0, -5);
      const est = (recent.reduce((s, x) => s + x.minutes, 0) * 2 + older.reduce((s, x) => s + x.minutes, 0))
        / (recent.length * 2 + older.length);
      const rates = playerRates(p, formBefore(season, r.historicalPlayerId, gw), gw);
      rows.push({
        position: p.position, actual: r.totalPoints, actualMinutes: r.minutes, estMinutes: est,
        perfect: expectedPoints(p, p.fixtures[0], r.minutes, rates, strengths, BASELINE).total,
        trailing: expectedPoints(p, p.fixtures[0], est, rates, strengths, BASELINE).total,
      });
    }
  }
  const rmse = (list: readonly Row[], pick: (r: Row) => number) =>
    Math.sqrt(mean(list.map((r) => (pick(r) - r.actual) ** 2)));
  console.log("RMSE against actual points, by what the model knows about minutes\n");
  console.log("group          n      perfect minutes   trailing average   cost of the minutes model");
  for (const p of ["all", "GK", "DEF", "MID", "FWD"]) {
    const list = p === "all" ? rows : rows.filter((r) => r.position === p);
    const a = rmse(list, (r) => r.perfect), b = rmse(list, (r) => r.trailing);
    console.log(`${p.padEnd(8)} ${String(list.length).padStart(6)}         ${a.toFixed(3)}              ${b.toFixed(3)}             +${(b - a).toFixed(3)}  (+${(100 * (b - a) / a).toFixed(1)}%)`);
  }
  const fwd = rows.filter((r) => r.position === "FWD");
  console.log(`\nforward minutes: mean actual ${mean(fwd.map((r) => r.actualMinutes)).toFixed(1)}`
    + `, mean estimate ${mean(fwd.map((r) => r.estMinutes)).toFixed(1)}`
    + `, mean absolute error ${mean(fwd.map((r) => Math.abs(r.estMinutes - r.actualMinutes))).toFixed(1)} minutes`);
  console.log(`for comparison, the whole section 7 fixture change moved all-row RMSE by 0.002.`);
}
main();
