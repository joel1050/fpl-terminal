import { readFile } from "node:fs/promises";
import path from "node:path";
import { HistoricalBundleSchema } from "./schemas";
import type { HistoricalBundle, HistoricalDataStatus } from "./types";

const GENERATED_DIR = path.join(process.cwd(), "data", "generated");

export async function loadHistoricalBundle(): Promise<HistoricalBundle | null> {
  try {
    const [players, matchStats, teamStrength, playerMappings] = await Promise.all(
      ["historical-players.json", "historical-match-stats.json", "team-strength.json", "player-mappings.json"].map(
        async (name) => JSON.parse(await readFile(path.join(GENERATED_DIR, name), "utf8")) as unknown,
      ),
    );
    const parsed = HistoricalBundleSchema.safeParse({
      players,
      matchStats,
      teamStrength,
      playerMappings,
      sourceSeason: "2025/26",
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function historicalDataStatus(): Promise<HistoricalDataStatus> {
  const bundle = await loadHistoricalBundle();
  return bundle
    ? { available: true, sourceSeason: bundle.sourceSeason }
    : {
        available: false,
        sourceSeason: "2025/26",
        reason: "Run npm run data:ingest to download the historical source files.",
      };
}
