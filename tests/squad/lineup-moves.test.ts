import { describe, expect, it } from "vitest";
import { BENCH_ORDER_REASON, CAPTAIN_BENCH_REASON, checkLineupMove, FORMATION_REASON, GOALKEEPER_REASON, type LineupShape } from "@/lib/squad/lineupMoves";
import type { Position } from "@/types";

// 3-4-3: GK 1; DEF 2,3,4; MID 5,6,7,8; FWD 9,10,11. Bench: GK 12; DEF 13; MID 14; FWD 15.
const positions: Record<number, Position> = {
  1: "GK", 2: "DEF", 3: "DEF", 4: "DEF", 5: "MID", 6: "MID", 7: "MID", 8: "MID", 9: "FWD", 10: "FWD", 11: "FWD",
  12: "GK", 13: "DEF", 14: "MID", 15: "FWD", 16: "DEF",
};
const positionOf = (id: number) => positions[id];
const lineup: LineupShape = { starterIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], benchGoalkeeperId: 12, benchOrder: [13, 14, 15], captainId: 9, viceCaptainId: 10 };

describe("checkLineupMove", () => {
  it("swaps a starter with a bench player of the same position, in either drag direction", () => {
    expect(checkLineupMove(lineup, 13, 2, positionOf)).toEqual({ legal: true, kind: "swap", starterId: 2, benchId: 13 });
    expect(checkLineupMove(lineup, 2, 13, positionOf)).toEqual({ legal: true, kind: "swap", starterId: 2, benchId: 13 });
  });

  it("allows a swap across positions when the formation stays legal", () => {
    // 3-4-3 with a forward out and a midfielder in is 3-5-2.
    expect(checkLineupMove(lineup, 14, 11, positionOf)).toEqual({ legal: true, kind: "swap", starterId: 11, benchId: 14 });
    // A defender out and a forward in is 2-4-4 and illegal; a midfielder out and a forward in is 3-3-4 and legal.
    expect(checkLineupMove(lineup, 15, 5, positionOf)).toEqual({ legal: true, kind: "swap", starterId: 5, benchId: 15 });
  });

  it("refuses a swap that leaves fewer than 3 defenders", () => {
    expect(checkLineupMove(lineup, 14, 2, positionOf)).toEqual({ legal: false, reason: FORMATION_REASON });
    expect(checkLineupMove(lineup, 15, 3, positionOf)).toEqual({ legal: false, reason: FORMATION_REASON });
  });

  it("refuses a swap that leaves fewer than 2 midfielders", () => {
    const twoMid: LineupShape = { starterIds: [1, 2, 3, 4, 16, 5, 6, 9, 10, 11, 15], benchGoalkeeperId: 12, benchOrder: [7, 8, 13] };
    expect(checkLineupMove(twoMid, 7, 5, positionOf)).toMatchObject({ legal: true });
    expect(checkLineupMove(twoMid, 13, 5, positionOf)).toEqual({ legal: false, reason: FORMATION_REASON });
  });

  it("refuses a swap that leaves no forward", () => {
    const oneFwd: LineupShape = { starterIds: [1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 11], benchGoalkeeperId: 12, benchOrder: [9, 10, 16] };
    expect(checkLineupMove(oneFwd, 9, 11, positionOf)).toMatchObject({ legal: true });
    expect(checkLineupMove(oneFwd, 16, 11, positionOf)).toEqual({ legal: false, reason: FORMATION_REASON });
  });

  it("swaps goalkeepers with each other only", () => {
    expect(checkLineupMove(lineup, 12, 1, positionOf)).toEqual({ legal: true, kind: "swap", starterId: 1, benchId: 12 });
    expect(checkLineupMove(lineup, 1, 12, positionOf)).toEqual({ legal: true, kind: "swap", starterId: 1, benchId: 12 });
    expect(checkLineupMove(lineup, 12, 5, positionOf)).toEqual({ legal: false, reason: GOALKEEPER_REASON });
    expect(checkLineupMove(lineup, 14, 1, positionOf)).toEqual({ legal: false, reason: GOALKEEPER_REASON });
  });

  it("keeps the captain and vice-captain in the XI", () => {
    expect(checkLineupMove(lineup, 15, 9, positionOf)).toEqual({ legal: false, reason: CAPTAIN_BENCH_REASON });
    expect(checkLineupMove(lineup, 15, 10, positionOf)).toEqual({ legal: false, reason: CAPTAIN_BENCH_REASON });
    expect(checkLineupMove(lineup, 15, 11, positionOf)).toMatchObject({ legal: true });
  });

  it("swaps two outfield substitutes in the bench order", () => {
    expect(checkLineupMove(lineup, 13, 15, positionOf)).toEqual({ legal: true, kind: "reorder", order: [15, 14, 13] });
    expect(checkLineupMove(lineup, 14, 13, positionOf)).toEqual({ legal: true, kind: "reorder", order: [14, 13, 15] });
  });

  it("keeps the bench goalkeeper out of the bench order", () => {
    expect(checkLineupMove(lineup, 12, 13, positionOf)).toEqual({ legal: false, reason: BENCH_ORDER_REASON });
    expect(checkLineupMove(lineup, 14, 12, positionOf)).toEqual({ legal: false, reason: BENCH_ORDER_REASON });
  });

  it("is no target for the same player, two starters, or an unknown player", () => {
    expect(checkLineupMove(lineup, 5, 5, positionOf)).toEqual({ legal: false, reason: null });
    expect(checkLineupMove(lineup, 5, 6, positionOf)).toEqual({ legal: false, reason: null });
    expect(checkLineupMove(lineup, 5, 99, positionOf)).toEqual({ legal: false, reason: null });
  });
});
