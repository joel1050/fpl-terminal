import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { errorList, fplJson, refreshRequested } from "@/lib/fpl/http";
import { normalizeFixtures } from "@/lib/fpl/normalize";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const options = { forceRefresh: refreshRequested(request) };
  const [fixtures, bootstrap] = await Promise.all([getFixtures(options), getBootstrap(options)]);
  return fplJson(
    fixtures.data ? normalizeFixtures(fixtures.data, bootstrap.data?.teams ?? []) : null,
    { fixtures: fixtures.freshness, bootstrap: bootstrap.freshness },
    errorList(fixtures.error, bootstrap.error),
  );
}
