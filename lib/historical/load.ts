import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { HistoricalBundleSchema } from "./schemas";
import type { HistoricalBundle, HistoricalDataStatus } from "./types";

const GENERATED_DIR = path.join(process.cwd(), "data", "generated");

const BUNDLE_FILES = [
  "historical-players.json",
  "historical-match-stats.json",
  "team-strength.json",
  "player-mappings.json",
] as const;

interface CachedBundle {
  /** The mtimes and sizes the bundle was parsed from. */
  key: string;
  bundle: HistoricalBundle;
}

const cache = new Map<string, CachedBundle>();

/**
 * Identifies the generation of the files on disk. `npm run data:ingest` and
 * `npm run data:lineups` rewrite them, which moves an mtime and retires the
 * cached bundle. Null means the files could not be read at all.
 */
async function generationKey(generatedDir: string): Promise<string | null> {
  try {
    const stats = await Promise.all(BUNDLE_FILES.map((name) => stat(path.join(generatedDir, name))));
    return stats.map((entry) => `${entry.mtimeMs}:${entry.size}`).join("|");
  } catch {
    return null;
  }
}

/**
 * Which generation of the generated files the cached bundle came from, or null
 * when nothing has been loaded yet. Callers that cache their own work derived
 * from the bundle fold this into their key, so an ingest retires that too.
 */
export function historicalBundleGeneration(generatedDir: string = GENERATED_DIR): string | null {
  return cache.get(generatedDir)?.key ?? null;
}

/**
 * Parses the generated historical inputs, reusing the last parse while the
 * files are untouched. The four files run to megabytes and every projection
 * request needs all of them, so reparsing per request cost real time for an
 * answer that could not have changed.
 */
export async function loadHistoricalBundle(
  generatedDir: string = GENERATED_DIR,
): Promise<HistoricalBundle | null> {
  const cached = cache.get(generatedDir);
  const key = await generationKey(generatedDir);
  // Files that cannot be stat'd — a half-finished ingest, say — keep the last
  // good bundle rather than blanking every projection that depends on it.
  if (key === null) return cached?.bundle ?? null;
  if (cached && cached.key === key) return cached.bundle;

  try {
    const [players, matchStats, teamStrength, playerMappings] = await Promise.all(
      BUNDLE_FILES.map(
        async (name) => JSON.parse(await readFile(path.join(generatedDir, name), "utf8")) as unknown,
      ),
    );
    const parsed = HistoricalBundleSchema.safeParse({
      players,
      matchStats,
      teamStrength,
      playerMappings,
      sourceSeason: "2025/26",
    });
    if (!parsed.success) return null;
    cache.set(generatedDir, { key, bundle: parsed.data });
    return parsed.data;
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
