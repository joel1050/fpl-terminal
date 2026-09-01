import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Player } from "@/types/player";
import { fetchRotowireLineups, type RotowireLineupSnapshot } from "./rotowire";
import { mapRotowireLineups } from "./rotowireMapping";

/**
 * How stale a lineup snapshot may get before it is refetched. RotoWire is
 * still refreshed by hand as well; this only stops a snapshot from silently
 * going a gameweek out of date, which is what happened when a Friday import
 * was still driving the following Saturday's start probabilities.
 */
export const ROTOWIRE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A failing scrape must not be retried on every request. RotoWire is a courtesy
 * source with no API, so a bad page or an outage costs one attempt and then
 * waits, serving the last good snapshot in the meantime.
 */
export const ROTOWIRE_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

export interface RotowireRefreshOptions {
  generatedDir?: string;
  manualMappingsPath?: string;
  fetchSnapshot?: () => Promise<RotowireLineupSnapshot>;
  maxAgeMs?: number;
  now?: number;
}

export type RotowireRefreshReason = "fresh" | "refreshed" | "failed" | "cooling-down" | "disabled";

export interface RotowireRefreshResult {
  refreshed: boolean;
  reason: RotowireRefreshReason;
  /** The snapshot in force after this call, fresh or kept. */
  fetchedAt?: string;
  ageSeconds?: number;
  error?: string;
}

const ManualMappingsSchema = z.object({
  clubMappings: z.record(z.string(), z.number().int().positive()),
  playerMappings: z.record(z.string(), z.number().int().positive()),
}).strict();

interface RefreshState {
  inFlight: Promise<RotowireRefreshResult> | null;
  failedAt: number | null;
}

const state: RefreshState = { inFlight: null, failedAt: null };

/**
 * Off by default under test: a suite that exercises the bootstrap pipeline must
 * not reach RotoWire or rewrite `data/generated`. `FPL_ROTOWIRE_AUTO_REFRESH=1`
 * opts a test back in, and `=0` turns the automatic path off everywhere.
 */
function autoRefreshEnabled(): boolean {
  const flag = process.env.FPL_ROTOWIRE_AUTO_REFRESH;
  if (flag === "0") return false;
  if (flag === "1") return true;
  return process.env.NODE_ENV !== "test";
}

/** Clears the in-flight guard and failure cooldown. Test seam. */
export function resetRotowireRefreshState(): void {
  state.inFlight = null;
  state.failedAt = null;
}

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
 * Fetches, maps and writes a lineup snapshot. Shared with
 * `scripts/ingestRotowireLineups.ts` so the manual import and the automatic
 * one cannot drift apart: both go through `fetchRotowireLineups`, which
 * rejects a partial page or a team without eleven distinct starters, and
 * nothing is written unless that validation passes.
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

async function runRefresh(
  players: readonly Player[],
  options: RotowireRefreshOptions,
  existing: { fetchedAt: string; ageMs: number } | null,
): Promise<RotowireRefreshResult> {
  const now = options.now ?? Date.now();
  try {
    const { snapshot } = await refreshRotowireLineups(players, options);
    state.failedAt = null;
    return { refreshed: true, reason: "refreshed", fetchedAt: snapshot.fetchedAt, ageSeconds: 0 };
  } catch (error) {
    state.failedAt = now;
    return {
      refreshed: false,
      reason: "failed",
      fetchedAt: existing?.fetchedAt,
      ageSeconds: existing ? Math.floor(existing.ageMs / 1000) : undefined,
      error: error instanceof Error ? error.message : "RotoWire refresh failed.",
    };
  }
}

/**
 * Refreshes the lineup snapshot when it is older than `maxAgeMs`, and does
 * nothing otherwise. Never throws: a refresh that fails leaves the previous
 * snapshot in place and says so, because a stale predicted XI is worth far
 * more than none at all.
 *
 * Set `FPL_ROTOWIRE_AUTO_REFRESH=0` to turn the automatic path off and go back
 * to `npm run data:lineups` only, or `=1` to force it on under test.
 */
export async function ensureFreshRotowireLineups(
  players: readonly Player[],
  options: RotowireRefreshOptions = {},
): Promise<RotowireRefreshResult> {
  if (!autoRefreshEnabled()) return { refreshed: false, reason: "disabled" };
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? ROTOWIRE_MAX_AGE_MS;
  const existing = await rotowireSnapshotAge(options);
  if (existing && existing.ageMs <= maxAgeMs) {
    return {
      refreshed: false,
      reason: "fresh",
      fetchedAt: existing.fetchedAt,
      ageSeconds: Math.floor(existing.ageMs / 1000),
    };
  }
  if (state.failedAt !== null && now - state.failedAt < ROTOWIRE_RETRY_COOLDOWN_MS) {
    return {
      refreshed: false,
      reason: "cooling-down",
      fetchedAt: existing?.fetchedAt,
      ageSeconds: existing ? Math.floor(existing.ageMs / 1000) : undefined,
    };
  }
  // Concurrent requests share one scrape rather than each opening their own.
  state.inFlight ??= runRefresh(players, options, existing).finally(() => {
    state.inFlight = null;
  });
  return state.inFlight;
}
