/**
 * The saves blend weight swept against live data, with one keeper's rank.
 *
 * `scripts/backtest/results/saves-weight.md` measured this constant over 3,002
 * goalkeeper appearances and found the shipped 6 already optimal - flat from 6
 * to 15, both ends resolved against. This script answers the different question
 * of what each value would do to today's table, so the two can be read
 * together: an arm that moves a keeper a long way is not thereby a better arm.
 *
 *   npx tsx scripts/experiments/sweep-gk-saves-weight.ts "Martinez" CHE
 */
import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { loadHistoricalBundle } from "@/lib/historical/load";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { enrichPlayersWithHistory } from "@/lib/historical/enrichPlayers";
import { loadInSeasonTeamXG, loadInSeasonPlayerRates, loadInSeasonStarts } from "@/lib/historical/loadInSeasonForm";
import { PLAYER_FORM_PRIOR_WEIGHT_MATCHES } from "@/lib/projections/playerForm";
import type { Player } from "@/types/player";

const targetName = process.argv[2] ?? "Martinez";
const targetTeam = (process.argv[3] ?? "CHE").toUpperCase();
const WEIGHTS = [2, 4, 6, 10, 15, 20, 30, 45, 60, 1e9];
const r = (v: number | undefined, places = 2) => (v === undefined ? "-" : v.toFixed(places));

async function main(): Promise<void> {
  const [bootstrap, fixtures] = await Promise.all([getBootstrap({}), getFixtures({})]);
  if (!bootstrap.data) throw new Error("no bootstrap payload");
  const normalized = normalizeBootstrap(bootstrap.data, fixtures.data ?? []);
  const historical = await loadHistoricalBundle();
  const [inSeasonForm, playerForm, startHistory] = await Promise.all([
    loadInSeasonTeamXG(normalized.players, normalized.fixtures),
    loadInSeasonPlayerRates(normalized.players, normalized.fixtures),
    loadInSeasonStarts(normalized.players, normalized.fixtures),
  ]);

  const run = (savesPriorWeight?: number) => {
    const enriched = enrichPlayersWithHistory(
      normalized.players, normalized.teams, normalized.events, historical,
      inSeasonForm, playerForm, startHistory, normalized.liveGameweek,
      savesPriorWeight === undefined ? undefined : { savesPriorWeight },
    );
    return enriched.players.filter((p) => p.position === "GK");
  };

  // Passing the shipped constant explicitly must reproduce passing nothing, or
  // the sweep is measuring the plumbing rather than the constant.
  const shipped = run();
  const explicit = run(PLAYER_FORM_PRIOR_WEIGHT_MATCHES);
  const byId = new Map(explicit.map((p) => [p.id, p]));
  for (const p of shipped) {
    const other = byId.get(p.id);
    if (Math.abs((p.projection?.next10 ?? 0) - (other?.projection?.next10 ?? 0)) > 1e-9) {
      throw new Error(`explicit shipped weight does not reproduce the default for ${p.displayName}`);
    }
  }

  const table = (keepers: readonly Player[], field: "nextGW" | "next5" | "next10") =>
    [...keepers].filter((p) => (p.projection?.[field] ?? 0) > 0)
      .sort((a, b) => (b.projection?.[field] ?? 0) - (a.projection?.[field] ?? 0));

  for (const field of ["nextGW", "next5", "next10"] as const) {
    console.log(`\n=== ${targetName} (${targetTeam}) by ${field}, across the saves blend weight ===`);
    console.log("  arm            share@2m  xP      rank   leader                 gap to leader");
    for (const k of WEIGHTS) {
      const keepers = run(k);
      const ranked = table(keepers, field);
      const target = ranked.find((p) => p.displayName === targetName && p.teamShortName === targetTeam);
      if (!target) { console.log(`  n/(n+${k}) - ${targetName} not projected`); continue; }
      const rank = ranked.indexOf(target) + 1;
      const leader = ranked[0];
      const gap = (target.projection?.[field] ?? 0) - (leader.projection?.[field] ?? 0);
      const label = k >= 1e9 ? "no current" : `n/(n+${k})`;
      const share = k >= 1e9 ? 0 : 2 / (2 + k);
      const mark = k === PLAYER_FORM_PRIOR_WEIGHT_MATCHES ? "  <- shipped" : "";
      console.log(`  ${label.padEnd(14)} ${r(share, 3).padStart(7)}  ${r(target.projection?.[field]).padStart(6)}  ${String(rank).padStart(3)}/${ranked.length}  ${`${leader.displayName} (${leader.teamShortName})`.padEnd(22)} ${r(gap).padStart(6)}${mark}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
