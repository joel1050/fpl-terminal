import { getEntry, getEntryPicks } from "@/lib/fpl/client";
import { errorList, fplJson } from "@/lib/fpl/http";
import { normalizeManagerProfile } from "@/lib/fpl/normalizeLeagues";
import type { Position, SquadState } from "@/types";

export const dynamic = "force-dynamic";

const POSITIONS: Record<number, Position> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
const COUNTS: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };

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

  const [entry, event] = await Promise.all([getEntry(entryId), getEntryPicks(entryId, gameweek)]);
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

  const bankTenths = event.data.entry_history?.bank ?? entry.data.last_deadline_bank ?? 0;
  const budgetTenths = event.data.entry_history?.value ?? entry.data.last_deadline_value ?? 1000;

  return fplJson({
    entryId,
    bankTenths,
    budgetTenths,
    teamName: entry.data.name,
    managerName: [entry.data.player_first_name, entry.data.player_last_name].filter(Boolean).join(" "),
    profile: normalizeManagerProfile(entry.data),
    squad: { playerIds, byPosition },
    lineup: {
      gameweek,
      benchGoalkeeperId: benchGoalkeepers[0].element,
      benchOrder,
      captainId: captains[0].element,
      viceCaptainId: viceCaptains[0].element,
    },
  }, { entry: entry.freshness, picks: event.freshness }, errors);
}
