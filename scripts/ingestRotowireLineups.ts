import path from "node:path";
import { refreshRotowireLineups } from "@/lib/availability/refreshLineups";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { FplBootstrapSchema, parseExternal } from "@/lib/fpl/schemas";

async function currentFplPlayers() {
  const response = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/", { cache: "no-store" });
  if (!response.ok) throw new Error(`FPL returned HTTP ${response.status}.`);
  return normalizeBootstrap(parseExternal(FplBootstrapSchema, await response.json(), "bootstrap-static")).players;
}

currentFplPlayers()
  .then((players) => refreshRotowireLineups(players, { generatedDir: path.join(process.cwd(), "data", "generated") }))
  .then(({ snapshot, mapped, unresolved }) => {
    const teams = snapshot.fixtures.length * 2;
    const injuries = snapshot.fixtures.flatMap((fixture) => [fixture.home, fixture.away]).reduce((sum, team) => sum + team.unavailable.length, 0);
    console.log(`RotoWire snapshot written: ${snapshot.fixtures.length} fixtures, ${teams} teams, ${injuries} availability reports, ${mapped} mapped rows, ${unresolved} unresolved.`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "RotoWire ingestion failed.");
    process.exitCode = 1;
  });
