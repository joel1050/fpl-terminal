/**
 * Ablation: what actually puts one goalkeeper on top of the 10-gameweek table?
 *
 * The component split says the whole lead is saves, so this re-runs the real
 * pipeline with one input changed at a time and reprints the table. Each arm is
 * a counterfactual about a specific mechanism, so whichever one moves the
 * ranking is the mechanism responsible.
 *
 *   npx tsx scripts/experiments/ablate-gk-saves.ts
 */
import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { loadHistoricalBundle } from "@/lib/historical/load";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { enrichPlayersWithHistory } from "@/lib/historical/enrichPlayers";
import { loadInSeasonTeamXG, loadInSeasonPlayerRates, loadInSeasonStarts } from "@/lib/historical/loadInSeasonForm";
import type { Player } from "@/types/player";

const r = (value: number | undefined, places = 2) => (value === undefined ? "-" : value.toFixed(places));

type Bundle = Awaited<ReturnType<typeof loadHistoricalBundle>>;
type Arm = {
  name: string;
  players: (players: readonly Player[]) => Player[];
  /**
   * `enrichPlayersWithHistory` rebuilds `historical` from the bundle, so a
   * historical arm has to change the bundle. Editing the player would be
   * silently overwritten - as a first cut of this script was.
   */
  bundle?: (bundle: Bundle) => Bundle;
};

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

  const keep = (players: readonly Player[]) => players.map((p) => ({ ...p }));

  const ARMS: Arm[] = [
    { name: "shipped", players: keep },
    {
      // Drops this season's save counts, so a keeper's save rate is his
      // previous-season rate regressed toward the position prior and nothing
      // else. Isolates what three matches of save data are doing.
      name: "no current-season saves",
      players: (players) => players.map((p) => (p.position === "GK"
        ? { ...p, current: { ...p.current, saves: undefined } as Player["current"] }
        : { ...p })),
    },
    {
      // Drops the previous season instead, isolating the historical anchor.
      name: "no historical saves",
      players: keep,
      bundle: (bundle) => bundle && {
        ...bundle,
        players: bundle.players.map((hp) => (hp.position === "GK"
          ? { ...hp, stats: { ...hp.stats, saves: undefined } }
          : hp)),
      },
    },
    {
      // Both, so the rate is the bare position prior for every keeper. Shows
      // how much of the table is save evidence of any kind.
      name: "no save evidence at all",
      players: (players) => players.map((p) => (p.position === "GK"
        ? { ...p, current: { ...p.current, saves: undefined } as Player["current"] }
        : { ...p })),
      bundle: (bundle) => bundle && {
        ...bundle,
        players: bundle.players.map((hp) => (hp.position === "GK"
          ? { ...hp, stats: { ...hp.stats, saves: undefined } }
          : hp)),
      },
    },
  ];

  for (const arm of ARMS) {
    const enriched = enrichPlayersWithHistory(
      arm.players(normalized.players), normalized.teams, normalized.events,
      arm.bundle && historical ? arm.bundle(historical) : historical,
      inSeasonForm, playerForm, startHistory, normalized.liveGameweek,
    );
    const keepers = enriched.players
      .filter((p) => p.position === "GK" && (p.projection?.next10 ?? 0) > 0)
      .sort((a, b) => (b.projection?.next10 ?? 0) - (a.projection?.next10 ?? 0));
    console.log(`\n=== ${arm.name}: top goalkeepers by next10 ===`);
    keepers.slice(0, 6).forEach((p, index) => {
      const rows = (p.projection?.fixtures ?? [])
        .filter((f) => f.gameweek > (normalized.liveGameweek ?? 0)).slice(0, 10);
      const saves = rows.reduce((total, row) => total + (row.components?.saves ?? 0), 0);
      console.log(`  ${index + 1}. ${p.displayName.padEnd(21)} ${p.teamShortName.padEnd(5)} next10 ${r(p.projection?.next10).padStart(6)}   saves ${r(saves).padStart(5)}`);
    });
    const martinez = keepers.find((p) => p.displayName === "Martinez" && p.teamShortName === "CHE");
    if (martinez) {
      console.log(`  -> Martinez rank ${keepers.indexOf(martinez) + 1}/${keepers.length}, next10 ${r(martinez.projection?.next10)}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
