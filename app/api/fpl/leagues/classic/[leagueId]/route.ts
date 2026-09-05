import { getClassicLeagueStandings } from "@/lib/fpl/client";
import { FPL_HTTP_CACHE, errorList, fplJson, refreshRequested } from "@/lib/fpl/http";
import { normalizeClassicLeagueStandings } from "@/lib/fpl/normalizeLeagues";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  const { leagueId: rawLeagueId } = await params;
  if (!/^\d+$/.test(rawLeagueId)) return fplJson(null, null, ["League id must be a positive integer"], 400);
  const leagueId = Number(rawLeagueId);
  if (!Number.isSafeInteger(leagueId) || leagueId < 1) {
    return fplJson(null, null, ["League id must be a positive integer"], 400);
  }
  const rawPage = new URL(request.url).searchParams.get("page");
  if (rawPage !== null && !/^\d+$/.test(rawPage)) {
    return fplJson(null, null, ["Page must be a positive integer"], 400);
  }
  const page = rawPage === null ? 1 : Number(rawPage);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) {
    return fplJson(null, null, ["Page must be a positive integer"], 400);
  }
  const result = await getClassicLeagueStandings(leagueId, page, { forceRefresh: refreshRequested(request) });
  return fplJson(
    result.data ? normalizeClassicLeagueStandings(result.data) : null,
    result.freshness,
    errorList(result.error),
    result.error && /HTTP 404/.test(result.error) ? 404 : undefined,
    undefined,
    { cacheControl: FPL_HTTP_CACHE.league, noStore: refreshRequested(request) },
  );
}
