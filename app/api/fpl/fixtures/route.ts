import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { FPL_CACHE_TTLS_MS } from "@/lib/fpl/cache";
import { FPL_HTTP_CACHE, errorList, fplJson, refreshRequested } from "@/lib/fpl/http";
import { normalizeFixtures } from "@/lib/fpl/normalize";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const refresh = refreshRequested(request);
  const rawGameweek = new URL(request.url).searchParams.get("gameweek");
  if (rawGameweek !== null && !/^\d+$/.test(rawGameweek)) {
    return fplJson(null, null, ["Gameweek must be an integer from 1 to 38"], 400);
  }
  const gameweek = rawGameweek === null ? undefined : Number(rawGameweek);
  if (gameweek !== undefined && (!Number.isSafeInteger(gameweek) || gameweek < 1 || gameweek > 38)) {
    return fplJson(null, null, ["Gameweek must be an integer from 1 to 38"], 400);
  }
  // A Gameweek-scoped request powers the live tracker, so it uses the live
  // polling TTL instead of the slower whole-season fixtures cache.
  const options = gameweek !== undefined
    ? { forceRefresh: refresh, ttlMs: FPL_CACHE_TTLS_MS.liveFixtures }
    : { forceRefresh: refresh };
  const [fixtures, bootstrap] = await Promise.all([getFixtures(options), getBootstrap(options)]);
  const normalized = fixtures.data ? normalizeFixtures(fixtures.data, bootstrap.data?.teams ?? []) : null;
  return fplJson(
    normalized && gameweek !== undefined ? normalized.filter((fixture) => fixture.gameweek === gameweek) : normalized,
    { fixtures: fixtures.freshness, bootstrap: bootstrap.freshness },
    errorList(fixtures.error, bootstrap.error),
    undefined,
    undefined,
    {
      cacheControl: gameweek !== undefined ? FPL_HTTP_CACHE.live : FPL_HTTP_CACHE.fixtures,
      noStore: refresh,
    },
  );
}
