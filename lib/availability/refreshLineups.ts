import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Player } from "@/types/player";
import { fetchRotowireLineups, type RotowireLineupSnapshot } from "./rotowire";
import { mapRotowireLineups } from "./rotowireMapping";

/**
 * Lineups are refreshed by hand - `npm run data:lineups`, commit, deploy -
 * and never at request time.
 *
 * There used to be an automatic path here that refetched a snapshot older than
 * a day. It could not work anywhere it mattered: a deployed build has a
 * read-only filesystem, and the committed snapshot's `fetchedAt` is frozen at
 * build time, so it was past the age bar a day after every release and stayed
 * there. What that produced was a scrape of a courtesy source from the
 * deployment's own address every fifteen minutes, for ever, writing nothing.
 *
 * Keep it that way. If a snapshot needs to age out on its own, the honest
 * place for that is the selection model deciding to stop weighting it, not a
 * request handler deciding to fetch.
 */

export interface RotowireRefreshOptions {
  generatedDir?: string;
  manualMappingsPath?: string;
  fetchSnapshot?: () => Promise<RotowireLineupSnapshot>;
  now?: number;
}

const ManualMappingsSchema = z.object({
  clubMappings: z.record(z.string(), z.number().int().positive()),
  playerMappings: z.record(z.string(), z.number().int().positive()),
}).strict();

function generatedDirectory(options: RotowireRefreshOptions): string {
  return options.generatedDir ?? path.join(process.cwd(), "data", "generated");
}

async function manualMappings(options: RotowireRefreshOptions): Promise<z.infer<typeof ManualMappingsSchema>> {
  const file = options.manualMappingsPath
    ?? path.join(process.cwd(), "data", "manual", "rotowire-fpl-mappings.json");
  try {
    return ManualMappingsSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return { clubMappings: {}, playerMappings: {} };
  }
}

/** The `fetchedAt` of the snapshot currently on disk, if there is one. */
export async function rotowireSnapshotAge(
  options: RotowireRefreshOptions = {},
): Promise<{ fetchedAt: string; ageMs: number } | null> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(generatedDirectory(options), "rotowire-lineups.json"), "utf8"),
    ) as { fetchedAt?: unknown };
    if (typeof raw.fetchedAt !== "string") return null;
    const parsed = Date.parse(raw.fetchedAt);
    if (!Number.isFinite(parsed)) return null;
    return { fetchedAt: raw.fetchedAt, ageMs: (options.now ?? Date.now()) - parsed };
  } catch {
    return null;
  }
}

/**
 * Fetches, maps and writes a lineup snapshot. The one caller is
 * `scripts/ingestRotowireLineups.ts`, run by hand. It goes through
 * `fetchRotowireLineups`, which rejects a partial page or a team without
 * eleven distinct starters, and writes nothing unless that validation passes -
 * so a bad scrape leaves the committed snapshot alone rather than replacing
 * good data with unusable data.
 */
export async function refreshRotowireLineups(
  players: readonly Player[],
  options: RotowireRefreshOptions = {},
): Promise<{ snapshot: RotowireLineupSnapshot; mapped: number; unresolved: number }> {
  const [snapshot, manual] = await Promise.all([
    (options.fetchSnapshot ?? fetchRotowireLineups)(),
    manualMappings(options),
  ]);
  const result = mapRotowireLineups(snapshot, players, {
    clubMappings: manual.clubMappings,
    confirmedMappings: manual.playerMappings,
  });
  // A snapshot nothing maps onto is worse than the one already on disk: the
  // selection model reads the mappings, so writing zero rows silently strips
  // every predicted XI. This is the same rule the parser applies to a partial
  // page - refuse rather than replace good data with unusable data.
  if (result.mapped.length === 0) {
    throw new Error("RotoWire mapping resolved no players; keeping the previous snapshot.");
  }
  const sourceConflicts = result.mapped
    .filter((record) => result.mapped.some((other) => other.rotowireId === record.rotowireId && other.source !== record.source))
    .filter((record, index, all) => all.findIndex((candidate) => candidate.rotowireId === record.rotowireId) === index)
    .map((record) => ({ rotowireId: record.rotowireId, playerId: record.playerId, name: record.name, team: record.teamAbbreviation }));

  const directory = generatedDirectory(options);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "rotowire-lineups.json"), `${JSON.stringify(snapshot, null, 2)}\n`),
    writeFile(path.join(directory, "rotowire-player-mappings.json"), `${JSON.stringify({ sourceFetchedAt: snapshot.fetchedAt, mappedAt: new Date(options.now ?? Date.now()).toISOString(), mappings: result.mapped }, null, 2)}\n`),
    writeFile(path.join(directory, "rotowire-unresolved.json"), `${JSON.stringify({ sourceFetchedAt: snapshot.fetchedAt, unresolved: result.unresolved, ambiguous: result.ambiguous, sourceConflicts }, null, 2)}\n`),
  ]);
  return { snapshot, mapped: result.mapped.length, unresolved: result.unresolved.length };
}
