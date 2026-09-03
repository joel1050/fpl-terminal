import { NextResponse } from "next/server";
import { z } from "zod";

import { findBestSingleTransfers } from "@/lib/analysis/singleTransfers";
import { legalSquad, playerMap } from "@/lib/analysis/context";
import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { enrichBootstrapWithProjections, normalizeBootstrap, projectionCacheKey } from "@/lib/fpl/normalize";
import { loadHistoricalBundle } from "@/lib/historical/load";
import { enforceComputeRateLimit } from "@/lib/http/computeRateLimit";

export const runtime = "nodejs";

const requestSchema = z.object({
  squad: z.array(z.number().int().positive()).length(15),
  lockedPlayerIds: z.array(z.number().int().positive()).max(15),
  budgetTenths: z.number().int().nonnegative().optional(),
  purchasePricesTenths: z.record(z.string(), z.number().int()).optional(),
  bankTenths: z.number().int().optional(),
  excludedPlayerIds: z.array(z.number().int().positive()).max(600).optional(),
  gameweek: z.number().int().min(1).max(38).optional(),
  horizon: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(10)]),
  risk: z.enum(["SAFE", "BALANCED", "AGGRESSIVE"]),
}).strict();

export async function POST(request: Request) {
  const rateLimited = enforceComputeRateLimit(request, "transfer-suggestions");
  if (rateLimited) return rateLimited;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid single-transfer request" }, { status: 400 });

  try {
    const [bootstrap, fixtures, historical] = await Promise.all([getBootstrap(), getFixtures(), loadHistoricalBundle()]);
    if (!bootstrap.data) return NextResponse.json({ error: bootstrap.error ?? "FPL data is unavailable" }, { status: 503 });
    const normalized = normalizeBootstrap(bootstrap.data, fixtures.data ?? []);
    const projected = (await enrichBootstrapWithProjections(normalized, historical, {
      cacheKey: projectionCacheKey(bootstrap.freshness, fixtures.freshness),
    })).bootstrap;
    const legality = legalSquad(parsed.data.squad, playerMap(projected.players), { budgetTenths: parsed.data.budgetTenths });
    if (!legality.legal) return NextResponse.json({ error: legality.errors[0] ?? "A legal 15-player squad is required" }, { status: 422 });
    const gameweek = parsed.data.gameweek
      ?? projected.events.find((event) => event.isCurrent)?.id
      ?? projected.events.find((event) => event.isNext)?.id
      ?? 1;
    const suggestions = findBestSingleTransfers({
      squad: parsed.data.squad,
      players: projected.players,
      gameweek,
      horizon: parsed.data.horizon,
      risk: parsed.data.risk,
      lockedPlayerIds: parsed.data.lockedPlayerIds,
      budgetTenths: parsed.data.budgetTenths,
      purchasePricesTenths: parsed.data.purchasePricesTenths
        ? Object.fromEntries(Object.entries(parsed.data.purchasePricesTenths).map(([key, value]) => [Number(key), value]))
        : undefined,
      bankTenths: parsed.data.bankTenths,
      excludedPlayerIds: parsed.data.excludedPlayerIds,
    }).slice(0, 5);
    return NextResponse.json({ gameweek, horizon: parsed.data.horizon, suggestions });
  } catch (error) {
    console.error("Exact single-transfer search failed", error);
    return NextResponse.json({ error: "Exact single-transfer search unavailable" }, { status: 500 });
  }
}
