import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

export const FPL_CACHE_TTLS_MS = {
  bootstrap: 5 * 60 * 1000,
  fixtures: 15 * 60 * 1000,
  liveFixtures: 60 * 1000,
  player: 15 * 60 * 1000,
  live: 60 * 1000,
  entry: 5 * 60 * 1000,
  entryPicks: 10 * 60 * 1000,
  entryHistory: 15 * 60 * 1000,
  league: 5 * 60 * 1000,
} as const;

export type DataSource = "live" | "snapshot";

export interface FreshnessMetadata {
  source: DataSource;
  fetchedAt: string;
  ageSeconds: number;
  stale: boolean;
  ttlSeconds: number;
}

export interface FplResponse<T> {
  data: T | null;
  freshness: FreshnessMetadata | null;
  error?: string;
}

interface MemoryEntry<T> {
  data: T;
  fetchedAt: number;
}

interface Snapshot<T> {
  fetchedAt: string;
  data: T;
}

const memory = new Map<string, MemoryEntry<unknown>>();

export function clearFplCache(): void {
  memory.clear();
}

export function getMemoryCache<T>(key: string): MemoryEntry<T> | undefined {
  return memory.get(key) as MemoryEntry<T> | undefined;
}

export function setMemoryCache<T>(key: string, data: T, fetchedAt = Date.now()): void {
  memory.set(key, { data, fetchedAt });
}

export function getFreshness(
  fetchedAt: number,
  ttlMs: number,
  source: DataSource = "live",
  now = Date.now(),
): FreshnessMetadata {
  const ageSeconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  return {
    source,
    fetchedAt: new Date(fetchedAt).toISOString(),
    ageSeconds,
    stale: source === "snapshot" || now - fetchedAt > ttlMs,
    ttlSeconds: Math.max(1, Math.floor(ttlMs / 1000)),
  };
}

function snapshotDirectory(): string {
  return process.env.FPL_SNAPSHOT_DIR
    ? path.resolve(process.env.FPL_SNAPSHOT_DIR)
    : path.join(process.cwd(), "data", "snapshots");
}

function snapshotFile(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(snapshotDirectory(), `${safeName}.json`);
}

/**
 * An empty payload is never worth keeping or serving. A snapshot of zero live
 * elements or zero standings rows parses cleanly, so without this guard a
 * failing upstream call answers with a valid-looking file full of nothing.
 */
export function isEmptyPayload(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0;
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  for (const key of ["elements", "results", "picks", "current"]) {
    const value = record[key];
    if (Array.isArray(value)) return value.length === 0;
  }
  const standings = record.standings as { results?: unknown } | undefined;
  if (standings && Array.isArray(standings.results)) return standings.results.length === 0;
  return false;
}

export async function readSnapshot<T>(
  name: string,
  schema: z.ZodType<T>,
): Promise<{ data: T; fetchedAt: number } | null> {
  try {
    const value = JSON.parse(await readFile(snapshotFile(name), "utf8")) as Snapshot<unknown>;
    const parsed = schema.safeParse(value.data);
    const fetchedAt = Date.parse(value.fetchedAt);
    if (!parsed.success || !Number.isFinite(fetchedAt)) return null;
    if (isEmptyPayload(parsed.data)) return null;
    return { data: parsed.data, fetchedAt };
  } catch {
    return null;
  }
}

export async function writeSnapshot<T>(
  name: string,
  data: T,
  fetchedAt = Date.now(),
): Promise<void> {
  if (isEmptyPayload(data)) return;
  try {
    await mkdir(snapshotDirectory(), { recursive: true });
    const payload: Snapshot<T> = {
      fetchedAt: new Date(fetchedAt).toISOString(),
      data,
    };
    await writeFile(snapshotFile(name), JSON.stringify(payload), "utf8");
  } catch (error) {
    console.warn(`Unable to write FPL snapshot ${name}:`, error);
  }
}

export function isCacheFresh(entry: MemoryEntry<unknown>, ttlMs: number, now = Date.now()): boolean {
  return now - entry.fetchedAt <= ttlMs;
}
