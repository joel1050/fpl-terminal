import { NextResponse } from "next/server";
import { z } from "zod";

import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { enrichPlayersWithHistory } from "@/lib/historical/enrichPlayers";
import { loadHistoricalBundle } from "@/lib/historical/load";
import { loadInSeasonPlayerRates, loadInSeasonStarts, loadInSeasonTeamXG } from "@/lib/historical/loadInSeasonForm";
import { exactOptimizeFullSquad } from "@/lib/optimizer/exactOptimizer";
import { normalizeSquad, playerMap } from "@/lib/analysis/context";
import { pickWeeklyTeam, scoreLineupWithChip } from "@/lib/squad/weeklyLineup";
import { replayTimeline } from "@/lib/chips/timeline";
import { projectTimeline } from "@/lib/chips/timelineProjections";
import { sellingPriceTenths } from "@/lib/chips/finance";
import { CHIP_KINDS, isChipAvailable, validateChipSelection } from "@/lib/chips/seasonPolicy";
import { enforceComputeRateLimit } from "@/lib/http/computeRateLimit";
import type { ChipKind } from "@/types/chips";
import type { Position } from "@/types/player";

export const runtime = "nodejs";

const chipSchema = z.enum(["wildcard", "freehit", "bboost", "3xc"]);

const timelineWeekSchema = z.object({
  playerIds: z.array(z.number().int().positive()).max(15),
  chip: chipSchema.nullable().optional(),
  benchGoalkeeperId: z.number().int().positive().optional(),
  benchOrder: z.array(z.number().int().positive()).max(3).optional(),
  captainId: z.number().int().positive().optional(),
  viceCaptainId: z.number().int().positive().optional(),
  lockedPlayerIds: z.array(z.number().int().positive()).max(15).optional(),
}).passthrough();

const baselineSchema = z.object({
  squadPlayerIds: z.array(z.number().int().positive()).max(15),
  byPosition: z.object({ GK: z.array(z.number().int()), DEF: z.array(z.number().int()), MID: z.array(z.number().int()), FWD: z.array(z.number().int()) }).passthrough(),
  bankTenths: z.number().int(),
  freeTransfers: z.number().int(),
  purchasePricesTenths: z.record(z.string(), z.number().int()),
  financialConfidence: z.enum(["EXACT", "ESTIMATED"]),
  startGameweek: z.number().int().min(1).max(38),
  warnings: z.array(z.string()).optional(),
}).passthrough();

const requestSchema = z.object({
  gameweek: z.number().int().min(1).max(38),
  /** Planning horizon in gameweeks. Chip strategy runs to the end of the
   * current chip window (GW19 in the first half, GW38 after). */
  horizon: z.number().int().min(1).max(38),
  risk: z.enum(["SAFE", "BALANCED", "AGGRESSIVE"]),
  timeline: z.record(z.string(), timelineWeekSchema),
  usedChips: z.array(z.object({ kind: chipSchema, gameweek: z.number().int().min(1).max(38) })).max(16),
  lockedPlayerIds: z.array(z.number().int().positive()).max(15),
  excludedPlayerIds: z.array(z.number().int().positive()).max(600).optional(),
  baseline: baselineSchema.nullable(),
  budgetTenths: z.number().int().nonnegative().optional(),
}).strict();

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export async function POST(request: Request) {
  const rateLimited = enforceComputeRateLimit(request, "chip-suggestions");
  if (rateLimited) return rateLimited;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid chip suggestion request" }, { status: 400 });

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
    const playersById = playerMap(players);
    const priceById = new Map(players.map((player) => [player.id, player.priceTenths]));
    const positionById = new Map(players.map((player) => [player.id, player.position as Position]));

    const { gameweek, horizon, risk } = parsed.data;
    const endGameweek = Math.min(38, gameweek + horizon - 1);
    const lockedPlayerIds = [...new Set(parsed.data.lockedPlayerIds)];
    const excludedPlayerIds = [...new Set(parsed.data.excludedPlayerIds ?? [])];
    const usedChips = parsed.data.usedChips;

    // Saved timeline in replay shape.
    const plans: Record<number, { playerIds: number[]; chip: ChipKind | null }> = {};
    const savedLineups: Record<number, { starterIds: number[]; benchGoalkeeperId: number; benchOrder: number[]; captainId: number; viceCaptainId: number } | undefined> = {};
    for (const [key, week] of Object.entries(parsed.data.timeline)) {
      const gw = Number(key);
      if (!Number.isSafeInteger(gw) || gw < gameweek || gw > endGameweek) continue;
      if (week.playerIds.length !== 15) continue;
      plans[gw] = { playerIds: [...week.playerIds], chip: week.chip ?? null };
      if (week.benchGoalkeeperId !== undefined && week.benchOrder?.length === 3 && week.captainId !== undefined && week.viceCaptainId !== undefined) {
        savedLineups[gw] = {
          starterIds: week.playerIds.filter((id) => id !== week.benchGoalkeeperId && !week.benchOrder!.includes(id)),
          benchGoalkeeperId: week.benchGoalkeeperId,
          benchOrder: [...week.benchOrder],
          captainId: week.captainId,
          viceCaptainId: week.viceCaptainId,
        };
      }
    }
    // Fill unscheduled weeks forward from the latest known squad.
    const knownGws = Object.keys(plans).map(Number).sort((a, b) => a - b);
    const fallbackIds = knownGws.length ? plans[knownGws[knownGws.length - 1]].playerIds : null;
    for (let gw = gameweek; gw <= endGameweek; gw += 1) {
      if (!plans[gw] && fallbackIds) plans[gw] = { playerIds: [...fallbackIds], chip: null };
    }
    if (!Object.keys(plans).length) return NextResponse.json({ error: "A saved 15-player timeline is required" }, { status: 422 });

    const baseline = parsed.data.baseline
      ? {
          squadPlayerIds: parsed.data.baseline.squadPlayerIds,
          byPosition: parsed.data.baseline.byPosition as Record<Position, number[]>,
          bankTenths: parsed.data.baseline.bankTenths,
          freeTransfers: parsed.data.baseline.freeTransfers,
          purchasePricesTenths: Object.fromEntries(Object.entries(parsed.data.baseline.purchasePricesTenths).map(([key, value]) => [Number(key), value])),
          financialConfidence: parsed.data.baseline.financialConfidence,
          startGameweek: parsed.data.baseline.startGameweek,
          warnings: parsed.data.baseline.warnings ?? [],
        }
      : {
          squadPlayerIds: [...plans[gameweek].playerIds],
          byPosition: normalizeSquad(plans[gameweek].playerIds, playersById).byPosition,
          bankTenths: 0,
          freeTransfers: 1,
          purchasePricesTenths: {} as Record<number, number>,
          financialConfidence: "ESTIMATED" as const,
          startGameweek: gameweek,
          warnings: ["No financial baseline supplied; selling values use current prices."],
        };

    const timeline = replayTimeline({
      baseline,
      plans,
      priceById,
      positionById,
      fromGameweek: gameweek,
      toGameweek: endGameweek,
    });
    const projections = projectTimeline({ timeline, playersById, riskMode: risk, savedLineups });
    const baselineNet: Record<number, number> = {};
    for (let gw = gameweek; gw <= endGameweek; gw += 1) baselineNet[gw] = projections[gw]?.netTotal ?? 0;

    const plannedChips: Record<number, ChipKind | null> = {};
    for (const [key, plan] of Object.entries(plans)) plannedChips[Number(key)] = plan.chip;

    const suggestions: Array<{
      chip: ChipKind;
      gameweek: number;
      baselineXp: number;
      chipPlanXp: number;
      incrementalXp: number;
      squad?: { playerIds: number[]; byPosition: Record<Position, number[]> };
      transfers?: Array<{ outId: number; inId: number; position: Position }>;
      lineup?: { starterIds: number[]; benchGoalkeeperId: number; benchOrder: number[]; captainId: number; viceCaptainId: number; projectedTotal: number };
      financialConfidence: "EXACT" | "ESTIMATED";
      reasons: string[];
    }> = [];

    // Wildcard is intentionally excluded: its timing is a judgment call
    // (fixture swings, incoming news) that a deterministic model answers
    // degenerately with "play it now", so no WC suggestion is offered.
    for (const chip of CHIP_KINDS.filter((kind) => kind !== "wildcard")) {
      // One of each chip per window; skip fully consumed chips.
      const inWindow = (gw: number) => isChipAvailable(chip, gw, usedChips)
        && validateChipSelection(chip, gw, usedChips, Object.fromEntries(Object.entries(plannedChips).filter(([key]) => Number(key) !== gw)), gameweek).legal;
      const candidates = Array.from({ length: endGameweek - gameweek + 1 }, (_, offset) => gameweek + offset).filter(inWindow);
      if (!candidates.length) continue;

      let best: (typeof suggestions)[number] | null = null;
      for (const gw of candidates) {
        const week = timeline[gw];
        if (!week) continue;
        const squad = week.activeSquadIds
          .map((id) => playersById.get(id))
          .filter((player): player is (typeof players)[number] => player !== undefined);
        if (squad.length !== 15) continue;

        if (chip === "bboost" || chip === "3xc") {
          const saved = savedLineups[gw];
          const chipPlan = saved
            ? scoreLineupWithChip(squad, gw, risk, chip, saved)
            : pickWeeklyTeam({ squad, gameweek: gw, riskMode: risk, chip });
          const baselineWeekXp = projections[gw]?.lineupTotal ?? 0;
          const incremental = round3(chipPlan.projectedTotal - baselineWeekXp);
          const candidate = {
            chip,
            gameweek: gw,
            baselineXp: round3(baselineWeekXp),
            chipPlanXp: round3(chipPlan.projectedTotal),
            incrementalXp: incremental,
            squad: undefined,
            transfers: undefined,
            lineup: {
              starterIds: [...chipPlan.starterIds],
              benchGoalkeeperId: chipPlan.benchGoalkeeperId,
              benchOrder: [...chipPlan.benchOrder],
              captainId: chipPlan.captainId,
              viceCaptainId: chipPlan.viceCaptainId,
              projectedTotal: round3(chipPlan.projectedTotal),
            },
            financialConfidence: baseline.financialConfidence,
            reasons: chip === "bboost"
              ? [`Bench Boost scores all 15 (+${round3(chipPlan.projectedTotal - baselineWeekXp)} xP vs the saved XI).`]
              : [`Triple Captain doubles the armband (+${round3(chipPlan.projectedTotal - baselineWeekXp)} xP vs the saved XI).`],
          };
          if (!best || candidate.incrementalXp > best.incrementalXp) best = candidate;
          continue;
        }

        // Free Hit: exact one-week solve with selling value + bank.
        const prior = gw > gameweek ? timeline[gw - 1] : null;
        const permanentIds = prior ? prior.permanentSquadIds : baseline.squadPlayerIds;
        const bank = prior ? prior.bankTenths : baseline.bankTenths;
        const purchasePrices = (prior ? prior.purchasePricesTenths : baseline.purchasePricesTenths) as Record<number, number>;
        let sellingValue = bank;
        let priced = true;
        for (const id of permanentIds) {
          const current = priceById.get(id);
          if (current === undefined) { priced = false; continue; }
          sellingValue += sellingPriceTenths(purchasePrices[id] ?? current, current);
        }
        if (!priced) continue;
        const solved = await exactOptimizeFullSquad({
          players, squad: permanentIds, lockedPlayerIds, excludedPlayerIds,
          budgetTenths: sellingValue, gameweek: gw, gameweeks: [gw], horizon: 1,
        });
        if (!solved.legal || !solved.squad) continue;
        const solvedPlayers = solved.playerIds
          .map((id) => playersById.get(id))
          .filter((player): player is (typeof players)[number] => player !== undefined);
        if (solvedPlayers.length !== 15) continue;
        const beforeSet = new Set(permanentIds);
        const afterSet = new Set(solved.playerIds);
        const outs = permanentIds.filter((id) => !afterSet.has(id));
        const ins = solved.playerIds.filter((id) => !beforeSet.has(id));
        const transfers = outs.slice(0, ins.length).map((outId, index) => ({
          outId,
          inId: ins[index],
          position: (playersById.get(ins[index])?.position ?? "MID") as Position,
        }));

        const chipPlan = pickWeeklyTeam({ squad: solvedPlayers, gameweek: gw, riskMode: risk, chip: null });
        const baselineWeekNet = baselineNet[gw] ?? 0;
        const incremental = round3(chipPlan.projectedTotal - baselineWeekNet);
        const candidate = {
          chip,
          gameweek: gw,
          baselineXp: round3(baselineNet[gw] ?? 0),
          chipPlanXp: round3(chipPlan.projectedTotal),
          incrementalXp: incremental,
          squad: { playerIds: [...solved.playerIds], byPosition: normalizeSquad(solved.playerIds, playersById).byPosition },
          transfers,
          lineup: {
            starterIds: [...chipPlan.starterIds],
            benchGoalkeeperId: chipPlan.benchGoalkeeperId,
            benchOrder: [...chipPlan.benchOrder],
            captainId: chipPlan.captainId,
            viceCaptainId: chipPlan.viceCaptainId,
            projectedTotal: round3(chipPlan.projectedTotal),
          },
          financialConfidence: baseline.financialConfidence,
          reasons: [`Free Hit fields an exact one-week squad (+${incremental} xP net of hits vs the saved GW${gw} plan).`],
        };
        if (!best || candidate.incrementalXp > best.incrementalXp) best = candidate;
      }
      if (best) suggestions.push(best);
    }

    suggestions.sort((left, right) => right.incrementalXp - left.incrementalXp);
    return NextResponse.json({ gameweek, horizon, suggestions });
  } catch (error) {
    console.error("Chip suggestions failed", error);
    return NextResponse.json({ error: "Chip suggestions unavailable" }, { status: 500 });
  }
}
