import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHistoricalBundle } from "@/lib/historical/load";

const FILES = [
  "historical-players.json",
  "historical-match-stats.json",
  "team-strength.json",
  "player-mappings.json",
] as const;

function bundleFiles(teamName: string): Record<(typeof FILES)[number], unknown> {
  return {
    "historical-players.json": [
      {
        historicalPlayerId: 1,
        displayName: "Test Player",
        position: "MID",
        stats: { season: "2024/25", minutes: 900 },
      },
    ],
    "historical-match-stats.json": [
      {
        historicalPlayerId: 1,
        gameweek: 1,
        minutes: 90,
        totalPoints: 6,
        goals: 1,
        assists: 0,
        bonus: 1,
        bps: 24,
      },
    ],
    "team-strength.json": [
      { teamId: 1, name: teamName, shortName: "TST" },
    ],
    "player-mappings.json": [
      { currentPlayerId: 10, historicalPlayerId: 1, confidence: "EXACT" },
    ],
  };
}

/** Writes the four generated files, pinning mtime so cache keys are deterministic. */
async function writeBundle(directory: string, teamName: string, mtime: Date): Promise<void> {
  const files = bundleFiles(teamName);
  for (const name of FILES) {
    const file = path.join(directory, name);
    await writeFile(file, JSON.stringify(files[name]), "utf8");
    await utimes(file, mtime, mtime);
  }
}

describe("loadHistoricalBundle caching", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "fpl-historical-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reuses the parsed bundle instead of reading the files again", async () => {
    await writeBundle(directory, "First FC", new Date("2026-01-01T00:00:00Z"));

    const first = await loadHistoricalBundle(directory);
    expect(first?.teamStrength[0]?.name).toBe("First FC");

    // The files are gone. A second call can only answer from a cache.
    await rm(directory, { recursive: true, force: true });

    const second = await loadHistoricalBundle(directory);
    expect(second?.teamStrength[0]?.name).toBe("First FC");
  });

  it("keys on mtime, so a same-size rewrite that preserves it is not picked up", async () => {
    const pinned = new Date("2026-01-01T00:00:00Z");
    await writeBundle(directory, "AAA FC", pinned);
    await loadHistoricalBundle(directory);

    // Same mtime and same byte count, new contents: nothing the key can see,
    // so a cache hit here is proof the second call never touched the disk.
    await writeBundle(directory, "BBB FC", pinned);

    const reloaded = await loadHistoricalBundle(directory);
    expect(reloaded?.teamStrength[0]?.name).toBe("AAA FC");
  });

  it("reparses once a generated file is rewritten", async () => {
    await writeBundle(directory, "First FC", new Date("2026-01-01T00:00:00Z"));
    await loadHistoricalBundle(directory);

    // What `npm run data:ingest` does: same paths, newer contents.
    await writeBundle(directory, "Second FC", new Date("2026-01-02T00:00:00Z"));

    const reloaded = await loadHistoricalBundle(directory);
    expect(reloaded?.teamStrength[0]?.name).toBe("Second FC");
  });

  it("recovers once the generated files appear", async () => {
    expect(await loadHistoricalBundle(directory)).toBeNull();

    await writeBundle(directory, "First FC", new Date("2026-01-01T00:00:00Z"));

    const loaded = await loadHistoricalBundle(directory);
    expect(loaded?.teamStrength[0]?.name).toBe("First FC");
  });
});
