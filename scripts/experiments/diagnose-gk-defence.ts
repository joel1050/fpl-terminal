/**
 * Diagnostic: does a team's leaky defence reach its goalkeeper's projection?
 *
 * Instruments every boundary the defensive signal crosses, for one team, using
 * the live pipeline rather than a reimplementation of it:
 *
 *   FPL preseason strength -> in-season xG blend -> Elo re-level -> fixture
 *   clean-sheet read -> goalkeeper components
 *
 * Prints the realized goals conceded alongside, so the model's read and the
 * league table can be compared directly.
 *
 *   npx tsx scripts/experiments/diagnose-gk-defence.ts CHE
 */
import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { loadHistoricalBundle } from "@/lib/historical/load";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { deriveTeamStrengths, enrichPlayersWithHistory } from "@/lib/historical/enrichPlayers";
import { loadInSeasonTeamXG, loadInSeasonPlayerRates, loadInSeasonStarts } from "@/lib/historical/loadInSeasonForm";
import { applyInSeasonForm } from "@/lib/historical/inSeasonForm";
import { deriveCleanSheetStrengths } from "@/lib/projections/cleanSheetStrength";
import { calculateFixtureAdjustment } from "@/lib/projections/fixtureAdjustment";
import { clubEloForFplShortName, CLUB_ELO_SNAPSHOT } from "@/lib/clubElo";

const target = (process.argv[2] ?? "CHE").toUpperCase();
const round = (value: number | undefined, places = 3) =>
  value === undefined ? "-" : value.toFixed(places);

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

  const team = normalized.teams.find((t) => t.shortName === target);
  if (!team) throw new Error(`no team ${target}; have ${normalized.teams.map((t) => t.shortName).join(" ")}`);
  const shortNameByTeamId = new Map(normalized.teams.map((t) => [t.id, t.shortName]));

  console.log(`\n=== ${team.name} (${target}), live gameweek ${normalized.liveGameweek} ===`);

  // --- Boundary 1: the preseason prior, straight from FPL's own strengths.
  const priors = deriveTeamStrengths(normalized.teams).strengths;
  const prior = priors[team.id];
  console.log(`\n1. preseason prior     attack ${round(prior.attackHome)}/${round(prior.attackAway)}  defence ${round(prior.defenceHome)}/${round(prior.defenceAway)}`);

  // --- Boundary 2: what this season has actually shown.
  const matches = inSeasonForm[team.id] ?? [];
  console.log(`\n2. in-season evidence  ${matches.length} matches`);
  for (const match of matches) {
    console.log(`   gw${String(match.gameweek ?? "?").padStart(2)}  ${match.wasHome ? "H" : "A"} vs ${shortNameByTeamId.get(match.opponentTeamId ?? -1) ?? "?"}   xG for ${round(match.xgFor, 2)}  xG against ${round(match.xgAgainst, 2)}`);
  }
  const xgAgainst = matches.length ? matches.reduce((s, m) => s + m.xgAgainst, 0) / matches.length : NaN;
  console.log(`   mean xG against ${round(xgAgainst, 2)} per match`);

  // --- Boundary 3: the blend. This is where the prior's weight is decided.
  const blended = applyInSeasonForm(priors, inSeasonForm);
  // Mirror the production call site: the level handover is driven by matches played.
  const played = new Map(Object.entries(inSeasonForm).map(([id, ms]) => [Number(id), ms.length]));
  const after = blended[team.id];
  const share = matches.length / (matches.length + 12);
  console.log(`\n3. after in-season fit attack ${round(after.attackHome)}  defence ${round(after.defenceHome)}`);
  console.log(`   nominal current-season share n/(n+12) = ${matches.length}/${matches.length + 12} = ${round(share, 3)}`);
  console.log(`   defence moved ${round(after.defenceHome - prior.defenceHome, 3)} from the prior`);

  console.log(`\n3b. how much does the prior weight cost? defence at other prior weights`);
  for (const priorWeight of [12, 6, 3, 1, 0.0001]) {
    const alt = applyInSeasonForm(priors, inSeasonForm, 0.9, priorWeight);
    const altCs = deriveCleanSheetStrengths(alt, shortNameByTeamId, undefined, played);
    const order = Object.entries(altCs)
      .map(([id, rates]) => ({ name: shortNameByTeamId.get(Number(id)) ?? id, defence: rates.defence }))
      .sort((a, b) => b.defence - a.defence);
    const rank = order.findIndex((r) => r.name === target) + 1;
    const label = priorWeight < 1 ? "no prior" : `n/(n+${priorWeight})`;
    const a = (alt[team.id].attackHome + alt[team.id].attackAway) / 2;
    const d = (alt[team.id].defenceHome + alt[team.id].defenceAway) / 2;
    console.log(`     ${label.padEnd(10)} share ${round(matches.length / (matches.length + priorWeight), 2)}  strength attack ${round(a)} defence ${round(d)}  lean ${round(Math.log(a) - Math.log(d), 3).padStart(6)}  -> clean-sheet defence ${round(altCs[team.id]?.defence)}  rank ${rank}/20`);
  }

  // --- Boundary 4: the Elo re-level the clean-sheet read actually uses.
  const csStrengths = deriveCleanSheetStrengths(blended, shortNameByTeamId, undefined, played);
  const cs = csStrengths[team.id];
  const elo = clubEloForFplShortName(target, CLUB_ELO_SNAPSHOT);
  console.log(`\n4. clean-sheet rates   attack ${round(cs?.attack)}  defence ${round(cs?.defence)}   (ClubElo ${elo?.elo ?? "unrated"})`);
  // Where does that defence rating come from? The level is Elo's, the lean is
  // this season's xG, and the skew weight keeps only 60% of the lean. Splitting
  // them says whether a leaky spell can move the number at all.
  const ratedElos = normalized.teams
    .map((t) => clubEloForFplShortName(t.shortName, CLUB_ELO_SNAPSHOT)?.elo)
    .filter((value): value is number => value !== undefined);
  const meanElo = ratedElos.reduce((sum, value) => sum + value, 0) / ratedElos.length;
  const level = 0.0034 * ((elo?.elo ?? meanElo) - meanElo);
  const rawSkew = Math.log((after.attackHome + after.attackAway) / 2) - Math.log((after.defenceHome + after.defenceAway) / 2);
  console.log(`   level from Elo ${round(level, 3)} (mean Elo ${round(meanElo, 1)})   lean from xG ${round(rawSkew, 3)} -> kept ${round(0.6 * rawSkew, 3)}`);
  const fitWeight = (played.get(team.id) ?? 0) / ((played.get(team.id) ?? 0) + 12);
  console.log(`   level handover to the in-season fit: ${round(fitWeight, 2)} at ${played.get(team.id) ?? 0} matches`);
  const eloOnly = deriveCleanSheetStrengths(blended, shortNameByTeamId);
  console.log(`   defence with the level on Elo alone ${round(eloOnly[team.id]?.defence)}  ->  with the handover ${round(cs?.defence)}`);

  const rated = Object.entries(csStrengths)
    .map(([id, rates]) => ({ name: shortNameByTeamId.get(Number(id)) ?? id, defence: rates.defence }))
    .sort((a, b) => b.defence - a.defence);
  console.log(`   defence rank ${rated.findIndex((r) => r.name === target) + 1}/${rated.length}: ${rated.map((r) => `${r.name} ${r.defence.toFixed(2)}`).join("  ")}`);

  // --- Boundary 5: the goalkeeper's own numbers.
  const enriched = enrichPlayersWithHistory(
    normalized.players, normalized.teams, normalized.events, historical,
    inSeasonForm, playerForm, startHistory, normalized.liveGameweek,
  );
  const keepers = enriched.players
    .filter((p) => p.position === "GK" && (p.projection?.nextGW ?? 0) > 0)
    .sort((a, b) => (b.projection?.nextGW ?? 0) - (a.projection?.nextGW ?? 0));
  console.log(`\n5. goalkeeper table (1GW xP)`);
  keepers.slice(0, 10).forEach((p, index) => {
    const fixture = p.fixtures.find((f) => f.gameweek === (normalized.liveGameweek ?? 0) + 1) ?? p.fixtures[0];
    const adjustment = fixture
      ? calculateFixtureAdjustment(fixture, {
          ownTeam: blended[p.teamId], opponentTeam: blended[fixture.opponentTeamId],
          ownCleanSheet: csStrengths[p.teamId], opponentCleanSheet: csStrengths[fixture.opponentTeamId],
        })
      : undefined;
    const mark = p.teamShortName === target ? " <<<" : "";
    console.log(`  ${String(index + 1).padStart(2)}. ${p.displayName.padEnd(22)} ${p.teamShortName}  xP ${round(p.projection?.nextGW, 2)}  CS% ${round(adjustment?.cleanSheetProbability, 3)}  xGA ${round(adjustment?.expectedGoalsAgainst, 2)}${mark}`);
  });
  // What actually drives the ranking? A leaky defence cuts clean sheets and
  // raises saves, and those pull in opposite directions for a goalkeeper.
  console.log(`\n5b. gameweek ${(normalized.liveGameweek ?? 0) + 1} component split, top goalkeepers`);
  console.log("     keeper                team  fixture  total   appear  cleanSh  concede  saves   bonus    read");
  for (const keeper of keepers.slice(0, 8)) {
    const rows = keeper.projection?.fixtures ?? [];
    const next = rows.find((f) => f.gameweek === (normalized.liveGameweek ?? 0) + 1) ?? rows[0];
    const c = next?.components;
    if (!c) continue;
    const f = next!.fixture;
    const adj = calculateFixtureAdjustment(f, {
      ownTeam: blended[keeper.teamId], opponentTeam: blended[f.opponentTeamId],
      ownCleanSheet: csStrengths[keeper.teamId], opponentCleanSheet: csStrengths[f.opponentTeamId],
    });
    const opponent = `${f.isHome ? "H" : "A"} ${shortNameByTeamId.get(f.opponentTeamId) ?? "?"}`;
    console.log(`     ${keeper.displayName.padEnd(21)} ${keeper.teamShortName.padEnd(5)} ${opponent.padEnd(7)} ${round(c.total, 2).padStart(6)}  ${round(c.appearance, 2).padStart(6)}  ${round(c.cleanSheets, 2).padStart(7)}  ${round(c.goalsConceded, 2).padStart(7)}  ${round(c.saves, 2).padStart(6)}  ${round(c.bonus, 2).padStart(5)}   CS% ${round(adj.cleanSheetProbability, 3)}  xGA ${round(adj.expectedGoalsAgainst, 2)}`);
  }

  console.log(`\n5c. does the headline match the fixtures it is built from?`);
  for (const keeper of keepers.slice(0, 6)) {
    const projection = keeper.projection;
    const rows = projection?.fixtures ?? [];
    const sumNext = rows.filter((f) => f.gameweek === rows[0]?.gameweek)
      .reduce((sum, f) => sum + (f.components?.total ?? f.expectedPoints ?? 0), 0);
    console.log(`     ${keeper.displayName.padEnd(21)} nextGW ${round(projection?.nextGW, 2)}  sum of gw${rows[0]?.gameweek} rows ${round(sumNext, 2)}  rows ${rows.length}  gws [${rows.map((f) => f.gameweek).join(",")}]`);
    for (const row of rows.slice(0, 3)) {
      console.log(`        gw${row.gameweek} ${row.fixture.isHome ? "H" : "A"} vs ${shortNameByTeamId.get(row.fixture.opponentTeamId)}  expectedPoints ${round(row.expectedPoints, 2)}  components.total ${round(row.components?.total, 2)}`);
    }
  }

  const own = keepers.filter((p) => p.teamShortName === target);
  for (const keeper of own) {
    console.log(`\n   ${keeper.displayName}: rank ${keepers.indexOf(keeper) + 1}/${keepers.length} by 1GW xP ${round(keeper.projection?.nextGW, 2)}, expected minutes ${round(keeper.projection?.expectedMinutes, 0)}`);
    const fixture = keeper.fixtures.find((f) => f.gameweek === (normalized.liveGameweek ?? 0) + 1) ?? keeper.fixtures[0];
    if (fixture) {
      const adjustment = calculateFixtureAdjustment(fixture, {
        ownTeam: blended[keeper.teamId], opponentTeam: blended[fixture.opponentTeamId],
        ownCleanSheet: csStrengths[keeper.teamId], opponentCleanSheet: csStrengths[fixture.opponentTeamId],
      });
      console.log(`     next fixture ${fixture.isHome ? "H" : "A"} vs ${shortNameByTeamId.get(fixture.opponentTeamId)}  CS% ${round(adjustment.cleanSheetProbability, 3)}  xGA ${round(adjustment.expectedGoalsAgainst, 2)}`);
    }
  }

  // Realized goals conceded, so the model's read can be set against the table.
  const conceded = normalized.fixtures
    .filter((f) => f.finished && (f.teamHomeId === team.id || f.teamAwayId === team.id))
    .map((f) => (f.teamHomeId === team.id ? f.awayScore : f.homeScore) ?? 0);
  console.log(`\n6. realized           goals conceded ${conceded.join(", ")} = ${conceded.reduce((s, v) => s + v, 0)} in ${conceded.length} matches`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
