import { getBootstrap, getPlayerSummary } from "@/lib/fpl/client";
import { FPL_HTTP_CACHE, fplJson, errorList, refreshRequested } from "@/lib/fpl/http";
import { normalizePlayer, normalizePlayerDetail } from "@/lib/fpl/normalize";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: rawId } = await params;
  if (!/^\d+$/.test(rawId)) return fplJson(null, null, ["Player id must be a positive integer"], 400);
  const playerId = Number(rawId);
  if (!Number.isSafeInteger(playerId) || playerId < 1) {
    return fplJson(null, null, ["Player id must be a positive integer"], 400);
  }

  const options = { forceRefresh: refreshRequested(request) };
  const [bootstrap, summary] = await Promise.all([getBootstrap(options), getPlayerSummary(playerId, options)]);
  const player = bootstrap.data?.elements.find((item) => item.id === playerId);
  const errors = errorList(bootstrap.error, summary.error);
  if (!bootstrap.data || !player || !summary.data) {
    return fplJson(null, { bootstrap: bootstrap.freshness, player: summary.freshness }, errors, 503);
  }

  const normalizedPlayer = bootstrap.data.elements.find((item) => item.id === playerId);
  if (!normalizedPlayer) return fplJson(null, { bootstrap: bootstrap.freshness }, ["Player was not found"], 404);
  const teams = new Map(
    bootstrap.data.teams.map((team) => [
      team.id,
      {
        id: team.id,
        name: team.name,
        shortName: team.short_name,
      },
    ]),
  );
  const base = normalizePlayer(
    normalizedPlayer,
    teams,
  );
  return fplJson(
    normalizePlayerDetail(base, summary.data, teams),
    { bootstrap: bootstrap.freshness, player: summary.freshness },
    errors,
    undefined,
    undefined,
    { cacheControl: FPL_HTTP_CACHE.player, noStore: refreshRequested(request) },
  );
}
