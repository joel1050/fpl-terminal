import { getEntryPicks } from "@/lib/fpl/client";
import { FPL_HTTP_CACHE, errorList, fplJson, refreshRequested } from "@/lib/fpl/http";
import { normalizeEntryPicks } from "@/lib/fpl/normalizeLeagues";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; gw: string }> },
): Promise<Response> {
  const { id: rawId, gw: rawGameweek } = await params;
  if (!/^\d+$/.test(rawId)) return fplJson(null, null, ["Team id must be a positive integer"], 400);
  const entryId = Number(rawId);
  if (!Number.isSafeInteger(entryId) || entryId < 1) {
    return fplJson(null, null, ["Team id must be a positive integer"], 400);
  }
  if (!/^\d+$/.test(rawGameweek)) return fplJson(null, null, ["Gameweek must be an integer from 1 to 38"], 400);
  const gameweek = Number(rawGameweek);
  if (!Number.isSafeInteger(gameweek) || gameweek < 1 || gameweek > 38) {
    return fplJson(null, null, ["Gameweek must be an integer from 1 to 38"], 400);
  }
  const result = await getEntryPicks(entryId, gameweek, { forceRefresh: refreshRequested(request) });
  return fplJson(
    result.data ? normalizeEntryPicks(entryId, gameweek, result.data) : null,
    result.freshness,
    errorList(result.error),
    result.error && /HTTP 404/.test(result.error) ? 404 : undefined,
    undefined,
    { cacheControl: FPL_HTTP_CACHE.picks, noStore: refreshRequested(request) },
  );
}
