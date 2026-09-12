/**
 * Why does one goalkeeper lead the 5- and 10-gameweek projections?
 *
 * Over one gameweek a soft fixture explains a lot. Over five and ten it should
 * not, so this sums each keeper's components across the horizon and puts the
 * fixture run beside them. It also prints the two rates that drive a keeper -
 * saves and clean sheets - as the model sees them, because those two are
 * supposed to disagree: a keeper facing a barrage should not also be keeping
 * clean sheets.
 *
 *   npx tsx scripts/experiments/diagnose-gk-horizon.ts CHE
 */
import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { loadHistoricalBundle } from "@/lib/historical/load";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { enrichPlayersWithHistory } from "@/lib/historical/enrichPlayers";
import { loadInSeasonTeamXG, loadInSeasonPlayerRates, loadInSeasonStarts } from "@/lib/historical/loadInSeasonForm";
import type { ProjectionComponents } from "@/types/projection";
import { expectedFloorDivision } from "@/lib/projections/distributions";
import { calculateFixtureAdjustment } from "@/lib/projections/fixtureAdjustment";
import { deriveCleanSheetStrengths } from "@/lib/projections/cleanSheetStrength";
import { deriveTeamStrengths } from "@/lib/historical/enrichPlayers";
import { applyInSeasonForm } from "@/lib/historical/inSeasonForm";

/**
 * Saves points are `E[floor(S / 3)]` for a Poisson S, so the shots-on-target
 * figure behind a component can be recovered by inverting it. Monotonic in the
 * mean, so a bisection is exact enough to compare keepers.
 */
function impliedSaves(points: number): number {
  let low = 0;
  let high = 20;
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    if (expectedFloorDivision(mid, 3) < points) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

const target = (process.argv[2] ?? "CHE").toUpperCase();
const r = (value: number | undefined, places = 2) => (value === undefined ? "-" : value.toFixed(places));

const KEYS: (keyof ProjectionComponents)[] = [
  "appearance", "cleanSheets", "goalsConceded", "saves", "bonus", "goals", "assists", "cards",
];

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
  const shortNameByTeamId = new Map(normalized.teams.map((t) => [t.id, t.shortName]));
  const enriched = enrichPlayersWithHistory(
    normalized.players, normalized.teams, normalized.events, historical,
    inSeasonForm, playerForm, startHistory, normalized.liveGameweek,
  );

  const keepers = enriched.players
    .filter((p) => p.position === "GK" && (p.projection?.next5 ?? 0) > 0)
    .sort((a, b) => (b.projection?.next5 ?? 0) - (a.projection?.next5 ?? 0));

  for (const horizon of [5, 10] as const) {
    const field = horizon === 5 ? "next5" : "next10";
    const ranked = [...keepers].sort((a, b) => (b.projection?.[field] ?? 0) - (a.projection?.[field] ?? 0));
    console.log(`\n=== top goalkeepers by ${field} ===`);
    console.log("  keeper                team   total   appear  cleanSh  concede  saves   bonus   fixtures");
    for (const p of ranked.slice(0, 8)) {
      const rows = (p.projection?.fixtures ?? [])
        .filter((f) => f.gameweek > (normalized.liveGameweek ?? 0))
        .slice(0, horizon);
      const sum = (key: keyof ProjectionComponents) =>
        rows.reduce((total, row) => total + ((row.components?.[key] as number) ?? 0), 0);
      const run = rows.map((row) => `${row.fixture.isHome ? "" : "@"}${shortNameByTeamId.get(row.fixture.opponentTeamId) ?? "?"}`).join(" ");
      console.log(`  ${p.displayName.padEnd(21)} ${p.teamShortName.padEnd(5)} ${r(p.projection?.[field]).padStart(6)}  ${r(sum("appearance")).padStart(6)}  ${r(sum("cleanSheets")).padStart(7)}  ${r(sum("goalsConceded")).padStart(7)}  ${r(sum("saves")).padStart(6)}  ${r(sum("bonus")).padStart(5)}   ${run}`);
    }
  }

  // The two rates that ought to contradict each other.
  console.log(`\n=== per-90 rates behind the keepers, as the model reads them ===`);
  console.log("  keeper                team   hist mins  hist saves/90  season mins  season saves/90  hist bonus/90");
  for (const p of keepers.slice(0, 8)) {
    const h = p.historical;
    const histPer90 = h && h.minutes > 0 ? ((h.saves ?? 0) / h.minutes) * 90 : undefined;
    const bonusPer90 = h && h.minutes > 0 ? ((h.bonus ?? 0) / h.minutes) * 90 : undefined;
    const cur = p.current;
    const source = normalized.players.find((q) => q.id === p.id);
    const seasonSaves = (source as unknown as { current?: { saves?: number } })?.current?.saves;
    const curPer90 = cur.minutes > 0 && seasonSaves !== undefined ? (seasonSaves / cur.minutes) * 90 : undefined;
    console.log(`  ${p.displayName.padEnd(21)} ${p.teamShortName.padEnd(5)} ${String(h?.minutes ?? "-").padStart(9)}  ${r(histPer90).padStart(13)}  ${String(cur.minutes).padStart(11)}  ${r(curPer90).padStart(15)}  ${r(bonusPer90).padStart(13)}`);
  }

  // Internal consistency. Saves and goals conceded are two views of the same
  // shot volume: a keeper cannot face a barrage and concede almost nothing
  // unless his save percentage is superhuman. If one keeper's implied save
  // percentage sits far outside the field, the two halves disagree about him.
  console.log(`\n=== implied save percentage, gameweek ${(normalized.liveGameweek ?? 0) + 1} ===`);
  const priors = deriveTeamStrengths(normalized.teams).strengths;
  const blended = applyInSeasonForm(priors, inSeasonForm);
  const played = new Map(Object.entries(inSeasonForm).map(([id, ms]) => [Number(id), ms.length]));
  const csStrengths = deriveCleanSheetStrengths(blended, shortNameByTeamId, undefined, played);
  console.log("  keeper                team   savePts  impliedSoT  xGA    shots faced  implied save%");
  for (const p of keepers.slice(0, 8)) {
    const row = (p.projection?.fixtures ?? []).find((f) => f.gameweek === (normalized.liveGameweek ?? 0) + 1);
    if (!row?.components) continue;
    const f = row.fixture;
    const adj = calculateFixtureAdjustment(f, {
      ownTeam: blended[p.teamId], opponentTeam: blended[f.opponentTeamId],
      ownCleanSheet: csStrengths[p.teamId], opponentCleanSheet: csStrengths[f.opponentTeamId],
    });
    const saves = impliedSaves(row.components.saves);
    const faced = saves + adj.expectedGoalsAgainst;
    console.log(`  ${p.displayName.padEnd(21)} ${p.teamShortName.padEnd(5)} ${r(row.components.saves).padStart(7)}  ${r(saves).padStart(10)}  ${r(adj.expectedGoalsAgainst).padStart(5)}  ${r(faced).padStart(11)}  ${r(100 * saves / faced, 1).padStart(13)}%`);
  }

  const own = keepers.filter((p) => p.teamShortName === target);
  for (const keeper of own.slice(0, 1)) {
    console.log(`\n=== ${keeper.displayName} gameweek by gameweek ===`);
    console.log("  gw  fixture   xMin   total   cleanSh  concede  saves");
    for (const row of (keeper.projection?.fixtures ?? []).filter((f) => f.gameweek > (normalized.liveGameweek ?? 0)).slice(0, 10)) {
      const c = row.components;
      console.log(`  ${String(row.gameweek).padStart(2)}  ${(row.fixture.isHome ? "" : "@") + (shortNameByTeamId.get(row.fixture.opponentTeamId) ?? "?")}`.padEnd(14)
        + `${r(row.expectedMinutes, 0).padStart(5)}  ${r(c?.total).padStart(6)}  ${r(c?.cleanSheets).padStart(7)}  ${r(c?.goalsConceded).padStart(7)}  ${r(c?.saves).padStart(6)}`);
    }
    void KEYS;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
