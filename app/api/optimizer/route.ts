import { NextResponse } from "next/server";
import { z } from "zod";

import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { enrichPlayersWithHistory } from "@/lib/historical/enrichPlayers";
import { loadHistoricalBundle } from "@/lib/historical/load";
import { loadInSeasonPlayerRates, loadInSeasonStarts, loadInSeasonTeamXG } from "@/lib/historical/loadInSeasonForm";
import { exactCompletePartialSquad, exactOptimizeFullSquad } from "@/lib/optimizer/exactOptimizer";
import { enforceComputeRateLimit } from "@/lib/http/computeRateLimit";

export const runtime = "nodejs";

const requestSchema = z.object({
  mode: z.enum(["OPTIMIZE", "COMPLETE"]),
  squad: z.array(z.number().int().positive()).max(15),
  lockedPlayerIds: z.array(z.number().int().positive()).max(15),
  budgetTenths: z.number().int().nonnegative().optional(),
  bankTenths: z.number().int().nonnegative().optional(),
  purchasePricesTenths: z.object({}).catchall(z.number().int().nonnegative()).refine((prices) => Object.keys(prices).length <= 15, {
    message: "No more than 15 purchase prices",
  }).optional(),
  gameweek: z.number().int().min(1).max(38).optional(),
  horizon: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(10)]),
  bench: z.enum(["CHEAP", "BALANCED", "STRONG"]),
}).strict();

export async function POST(request: Request) {
  const rateLimited = enforceComputeRateLimit(request, "optimizer");
  if (rateLimited) return rateLimited;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid optimizer request" }, { status: 400 });
  const owned = new Set(parsed.data.squad);
  const ownedPricing = Object.keys(parsed.data.purchasePricesTenths ?? {});
  if (ownedPricing.some((id) => !owned.has(Number(id)))) {
    return NextResponse.json({ error: "Purchase prices may only be supplied for players in the submitted squad" }, { status: 400 });
  }

  try {
    const [bootstrap, fixtures] = await Promise.all([getBootstrap(), getFixtures()]);
    if (!bootstrap.data) return NextResponse.json({ error: bootstrap.error ?? "FPL data is unavailable" }, { status: 503 });
    const normalized = normalizeBootstrap(bootstrap.data, fixtures.data ?? []);
    const [historical, inSeasonForm, playerForm, startHistory] = await Promise.all([
      loadHistoricalBundle(),
      loadInSeasonTeamXG(normalized.players, normalized.fixtures),
      loadInSeasonPlayerRates(normalized.players, normalized.fixtures),
      loadInSeasonStarts(normalized.players, normalized.fixtures),
    ]);
    const players = enrichPlayersWithHistory(normalized.players, normalized.teams, normalized.events, historical, inSeasonForm, playerForm, startHistory).players;
    const gameweek = parsed.data.gameweek
      ?? normalized.events.find((event) => event.isCurrent)?.id
      ?? normalized.events.find((event) => event.isNext)?.id
      ?? 1;
    const input = {
      players,
      squad: parsed.data.squad,
      lockedPlayerIds: parsed.data.lockedPlayerIds,
      budgetTenths: parsed.data.budgetTenths,
      bankTenths: parsed.data.bankTenths,
      purchasePricesTenths: parsed.data.purchasePricesTenths
        ? Object.fromEntries(Object.entries(parsed.data.purchasePricesTenths).map(([key, value]) => [Number(key), value]))
        : undefined,
      gameweek,
      horizon: parsed.data.horizon,
      bench: parsed.data.bench,
    };
    const result = parsed.data.mode === "COMPLETE"
      ? await exactCompletePartialSquad(input)
      : await exactOptimizeFullSquad(input);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Exact optimizer failed", error);
    return NextResponse.json({ error: "Exact optimizer unavailable" }, { status: 500 });
  }
}
