/**
 * What the coherent-saves reparameterisation would do to today's table.
 *
 * `scripts/backtest/results/coherent-saves.md` measured the change over 3,002
 * goalkeeper appearances and rejected it: saves RMSE is worse at every kappa
 * with the pooled interval excluding zero. This script answers the different
 * question of where each kappa would move today's keepers, so the two can be
 * read together: an arm that moves a keeper a long way is not thereby a
 * better arm.
 *
 *   npx tsx scripts/experiments/sweep-gk-save-percentage.ts "Martinez" CHE
 */
import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { loadHistoricalBundle } from "@/lib/historical/load";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { enrichPlayersWithHistory } from "@/lib/historical/enrichPlayers";
import { loadInSeasonTeamXG, loadInSeasonPlayerRates, loadInSeasonStarts } from "@/lib/historical/loadInSeasonForm";
import { keeperSavePercentage } from "@/lib/projections/projectPlayer";
import type { Player } from "@/types/player";

const targetName = process.argv[2] ?? "Martinez";
const targetTeam = (process.argv[3] ?? "CHE").toUpperCase();
const KAPPAS = [20, 50, 100, 200, 500, Number.POSITIVE_INFINITY];
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

  const run = (kappa?: number) => {
    const enriched = enrichPlayersWithHistory(
      normalized.players, normalized.teams, normalized.events, historical,
      inSeasonForm, playerForm, startHistory, normalized.liveGameweek,
      kappa === undefined ? undefined : { savePercentageKappa: kappa },
    );
    return enriched.players.filter((p) => p.position === "GK");
  };

  // Omitting the override must reproduce passing nothing, or the sweep is
  // measuring the plumbing rather than the constant.
  const shipped = run();
  const explicit = run(undefined);
  const byId = new Map(explicit.map((p) => [p.id, p]));
  for (const p of shipped) {
    const other = byId.get(p.id);
    if (Math.abs((p.projection?.next10 ?? 0) - (other?.projection?.next10 ?? 0)) > 1e-9) {
      throw new Error(`omitted kappa does not reproduce the default for ${p.displayName}`);
    }
  }

  // League rate behind the kappa prior, from the same bundle evidence
  // (goalkeepers only - outfield conceded totals would crush the rate).
  let saves = 0;
  let shots = 0;
  for (const p of historical?.players ?? []) {
    if (p.position !== "GK") continue;
    const s = p.stats.saves ?? 0;
    const c = p.stats.goalsConceded ?? 0;
    saves += s;
    shots += s + c;
  }
  const leagueRate = shots > 0 ? saves / shots : Number.NaN;
  console.log(`league save percentage behind the prior: ${r(leagueRate, 4)}`);

  const table = (keepers: readonly Player[], field: "nextGW" | "next5" | "next10") =>
    [...keepers].filter((p) => (p.projection?.[field] ?? 0) > 0)
      .sort((a, b) => (b.projection?.[field] ?? 0) - (a.projection?.[field] ?? 0));

  for (const field of ["nextGW", "next5", "next10"] as const) {
    console.log(`\n=== ${targetName} (${targetTeam}) by ${field}, shipped vs coherent kappa ===`);
    console.log("  arm                xP      rank   leader                 gap    implSave%sd  martinez p");
    const rows: { label: string; keepers: Player[] }[] = [
      { label: "shipped", keepers: [...shipped] },
      ...KAPPAS.map((k) => ({
        label: Number.isFinite(k) ? `k=${k}` : "k=Inf",
        keepers: run(k),
      })),
    ];
    for (const { label, keepers } of rows) {
      const ranked = table(keepers, field);
      const target = ranked.find((p) => p.displayName === targetName && p.teamShortName === targetTeam);
      const leader = ranked[0];
      const kappa = label === "shipped" ? undefined
        : label === "k=Inf" ? Number.POSITIVE_INFINITY : Number(label.slice(2));
      const ps = Number.isFinite(leagueRate) && kappa !== undefined
        ? ranked.map((p) => keeperSavePercentage(p, kappa, leagueRate))
        : null;
      const spread = ps ? Math.sqrt(ps.reduce((s, v) => s + (v - ps.reduce((a, b) => a + b, 0) / ps.length) ** 2, 0) / ps.length) : null;
      const targetP = target && kappa !== undefined && Number.isFinite(leagueRate)
        ? keeperSavePercentage(target, kappa, leagueRate)
        : undefined;
      if (!target) { console.log(`  ${label.padEnd(18)} - ${targetName} not projected`); continue; }
      const rank = ranked.indexOf(target) + 1;
      const gap = (target.projection?.[field] ?? 0) - (leader.projection?.[field] ?? 0);
      const mark = label === "shipped" ? "  <- shipped" : "";
      console.log(`  ${label.padEnd(18)} ${r(target.projection?.[field]).padStart(6)}  ${String(rank).padStart(3)}/${ranked.length}  ${`${leader.displayName} (${leader.teamShortName})`.padEnd(22)} ${r(gap).padStart(6)}  ${spread === null ? "      -" : spread.toFixed(4).padStart(7)}  ${r(targetP, 3)}${mark}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
