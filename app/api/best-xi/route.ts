import { NextResponse } from "next/server";
import { z } from "zod";

import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { enrichBootstrapWithProjections, normalizeBootstrap } from "@/lib/fpl/normalize";
import { loadHistoricalBundle } from "@/lib/historical/load";
import { exactBestPossibleXI } from "@/lib/optimizer/bestPossibleXI";
import { DEFAULT_BUDGET_TENTHS } from "@/lib/analysis/context";

export const runtime = "nodejs";

const requestSchema = z.object({
  budgetTenths: z.number().int().nonnegative().optional(),
  gameweek: z.number().int().min(1).max(38).optional(),
}).strict();

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid best possible XI request" }, { status: 400 });

  try {
    const [bootstrap, fixtures, historical] = await Promise.all([getBootstrap(), getFixtures(), loadHistoricalBundle()]);
    if (!bootstrap.data) return NextResponse.json({ error: bootstrap.error ?? "FPL data is unavailable" }, { status: 503 });
    const normalized = normalizeBootstrap(bootstrap.data, fixtures.data ?? []);
    const projected = (await enrichBootstrapWithProjections(normalized, historical)).bootstrap;
    const gameweek = parsed.data.gameweek
      ?? projected.events.find((event) => event.isCurrent)?.id
      ?? projected.events.find((event) => event.isNext)?.id
      ?? 1;
    const budgetTenths = parsed.data.budgetTenths ?? DEFAULT_BUDGET_TENTHS;
    const result = await exactBestPossibleXI({
      players: projected.players,
      gameweek,
      budgetTenths,
    });
    if (!result.legal) return NextResponse.json({ error: result.errors[0] ?? "No legal XI could be solved." }, { status: 422 });
    return NextResponse.json({
      gameweek,
      budgetTenths,
      projectedXI: result.projectedXI,
      captainBonus: result.captainBonus,
      projectedTotal: result.projectedTotal,
      playerIds: result.playerIds,
    });
  } catch (error) {
    console.error("Best possible XI failed", error);
    return NextResponse.json({ error: "Best possible XI unavailable" }, { status: 500 });
  }
}
