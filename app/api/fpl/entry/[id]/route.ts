import { getBootstrap, getEntry, getEntryHistory, getEntryPicks, getEntryTransfers } from "@/lib/fpl/client";
import { errorList, fplJson } from "@/lib/fpl/http";
import { normalizeEntryTransfers, normalizeManagerHistory, normalizeManagerProfile } from "@/lib/fpl/normalizeLeagues";
import { normalizeChipName } from "@/lib/chips/seasonPolicy";
import { officialChipsFromHistory, reconstructImportBaseline } from "@/lib/chips/importTeam";
import type { Position, SquadState } from "@/types";

export const dynamic = "force-dynamic";

const POSITIONS: Record<number, Position> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
const COUNTS: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };

function toSquad(picks: Array<{ element: number; element_type: number }>): SquadState {
  const byPosition: SquadState["byPosition"] = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const pick of picks) byPosition[POSITIONS[pick.element_type]].push(pick.element);
  return { playerIds: picks.map((pick) => pick.element), byPosition };
}

function lineupOf(picks: Array<{ element: number; position: number; element_type: number; is_captain?: boolean; is_vice_captain?: boolean }>, gameweek: number) {
  const starters = picks.filter((pick) => pick.position <= 11);
  const bench = picks.filter((pick) => pick.position > 11);
  const benchGoalkeepers = bench.filter((pick) => pick.element_type === 1);
  const benchOrder = bench.filter((pick) => pick.element_type !== 1).map((pick) => pick.element);
  const captains = starters.filter((pick) => pick.is_captain);
  const viceCaptains = starters.filter((pick) => pick.is_vice_captain);
  return { starters, benchGoalkeepers, benchOrder, captains, viceCaptains, gameweek };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: rawId } = await params;
  if (!/^\d+$/.test(rawId)) return fplJson(null, null, ["Team id must be a positive integer"], 400);
  const entryId = Number(rawId);
  if (!Number.isSafeInteger(entryId) || entryId < 1) return fplJson(null, null, ["Team id must be a positive integer"], 400);
  const rawGameweek = new URL(request.url).searchParams.get("gameweek");
  const gameweek = rawGameweek === null ? 1 : Number(rawGameweek);
  if (rawGameweek !== null && (!/^\d+$/.test(rawGameweek) || !Number.isSafeInteger(gameweek) || gameweek < 1 || gameweek > 38)) {
    return fplJson(null, null, ["Gameweek must be an integer from 1 to 38"], 400);
  }

  const entry = await getEntry(entryId);
  const profile = entry.data ? normalizeManagerProfile(entry.data) : null;
  const currentEvent = profile?.currentEvent;
  const picksGameweek = currentEvent && Number.isSafeInteger(currentEvent) && currentEvent >= 1 && currentEvent <= 38
    ? Math.min(gameweek, currentEvent)
    : gameweek;
  const event = await getEntryPicks(entryId, picksGameweek);
  const errors = errorList(entry.error, event.error);
  if (!entry.data || !event.data) {
    return fplJson(null, { entry: entry.freshness, picks: event.freshness }, errors, errors.some((error) => /HTTP 404/.test(error)) ? 404 : 503);
  }

  const picks = [...event.data.picks].sort((left, right) => left.position - right.position);
  const playerIds = picks.map((pick) => pick.element);
  const byPosition: SquadState["byPosition"] = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const pick of picks) byPosition[POSITIONS[pick.element_type]].push(pick.element);
  const starters = picks.filter((pick) => pick.position <= 11);
  const bench = picks.filter((pick) => pick.position > 11);
  const benchGoalkeepers = bench.filter((pick) => pick.element_type === 1);
  const benchOrder = bench.filter((pick) => pick.element_type !== 1).map((pick) => pick.element);
  const captains = starters.filter((pick) => pick.is_captain);
  const viceCaptains = starters.filter((pick) => pick.is_vice_captain);
  const valid = picks.length === 15
    && new Set(playerIds).size === 15
    && new Set(picks.map((pick) => pick.position)).size === 15
    && Object.entries(COUNTS).every(([position, count]) => byPosition[position as Position].length === count)
    && starters.filter((pick) => pick.element_type === 1).length === 1
    && starters.filter((pick) => pick.element_type === 2).length >= 3
    && starters.filter((pick) => pick.element_type === 3).length >= 2
    && starters.filter((pick) => pick.element_type === 4).length >= 1
    && benchGoalkeepers.length === 1
    && benchOrder.length === 3
    && captains.length === 1
    && viceCaptains.length === 1
    && captains[0].element !== viceCaptains[0].element;
  if (!valid) return fplJson(null, { entry: entry.freshness, picks: event.freshness }, ["FPL returned an invalid 15-player squad"], 422);

  const bankTenths = Math.trunc(Number(event.data.entry_history?.bank ?? entry.data.last_deadline_bank ?? 0));
  const budgetTenths = Math.trunc(Number(event.data.entry_history?.value ?? entry.data.last_deadline_value ?? 1000));

  // Enrich the import with chip history, transfer history, and finances.
  // Every enrichment is best-effort: failures mark finances ESTIMATED with a
  // warning instead of blocking planning.
  const importWarnings: string[] = [];
  let usedChips: Array<{ kind: NonNullable<ReturnType<typeof normalizeChipName>>; gameweek: number }> = [];
  let transferBaseline = null;
  let financialConfidence: "EXACT" | "ESTIMATED" = "ESTIMATED";
  let freeHitImport = false;
  let activeSquad = { playerIds, byPosition };
  let activeLineup = {
    gameweek: picksGameweek,
    benchGoalkeeperId: benchGoalkeepers[0].element,
    benchOrder,
    captainId: captains[0].element,
    viceCaptainId: viceCaptains[0].element,
  };

  try {
    const [historyResult, transfersResult, bootstrapResult] = await Promise.all([
      getEntryHistory(entryId).catch(() => null),
      getEntryTransfers(entryId).catch(() => null),
      getBootstrap().catch(() => null),
    ]);
    const historyPayload = historyResult?.data ?? null;
    if (historyResult?.error) importWarnings.push(`Chip history is unavailable (${historyResult.error}); chip inventory may be incomplete.`);
    const history = historyPayload ? normalizeManagerHistory(entryId, historyPayload) : null;
    usedChips = history ? officialChipsFromHistory(history.chips) : [];

    const transfersPayload = transfersResult?.data ?? null;
    if (transfersResult?.error || !transfersPayload) {
      importWarnings.push("Transfer history is unavailable; purchase prices use current prices and finances are ESTIMATED.");
    }
    const transfers = transfersPayload ? normalizeEntryTransfers(transfersPayload) : [];

    const priceById: Record<number, number> = {};
    const elements = (bootstrapResult?.data as { elements?: Array<{ id: number; now_cost: number | string }> } | null)?.elements;
    if (Array.isArray(elements)) {
      for (const element of elements) {
        const cost = Number(element.now_cost);
        if (Number.isSafeInteger(element.id) && Number.isFinite(cost)) priceById[element.id] = Math.trunc(cost);
      }
    } else {
      importWarnings.push("Current prices are unavailable; purchase prices use transfer costs only.");
    }

    // If the current official squad is a Free Hit, import the previous
    // permanent squad instead of the temporary picks.
    const activeChip = normalizeChipName(event.data.active_chip ?? null);
    if (activeChip === "freehit" && picksGameweek > 1) {
      try {
        const previous = await getEntryPicks(entryId, picksGameweek - 1);
        if (previous.data && Array.isArray(previous.data.picks) && previous.data.picks.length === 15) {
          const prevPicks = [...previous.data.picks].sort((left, right) => left.position - right.position);
          const prevLineup = lineupOf(prevPicks, picksGameweek);
          const prevValid = prevLineup.captains.length === 1 && prevLineup.viceCaptains.length === 1
            && prevLineup.benchGoalkeepers.length === 1 && prevLineup.benchOrder.length === 3;
          if (prevValid) {
            activeSquad = toSquad(prevPicks);
            activeLineup = {
              gameweek: picksGameweek,
              benchGoalkeeperId: prevLineup.benchGoalkeepers[0].element,
              benchOrder: prevLineup.benchOrder,
              captainId: prevLineup.captains[0].element,
              viceCaptainId: prevLineup.viceCaptains[0].element,
            };
            freeHitImport = true;
            importWarnings.push(`GW${picksGameweek} is a Free Hit; imported the GW${picksGameweek - 1} permanent squad instead of the temporary picks.`);
          }
        }
      } catch {
        importWarnings.push("Could not load the pre-Free-Hit squad; imported the current picks.");
      }
    }

    const startedEvent = profile?.startedEvent
      ?? (history?.current.length ? Math.min(...history.current.map((row) => row.event)) : 1);
    let initialIds = [...activeSquad.playerIds];
    if (startedEvent < picksGameweek) {
      try {
        const initial = await getEntryPicks(entryId, startedEvent);
        if (initial.data && Array.isArray(initial.data.picks) && initial.data.picks.length === 15) {
          initialIds = [...initial.data.picks].sort((left, right) => left.position - right.position).map((pick) => pick.element);
        } else {
          importWarnings.push(`GW${startedEvent} starting picks are unavailable; purchase prices use current prices.`);
        }
      } catch {
        importWarnings.push(`GW${startedEvent} starting picks are unavailable; purchase prices use current prices.`);
      }
    }
    const initialPrices: Record<number, number> = {};
    for (const id of initialIds) {
      if (priceById[id] !== undefined) initialPrices[id] = priceById[id];
    }

    const reconstruction = reconstructImportBaseline({
      initialSquadIds: initialIds,
      initialPricesTenths: initialPrices,
      startedEvent,
      currentGameweek: picksGameweek,
      currentSquadIds: activeSquad.playerIds,
      currentPricesTenths: priceById,
      bankTenths,
      transfers: transfers.map((transfer) => ({
        elementIn: transfer.elementIn,
        elementOut: transfer.elementOut,
        elementInCost: transfer.elementInCost,
        elementOutCost: transfer.elementOutCost,
        event: transfer.event,
        time: transfer.time,
      })),
      chips: usedChips,
      byPosition: activeSquad.byPosition,
    });
    transferBaseline = reconstruction.baseline;
    financialConfidence = reconstruction.baseline.financialConfidence;
    importWarnings.push(...reconstruction.warnings);
    transferBaseline = { ...transferBaseline, warnings: [...transferBaseline.warnings, ...importWarnings.filter((w) => !transferBaseline!.warnings.includes(w))] };
  } catch (error) {
    importWarnings.push(error instanceof Error ? error.message : "Chip and finance enrichment failed; planning can continue with estimated finances.");
  }

  return fplJson({
    entryId,
    bankTenths,
    budgetTenths,
    teamName: entry.data.name,
    managerName: [entry.data.player_first_name, entry.data.player_last_name].filter(Boolean).join(" "),
    profile,
    squad: activeSquad,
    lineup: activeLineup,
    transferBaseline,
    usedChips,
    financialConfidence,
    freeHitImport,
    importWarnings,
  }, { entry: entry.freshness, picks: event.freshness }, errors);
}
