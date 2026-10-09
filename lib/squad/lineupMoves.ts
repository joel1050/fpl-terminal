import type { Position } from "@/types";

/** The weekly lineup as drag-and-drop sees it. */
export interface LineupShape {
  starterIds: readonly number[];
  benchGoalkeeperId: number;
  /** The three outfield substitutes, first to come on first. */
  benchOrder: readonly number[];
  captainId?: number;
  viceCaptainId?: number;
}

export type LineupMove =
  | { legal: true; kind: "swap"; starterId: number; benchId: number }
  | { legal: true; kind: "reorder"; order: [number, number, number] }
  /** `reason` is null when the target is no target at all (same player, or two starters). */
  | { legal: false; reason: string | null };

export const FORMATION_REASON = "That swap would leave an invalid starting formation. Pick a compatible player.";
export const GOALKEEPER_REASON = "A goalkeeper can only swap with a goalkeeper.";
export const BENCH_ORDER_REASON = "Only the three outfield substitutes can change places on the bench.";

const MIN_IN_XI = { DEF: 3, MID: 2, FWD: 1 } as const;

/** True when the eleven ids form a legal XI: one GK and at least 3 DEF, 2 MID and 1 FWD. */
function legalXI(ids: readonly number[], positionOf: (id: number) => Position | undefined): boolean {
  if (ids.length !== 11) return false;
  const count: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const id of ids) {
    const position = positionOf(id);
    if (!position) return false;
    count[position] += 1;
  }
  return count.GK === 1 && count.DEF >= MIN_IN_XI.DEF && count.MID >= MIN_IN_XI.MID && count.FWD >= MIN_IN_XI.FWD;
}

/**
 * Whether dropping `sourceId` on `targetId` is a legal lineup change, and if not, why.
 * A starter and a bench player swap places; a benched captain or vice-captain
 * passes the badge to the player who comes on. Two outfield substitutes swap bench order.
 * The store checks the same rules again when the move is applied.
 */
export function checkLineupMove(
  lineup: LineupShape,
  sourceId: number,
  targetId: number,
  positionOf: (id: number) => Position | undefined,
): LineupMove {
  if (sourceId === targetId) return { legal: false, reason: null };
  const benchIds = [lineup.benchGoalkeeperId, ...lineup.benchOrder];
  const sourceStarts = lineup.starterIds.includes(sourceId);
  const targetStarts = lineup.starterIds.includes(targetId);
  const sourceBenched = benchIds.includes(sourceId);
  const targetBenched = benchIds.includes(targetId);
  if (!(sourceStarts || sourceBenched) || !(targetStarts || targetBenched)) return { legal: false, reason: null };
  if (sourceStarts && targetStarts) return { legal: false, reason: null };

  if (sourceBenched && targetBenched) {
    if (sourceId === lineup.benchGoalkeeperId || targetId === lineup.benchGoalkeeperId) return { legal: false, reason: BENCH_ORDER_REASON };
    const order = [...lineup.benchOrder];
    const from = order.indexOf(sourceId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0 || order.length !== 3) return { legal: false, reason: null };
    [order[from], order[to]] = [order[to], order[from]];
    return { legal: true, kind: "reorder", order: order as [number, number, number] };
  }

  const starterId = sourceStarts ? sourceId : targetId;
  const benchId = sourceStarts ? targetId : sourceId;
  const starterPosition = positionOf(starterId);
  const benchPosition = positionOf(benchId);
  if (!starterPosition || !benchPosition) return { legal: false, reason: null };
  if ((starterPosition === "GK") !== (benchPosition === "GK")) return { legal: false, reason: GOALKEEPER_REASON };
  const nextXI = lineup.starterIds.map((id) => id === starterId ? benchId : id);
  if (!legalXI(nextXI, positionOf)) return { legal: false, reason: FORMATION_REASON };
  return { legal: true, kind: "swap", starterId, benchId };
}
