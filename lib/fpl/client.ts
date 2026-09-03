import { z } from "zod";
import {
  FPL_CACHE_TTLS_MS,
  getFreshness,
  getMemoryCache,
  isCacheFresh,
  readSnapshot,
  setMemoryCache,
  type FplResponse,
  writeSnapshot,
} from "./cache";
import {
  FplBootstrapSchema,
  FplClassicLeagueStandingsSchema,
  FplEntryHistorySchema,
  FplEntryPicksSchema,
  FplEntrySchema,
  FplEntryTransfersSchema,
  FplFixturesSchema,
  FplLiveResponseSchema,
  FplPlayerSummarySchema,
  parseExternal,
  type FplBootstrapPayload,
  type FplClassicLeagueStandingsPayload,
  type FplEntryHistoryPayload,
  type FplEntryPicksPayload,
  type FplEntryPayload,
  type FplEntryTransfersPayload,
  type FplFixturePayload,
  type FplLiveResponsePayload,
  type FplPlayerSummaryPayload,
} from "./schemas";

const FPL_BASE_URL = (process.env.FPL_API_BASE_URL ?? "https://fantasy.premierleague.com/api").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 12_000;

interface RequestOptions<T> extends FplRequestOptions {
  key: string;
  path: string;
  schema: z.ZodType<T>;
  ttlMs: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown FPL request error";
}

async function requestJson<T>({
  key,
  path: endpoint,
  schema,
  ttlMs,
  forceRefresh = false,
  persistSnapshot = true,
}: RequestOptions<T>): Promise<FplResponse<T>> {
  const memoryEntry = getMemoryCache<T>(key);
  if (!forceRefresh && memoryEntry && isCacheFresh(memoryEntry, ttlMs)) {
    return {
      data: memoryEntry.data,
      freshness: getFreshness(memoryEntry.fetchedAt, ttlMs),
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${FPL_BASE_URL}/${endpoint.replace(/^\//, "")}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`FPL returned HTTP ${response.status}`);
    const parsed = parseExternal(schema, await response.json(), key);
    const fetchedAt = Date.now();
    setMemoryCache(key, parsed, fetchedAt);
    if (persistSnapshot) await writeSnapshot(key, parsed, fetchedAt);
    return { data: parsed, freshness: getFreshness(fetchedAt, ttlMs) };
  } catch (error) {
    const message = errorMessage(error);
    if (memoryEntry) {
      return {
        data: memoryEntry.data,
        freshness: getFreshness(memoryEntry.fetchedAt, ttlMs, "snapshot"),
        error: message,
      };
    }

    const snapshot = await readSnapshot(key, schema);
    if (snapshot) {
      return {
        data: snapshot.data,
        freshness: getFreshness(snapshot.fetchedAt, ttlMs, "snapshot"),
        error: message,
      };
    }
    return { data: null, freshness: null, error: message };
  }
}

export interface FplRequestOptions {
  forceRefresh?: boolean;
  persistSnapshot?: boolean;
  ttlMs?: number;
}

interface RequestOptions<T> extends FplRequestOptions {
  key: string;
  path: string;
  schema: z.ZodType<T>;
  ttlMs: number;
}

export function getBootstrap(options: FplRequestOptions = {}): Promise<FplResponse<FplBootstrapPayload>> {
  return requestJson({
    key: "bootstrap",
    path: "bootstrap-static/",
    schema: FplBootstrapSchema,
    ttlMs: FPL_CACHE_TTLS_MS.bootstrap,
    ...options,
  });
}

export function getFixtures(options: FplRequestOptions = {}): Promise<FplResponse<FplFixturePayload>> {
  return requestJson({
    key: "fixtures",
    path: "fixtures/",
    schema: FplFixturesSchema,
    ttlMs: FPL_CACHE_TTLS_MS.fixtures,
    ...options,
  });
}

export function getPlayerSummary(
  playerId: number,
  options: FplRequestOptions = {},
): Promise<FplResponse<FplPlayerSummaryPayload>> {
  if (!Number.isInteger(playerId) || playerId < 1) {
    return Promise.resolve({ data: null, freshness: null, error: "Player id must be a positive integer" });
  }
  return requestJson({
    key: `player-${playerId}`,
    path: `element-summary/${playerId}/`,
    schema: FplPlayerSummarySchema,
    ttlMs: FPL_CACHE_TTLS_MS.player,
    ...options,
  });
}

export function getLiveGameweek(
  gameweek: number,
  options: FplRequestOptions = {},
): Promise<FplResponse<FplLiveResponsePayload>> {
  if (!Number.isInteger(gameweek) || gameweek < 1 || gameweek > 38) {
    return Promise.resolve({ data: null, freshness: null, error: "Gameweek must be an integer from 1 to 38" });
  }
  return requestJson({
    key: `live-${gameweek}`,
    path: `event/${gameweek}/live/`,
    schema: FplLiveResponseSchema,
    ttlMs: FPL_CACHE_TTLS_MS.live,
    ...options,
  });
}

export function getEntry(
  entryId: number,
  options: FplRequestOptions = {},
): Promise<FplResponse<FplEntryPayload>> {
  if (!Number.isSafeInteger(entryId) || entryId < 1) {
    return Promise.resolve({ data: null, freshness: null, error: "Team id must be a positive integer" });
  }
  return requestJson({
    key: `entry-${entryId}`,
    path: `entry/${entryId}/`,
    schema: FplEntrySchema,
    ttlMs: FPL_CACHE_TTLS_MS.entry,
    persistSnapshot: false,
    ...options,
  });
}

export function getEntryHistory(
  entryId: number,
  options: FplRequestOptions = {},
): Promise<FplResponse<FplEntryHistoryPayload>> {
  if (!Number.isSafeInteger(entryId) || entryId < 1) {
    return Promise.resolve({ data: null, freshness: null, error: "Team id must be a positive integer" });
  }
  return requestJson({
    key: `entry-${entryId}-history`,
    path: `entry/${entryId}/history/`,
    schema: FplEntryHistorySchema,
    ttlMs: FPL_CACHE_TTLS_MS.entryHistory,
    ...options,
  });
}

export function getEntryPicks(
  entryId: number,
  gameweek: number,
  options: FplRequestOptions = {},
): Promise<FplResponse<FplEntryPicksPayload>> {
  if (!Number.isSafeInteger(entryId) || entryId < 1) {
    return Promise.resolve({ data: null, freshness: null, error: "Team id must be a positive integer" });
  }
  if (!Number.isSafeInteger(gameweek) || gameweek < 1 || gameweek > 38) {
    return Promise.resolve({ data: null, freshness: null, error: "Gameweek must be an integer from 1 to 38" });
  }
  return requestJson({
    key: `entry-${entryId}-event-${gameweek}-picks`,
    path: `entry/${entryId}/event/${gameweek}/picks/`,
    schema: FplEntryPicksSchema,
    ttlMs: FPL_CACHE_TTLS_MS.entryPicks,
    persistSnapshot: false,
    ...options,
  });
}

export function getEntryTransfers(
  entryId: number,
  options: FplRequestOptions = {},
): Promise<FplResponse<FplEntryTransfersPayload>> {
  if (!Number.isSafeInteger(entryId) || entryId < 1) {
    return Promise.resolve({ data: null, freshness: null, error: "Team id must be a positive integer" });
  }
  return requestJson({
    key: `entry-${entryId}-transfers`,
    path: `entry/${entryId}/transfers/`,
    schema: FplEntryTransfersSchema,
    ttlMs: FPL_CACHE_TTLS_MS.entryTransfers,
    ...options,
  });
}

export function getClassicLeagueStandings(
  leagueId: number,
  page = 1,
  options: FplRequestOptions = {},
): Promise<FplResponse<FplClassicLeagueStandingsPayload>> {
  if (!Number.isSafeInteger(leagueId) || leagueId < 1) {
    return Promise.resolve({ data: null, freshness: null, error: "League id must be a positive integer" });
  }
  if (!Number.isSafeInteger(page) || page < 1) {
    return Promise.resolve({ data: null, freshness: null, error: "Page must be a positive integer" });
  }
  return requestJson({
    key: `league-classic-${leagueId}-page-${page}`,
    path: `leagues-classic/${leagueId}/standings/?page_standings=${page}`,
    schema: FplClassicLeagueStandingsSchema,
    ttlMs: FPL_CACHE_TTLS_MS.league,
    persistSnapshot: page === 1,
    ...options,
  });
}

export const getBootstrapStatic = getBootstrap;
export const getFixtureList = getFixtures;
export const getElementSummary = getPlayerSummary;
export const fetchBootstrap = getBootstrap;
export const fetchFixtures = getFixtures;
export const fetchPlayerSummary = getPlayerSummary;
export const fetchLiveGameweek = getLiveGameweek;
export const fetchEntry = getEntry;
export const fetchEntryHistory = getEntryHistory;
export const fetchEntryTransfers = getEntryTransfers;
export const fetchEntryPicks = getEntryPicks;
export const fetchClassicLeagueStandings = getClassicLeagueStandings;
