import { getEntryHistory } from "@/lib/fpl/client";
import { errorList, fplJson, refreshRequested } from "@/lib/fpl/http";
import { normalizeManagerHistory } from "@/lib/fpl/normalizeLeagues";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: rawId } = await params;
  if (!/^\d+$/.test(rawId)) return fplJson(null, null, ["Team id must be a positive integer"], 400);
  const entryId = Number(rawId);
  if (!Number.isSafeInteger(entryId) || entryId < 1) {
    return fplJson(null, null, ["Team id must be a positive integer"], 400);
  }
  const result = await getEntryHistory(entryId, { forceRefresh: refreshRequested(request) });
  return fplJson(
    result.data ? normalizeManagerHistory(entryId, result.data) : null,
    result.freshness,
    errorList(result.error),
  );
}
