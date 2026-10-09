import { getBootstrap, getEntry, getEntryHistory, getEntryPicks, getEntryTransfers, getPlayerSummary } from "@/lib/fpl/client";
import { openingPricesFromSummaries } from "@/lib/chips/openingPrices";
import { applyBaselineCheck, verifyBaselineValue } from "@/lib/chips/verifyBaseline";
import { FPL_HTTP_CACHE, errorList, fplJson, refreshRequested } from "@/lib/fpl/http";
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

function resolveStartingCaptaincy(
  starters: Array<{ element: number; position: number; element_type: number }>,
  allCaptains: Array<{ element: number }>,
  allViceCaptains: Array<{ element: number }>,
): { captainId: number; viceCaptainId: number; warnings: string[] } {
  const warnings: string[] = [];
  const starterIds = new Set(starters.map((pick) => pick.element));

  // Fallback priority for starter armbands: FWD (4) & MID (3) before DEF (2) & GK (1),
  // with higher positions (closer to forwards) preferred.
  const fallbackOrder = [...starters].sort((a, b) => {
    const priority = (type: number) => (type === 4 ? 4 : type === 3 ? 3 : type === 2 ? 2 : 1);
    return priority(b.element_type) - priority(a.element_type) || b.position - a.position;
  });

  const rawCaptain = allCaptains[0]?.element;
  const rawVice = allViceCaptains[0]?.element;

  const captainIsStarter = rawCaptain !== undefined && starterIds.has(rawCaptain);
  const viceIsStarter = rawVice !== undefined && starterIds.has(rawVice);

  let captainId: number;
  let viceCaptainId: number;

  if (captainIsStarter && viceIsStarter) {
    captainId = rawCaptain;
    viceCaptainId = rawVice;
  } else if (captainIsStarter && !viceIsStarter) {
    captainId = rawCaptain;
    const replacementVice = fallbackOrder.find((pick) => pick.element !== captainId);
    viceCaptainId = replacementVice ? replacementVice.element : 0;
    warnings.push("Vice-captain was benched in FPL; reassigned vice-captain to a starting player.");
  } else if (!captainIsStarter && viceIsStarter) {
    captainId = rawVice;
    const replacementVice = fallbackOrder.find((pick) => pick.element !== captainId);
    viceCaptainId = replacementVice ? replacementVice.element : 0;
    warnings.push("Captain was benched in FPL; promoted vice-captain to captain and reassigned vice-captain to a starting player.");
  } else {
    const replacementCaptain = fallbackOrder[0];
    captainId = replacementCaptain ? replacementCaptain.element : 0;
    const replacementVice = fallbackOrder.find((pick) => pick.element !== captainId);
    viceCaptainId = replacementVice ? replacementVice.element : 0;
    warnings.push("Captain and vice-captain were benched in FPL; assigned captain and vice-captain to starting players.");
  }

  return { captainId, viceCaptainId, warnings };
}

function lineupOf(picks: Array<{ element: number; position: number; element_type: number; is_captain?: boolean; is_vice_captain?: boolean }>, gameweek: number) {
  const starters = picks.filter((pick) => pick.position <= 11);
  const bench = picks.filter((pick) => pick.position > 11);
  const benchGoalkeepers = bench.filter((pick) => pick.element_type === 1);
  const benchOrder = bench.filter((pick) => pick.element_type !== 1).map((pick) => pick.element);
  const allCaptains = picks.filter((pick) => pick.is_captain);
  const allViceCaptains = picks.filter((pick) => pick.is_vice_captain);
  const resolved = resolveStartingCaptaincy(starters, allCaptains, allViceCaptains);
  return {
    starters,
    benchGoalkeepers,
    benchOrder,
    captainId: resolved.captainId,
    viceCaptainId: resolved.viceCaptainId,
    warnings: resolved.warnings,
    gameweek,
  };
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

  const forceRefresh = refreshRequested(request);
  const requestOptions = { forceRefresh };
  const entry = await getEntry(entryId, requestOptions);
  const profile = entry.data ? normalizeManagerProfile(entry.data) : null;
  const currentEvent = profile?.currentEvent;
  const picksGameweek = currentEvent && Number.isSafeInteger(currentEvent) && currentEvent >= 1 && currentEvent <= 38
    ? Math.min(gameweek, currentEvent)
    : gameweek;
  const event = await getEntryPicks(entryId, picksGameweek, requestOptions);
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
  const allCaptains = picks.filter((pick) => pick.is_captain);
  const allViceCaptains = picks.filter((pick) => pick.is_vice_captain);
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
    && allCaptains.length === 1
    && allViceCaptains.length === 1
    && allCaptains[0].element !== allViceCaptains[0].element;
  if (!valid) return fplJson(null, { entry: entry.freshness, picks: event.freshness }, ["FPL returned an invalid 15-player squad"], 422);

  const bankTenths = Math.trunc(Number(event.data.entry_history?.bank ?? entry.data.last_deadline_bank ?? 0));
  const budgetTenths = Math.trunc(Number(event.data.entry_history?.value ?? entry.data.last_deadline_value ?? 1000));

  const resolvedArmbands = resolveStartingCaptaincy(starters, allCaptains, allViceCaptains);

  // Enrich the import with chip history, transfer history, and finances.
  // Every enrichment is best-effort: failures mark finances ESTIMATED with a
  // warning instead of blocking planning.
  const importWarnings: string[] = [...resolvedArmbands.warnings];
  let nestedCacheUnsafe = false;
  let usedChips: Array<{ kind: NonNullable<ReturnType<typeof normalizeChipName>>; gameweek: number }> = [];
  let transferBaseline = null;
  let financialConfidence: "EXACT" | "ESTIMATED" = "ESTIMATED";
  let freeHitImport = false;
  let activeChip: ReturnType<typeof normalizeChipName> = null;
  let activeSquad = { playerIds, byPosition };
  let activeLineup = {
    gameweek: picksGameweek,
    benchGoalkeeperId: benchGoalkeepers[0].element,
    benchOrder,
    captainId: resolvedArmbands.captainId,
    viceCaptainId: resolvedArmbands.viceCaptainId,
  };

  try {
    const [historyResult, transfersResult, bootstrapResult] = await Promise.all([
      getEntryHistory(entryId, requestOptions).catch(() => null),
      getEntryTransfers(entryId, requestOptions).catch(() => null),
      getBootstrap(requestOptions).catch(() => null),
    ]);
    const historyPayload = historyResult?.data ?? null;
    if (!historyResult?.data || historyResult.error) nestedCacheUnsafe = true;
    if (historyResult?.error) importWarnings.push(`Chip history is unavailable (${historyResult.error}); chip inventory may be incomplete.`);
    const history = historyPayload ? normalizeManagerHistory(entryId, historyPayload) : null;
    usedChips = history ? officialChipsFromHistory(history.chips) : [];

    const transfersPayload = transfersResult?.data ?? null;
    if (!transfersResult?.data || transfersResult.error) nestedCacheUnsafe = true;
    if (transfersResult?.error || !transfersPayload) {
      importWarnings.push("Transfer history is unavailable; purchase prices use current prices and finances are ESTIMATED.");
    }
    const transfers = transfersPayload ? normalizeEntryTransfers(transfersPayload) : [];

    const priceById: Record<number, number> = {};
    if (!bootstrapResult?.data || bootstrapResult.error) nestedCacheUnsafe = true;
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
    activeChip = normalizeChipName(event.data.active_chip ?? null)
      ?? usedChips.find((c) => c.gameweek === picksGameweek)?.kind
      ?? null;
    if (activeChip && !usedChips.some((c) => c.gameweek === picksGameweek && c.kind === activeChip)) {
      usedChips.push({ kind: activeChip, gameweek: picksGameweek });
    }
    if (activeChip === "freehit" && picksGameweek > 1) {
      try {
        const previous = await getEntryPicks(entryId, picksGameweek - 1, requestOptions);
        if (!previous.data || previous.error) nestedCacheUnsafe = true;
        if (previous.data && Array.isArray(previous.data.picks) && previous.data.picks.length === 15) {
          const prevPicks = [...previous.data.picks].sort((left, right) => left.position - right.position);
          const prevLineup = lineupOf(prevPicks, picksGameweek);
          const prevValid = prevLineup.captainId !== 0 && prevLineup.viceCaptainId !== 0
            && prevLineup.captainId !== prevLineup.viceCaptainId
            && prevLineup.benchGoalkeepers.length === 1 && prevLineup.benchOrder.length === 3;
          if (prevValid) {
            activeSquad = toSquad(prevPicks);
            activeLineup = {
              gameweek: picksGameweek,
              benchGoalkeeperId: prevLineup.benchGoalkeepers[0].element,
              benchOrder: prevLineup.benchOrder,
              captainId: prevLineup.captainId,
              viceCaptainId: prevLineup.viceCaptainId,
            };
            importWarnings.push(...prevLineup.warnings);
            freeHitImport = true;
            importWarnings.push(`GW${picksGameweek} is a Free Hit; imported the GW${picksGameweek - 1} permanent squad instead of the temporary picks.`);
          }
        }
      } catch {
        nestedCacheUnsafe = true;
        importWarnings.push("Could not load the pre-Free-Hit squad; imported the current picks.");
      }
    }

    const startedEvent = profile?.startedEvent
      ?? (history?.current.length ? Math.min(...history.current.map((row) => row.event)) : 1);
    let initialIds = [...activeSquad.playerIds];
    if (startedEvent < picksGameweek) {
      try {
        const initial = await getEntryPicks(entryId, startedEvent, requestOptions);
        if (!initial.data || initial.error) nestedCacheUnsafe = true;
        if (initial.data && Array.isArray(initial.data.picks) && initial.data.picks.length === 15) {
          initialIds = [...initial.data.picks].sort((left, right) => left.position - right.position).map((pick) => pick.element);
        } else {
          importWarnings.push(`GW${startedEvent} starting picks are unavailable; purchase prices use current prices.`);
        }
      } catch {
        nestedCacheUnsafe = true;
        importWarnings.push(`GW${startedEvent} starting picks are unavailable; purchase prices use current prices.`);
      }
    }
    // Opening prices are only needed for players never bought through a
    // recorded transfer; a transfer row already gives their exact cost.
    const boughtIds = new Set(transfers.map((transfer) => transfer.elementIn));
    const needOpening = initialIds.filter((id) => !boughtIds.has(id));
    const summaries = new Map(
      await Promise.all(needOpening.map(async (id) => {
        const summary = await getPlayerSummary(id, requestOptions).catch(() => null);
        if (!summary?.data || summary.error) nestedCacheUnsafe = true;
        return [id, summary?.data ?? null] as const;
      })),
    );
    const opening = openingPricesFromSummaries(summaries, startedEvent);

    const initialPrices: Record<number, number> = {};
    const verifiedInitialPriceIds: number[] = [];
    for (const id of initialIds) {
      const found = opening[id];
      if (found?.exact) {
        initialPrices[id] = found.priceTenths;
        verifiedInitialPriceIds.push(id);
      } else if (found) {
        initialPrices[id] = found.priceTenths;
      } else if (priceById[id] !== undefined) {
        initialPrices[id] = priceById[id];
      }
    }
    if (verifiedInitialPriceIds.length < needOpening.length) {
      importWarnings.push("Some opening prices could not be read; those purchase prices use current prices.");
    }

    const reconstruction = reconstructImportBaseline({
      initialSquadIds: initialIds,
      initialPricesTenths: initialPrices,
      verifiedInitialPriceIds,
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
    // FPL reports the answer: entry_history.value is bank + squad selling value.
    // Only check against the real field — last_deadline_value is stale and the
    // 1000 fallback is fiction, and either would downgrade every import.
    const reportedValue = event.data.entry_history?.value;
    if (reportedValue !== undefined) {
      const check = verifyBaselineValue(transferBaseline, priceById, Math.trunc(Number(reportedValue)));
      transferBaseline = applyBaselineCheck(transferBaseline, check);
    }
    financialConfidence = transferBaseline.financialConfidence;
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
    chip: activeChip,
  }, { entry: entry.freshness, picks: event.freshness }, errors, undefined, undefined, {
    cacheControl: FPL_HTTP_CACHE.entry,
    noStore: forceRefresh || nestedCacheUnsafe || importWarnings.length > 0,
  });
}
