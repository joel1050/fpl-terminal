import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { loadHistoricalBundle } from "@/lib/historical/load";
import { FPL_HTTP_CACHE, fplJson, errorList, refreshRequested } from "@/lib/fpl/http";
import { enrichBootstrapWithProjections, normalizeBootstrap, projectionCacheKey } from "@/lib/fpl/normalize";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const options = { forceRefresh: refreshRequested(request) };
  const [bootstrap, fixtures] = await Promise.all([getBootstrap(options), getFixtures(options)]);
  const errors = errorList(bootstrap.error, fixtures.error);
  if (!bootstrap.data) {
    return fplJson(null, { bootstrap: bootstrap.freshness, fixtures: fixtures.freshness }, errors);
  }
  const historical = await loadHistoricalBundle();
  const enriched = await enrichBootstrapWithProjections(
    normalizeBootstrap(bootstrap.data, fixtures.data ?? []),
    historical,
    {
      cacheKey: projectionCacheKey(bootstrap.freshness, fixtures.freshness),
      forceRefresh: options.forceRefresh,
    },
  );
  return fplJson(
    enriched.bootstrap,
    { bootstrap: bootstrap.freshness, fixtures: fixtures.freshness },
    errors,
    undefined,
    enriched.metadata,
    { cacheControl: FPL_HTTP_CACHE.bootstrap, noStore: refreshRequested(request) },
  );
}
