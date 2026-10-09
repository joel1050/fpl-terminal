import { describe, expect, it } from "vitest";
import { buildLivePitch } from "@/lib/leagues/livePitch";
import type { LiveEntryPlayer } from "@/types/leagues";
import type { Position } from "@/types/player";

function pick(position: number, positionCode: Position, onBench = false): LiveEntryPlayer {
  return {
    elementId: position * 10,
    position,
    elementType: 1,
    positionCode,
    onBench,
    multiplier: onBench ? 0 : 1,
    isCaptain: false,
    isViceCaptain: false,
    points: 0,
    expectedPoints: 0,
    status: "TO_PLAY",
    fixtures: [],
  };
}

const SQUAD: LiveEntryPlayer[] = [
  pick(1, "GK"), pick(2, "DEF"), pick(3, "DEF"), pick(4, "DEF"), pick(5, "DEF"),
  pick(6, "MID"), pick(7, "MID"), pick(8, "MID"), pick(9, "MID"), pick(10, "FWD"), pick(11, "FWD"),
  pick(12, "GK", true), pick(13, "DEF", true), pick(14, "MID", true), pick(15, "FWD", true),
];

describe("buildLivePitch", () => {
  it("groups starters by line in pick order, with no empty slots", () => {
    const pitch = buildLivePitch([...SQUAD].reverse());
    expect(pitch.rows.map((row) => row.position)).toEqual(["GK", "DEF", "MID", "FWD"]);
    expect(pitch.rows.map((row) => row.players.map((player) => player.position))).toEqual([[1], [2, 3, 4, 5], [6, 7, 8, 9], [10, 11]]);
    for (const row of pitch.rows) expect(row.slotCount).toBe(row.players.length);
  });

  it("orders the bench by pick and labels it GK, B1, B2, B3", () => {
    const pitch = buildLivePitch(SQUAD);
    expect(pitch.bench.map((slot) => [slot.player.position, slot.label])).toEqual([[12, "GK"], [13, "B1"], [14, "B2"], [15, "B3"]]);
  });

  it("names the formation from the outfield lines that have starters", () => {
    expect(buildLivePitch(SQUAD).formation).toBe("4-4-2");
    expect(buildLivePitch([pick(1, "GK"), pick(2, "DEF")]).formation).toBe("1");
    expect(buildLivePitch([]).formation).toBe("");
  });
});
