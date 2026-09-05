import { getLiveGameweek } from "@/lib/fpl/client";
import { FPL_HTTP_CACHE, fplJson, refreshRequested } from "@/lib/fpl/http";
import { normalizeLiveGameweek } from "@/lib/fpl/normalize";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ gw: string }> },
): Promise<Response> {
  const { gw: rawGameweek } = await params;
  if (!/^\d+$/.test(rawGameweek)) return fplJson(null, null, ["Gameweek must be an integer from 1 to 38"], 400);
  const gameweek = Number(rawGameweek);
  if (!Number.isSafeInteger(gameweek) || gameweek < 1 || gameweek > 38) {
    return fplJson(null, null, ["Gameweek must be an integer from 1 to 38"], 400);
  }
  const result = await getLiveGameweek(gameweek, { forceRefresh: refreshRequested(request) });
  return fplJson(
    result.data ? normalizeLiveGameweek(gameweek, result.data) : null,
    result.freshness,
    result.error ? [result.error] : [],
    undefined,
    undefined,
    { cacheControl: FPL_HTTP_CACHE.live, noStore: refreshRequested(request) },
  );
}
