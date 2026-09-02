/**
 * Hard gate. Runs the harness at BASELINE against the real projectPlayer() over
 * every scored row of the season. If these disagree, no arm difference means
 * anything, so this exits non-zero rather than reporting a number.
 */
import { projectPlayer } from "@/lib/projections/projectPlayer";
import { loadSeason, strengthsBefore, formBefore, playerAt } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";

const FIRST_GAMEWEEK = 6;

function main(): void {
  const season = loadSeason();
  let compared = 0;
  let worstTotal = 0;
  let worstComponent = 0;
  let worstLabel = "";

  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(season, gameweek);
    const fixtureById = new Map((season.fixturesByGameweek.get(gameweek) ?? []).map((f) => [f.fixtureId, f]));
    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = fixtureById.get(row.fixtureId);
      if (!fixture) continue;
      const player = playerAt(season, row.historicalPlayerId, gameweek, fixture, row.wasHome);
      if (!player) continue;
      const form = formBefore(season, row.historicalPlayerId, gameweek);

      const real = projectPlayer(player, {
        currentGameweek: gameweek,
        horizon: 1,
        teamStrengths: strengths,
        playerForm: { [player.id]: form },
        expectedMinutes: row.minutes,
      });
      const realComponents = real.fixtures[0]?.components;
      if (!realComponents) continue;

      const mine = expectedPoints(
        player, player.fixtures[0], row.minutes,
        playerRates(player, form, gameweek, undefined, strengths), strengths, BASELINE,
      );

      compared += 1;
      const totalGap = Math.abs(mine.total - realComponents.total);
      if (totalGap > worstTotal) { worstTotal = totalGap; worstLabel = `${player.displayName} gw${gameweek}`; }
      for (const key of Object.keys(mine) as (keyof typeof mine)[]) {
        worstComponent = Math.max(worstComponent, Math.abs(mine[key] - realComponents[key]));
      }
    }
  }

  console.log(`rows compared          ${compared.toLocaleString()}`);
  console.log(`worst total gap        ${worstTotal.toExponential(3)}   (${worstLabel})`);
  console.log(`worst component gap    ${worstComponent.toExponential(3)}`);

  const tolerance = 1e-9;
  if (compared === 0) { console.error("\nFAIL: nothing compared"); process.exit(1); }
  if (worstTotal > tolerance || worstComponent > tolerance) {
    console.error(`\nFAIL: harness does not reproduce projectPlayer() within ${tolerance}`);
    process.exit(1);
  }
  console.log(`\nPASS: harness reproduces projectPlayer() on all ${compared.toLocaleString()} rows`);
}

main();
