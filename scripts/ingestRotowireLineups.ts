import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fetchRotowireLineups } from "@/lib/availability/rotowire";
import { mapRotowireLineups } from "@/lib/availability/rotowireMapping";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { FplBootstrapSchema, parseExternal } from "@/lib/fpl/schemas";

const generated = path.join(process.cwd(), "data", "generated");
const manualMappingsPath = path.join(process.cwd(), "data", "manual", "rotowire-fpl-mappings.json");

const ManualMappingsSchema = z.object({
  clubMappings: z.record(z.string(), z.number().int().positive()),
  playerMappings: z.record(z.string(), z.number().int().positive()),
}).strict();

async function currentFplPlayers() {
  const response = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/", { cache: "no-store" });
  if (!response.ok) throw new Error(`FPL returned HTTP ${response.status}.`);
  return normalizeBootstrap(parseExternal(FplBootstrapSchema, await response.json(), "bootstrap-static")).players;
}

async function manualMappings(): Promise<z.infer<typeof ManualMappingsSchema>> {
  return ManualMappingsSchema.parse(JSON.parse(await readFile(manualMappingsPath, "utf8")));
}

Promise.all([fetchRotowireLineups(), currentFplPlayers(), manualMappings()])
  .then(async ([snapshot, players, manual]) => {
    const result = mapRotowireLineups(snapshot, players, {
      clubMappings: manual.clubMappings,
      confirmedMappings: manual.playerMappings,
    });
    const sourceConflicts = result.mapped
      .filter((record) => result.mapped.some((other) => other.rotowireId === record.rotowireId && other.source !== record.source))
      .filter((record, index, all) => all.findIndex((candidate) => candidate.rotowireId === record.rotowireId) === index)
      .map((record) => ({ rotowireId: record.rotowireId, playerId: record.playerId, name: record.name, team: record.teamAbbreviation }));
    await mkdir(generated, { recursive: true });
    await Promise.all([
      writeFile(path.join(generated, "rotowire-lineups.json"), `${JSON.stringify(snapshot, null, 2)}\n`),
      writeFile(path.join(generated, "rotowire-player-mappings.json"), `${JSON.stringify({ sourceFetchedAt: snapshot.fetchedAt, mappedAt: new Date().toISOString(), mappings: result.mapped }, null, 2)}\n`),
      writeFile(path.join(generated, "rotowire-unresolved.json"), `${JSON.stringify({ sourceFetchedAt: snapshot.fetchedAt, unresolved: result.unresolved, ambiguous: result.ambiguous, sourceConflicts }, null, 2)}\n`),
    ]);
    const teams = snapshot.fixtures.length * 2;
    const injuries = snapshot.fixtures.flatMap((fixture) => [fixture.home, fixture.away]).reduce((sum, team) => sum + team.unavailable.length, 0);
    console.log(`RotoWire snapshot written: ${snapshot.fixtures.length} fixtures, ${teams} teams, ${injuries} availability reports, ${result.mapped.length} mapped rows, ${result.unresolved.length} unresolved.`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "RotoWire ingestion failed.");
    process.exitCode = 1;
  });
