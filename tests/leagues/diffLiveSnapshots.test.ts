import { describe, expect, it } from "vitest";
import { diffLiveSnapshots } from "@/lib/leagues/diffLiveSnapshots";
import type { LiveStats } from "@/lib/leagues/calculateLiveEntry";

function stats(overrides: LiveStats = {}): LiveStats {
  return {
    total_points: 0,
    minutes: 0,
    goals_scored: 0,
    assists: 0,
    yellow_cards: 0,
    red_cards: 0,
    own_goals: 0,
    bonus: 0,
    bps: 0,
    saves: 0,
    clean_sheets: 0,
    penalties_saved: 0,
    penalties_missed: 0,
    defensive_contribution: 0,
    ...overrides,
  };
}

const NOW = 1_700_000_000_000;
const CONTEXT = {
  playerNameById: new Map([[7, "Saka"], [9, "Porro"]]),
  teamIdByPlayer: new Map([[7, 1], [9, 2]]),
  minuteLabelByTeam: new Map([[1, "74'"], [2, "68'"]]),
  now: NOW,
};

describe("diffLiveSnapshots", () => {
  it("names penalty events using the stat keys FPL actually sends", () => {
    const previous = new Map([[7, stats({ total_points: 2 })], [9, stats({ total_points: 3 })]]);
    const current = new Map([
      [7, stats({ total_points: 0, penalties_missed: 1 })],
      [9, stats({ total_points: 8, penalties_saved: 1 })],
    ]);
    const kinds = diffLiveSnapshots(previous, current, CONTEXT).map((event) => event.kind);
    expect(kinds).toContain("PENALTY MISS");
    expect(kinds).toContain("PENALTY SAVE");
  });

  it("emits no events on the first snapshot of a session", () => {
    const current = new Map([[7, stats({ total_points: 5 })]]);
    expect(diffLiveSnapshots(undefined, current, CONTEXT)).toEqual([]);
    expect(diffLiveSnapshots(new Map(), current, CONTEXT)).toEqual([]);
  });

  it("classifies a goal with the player's minute and raw points delta", () => {
    const previous = new Map([[7, stats()]]);
    const current = new Map([[7, stats({ total_points: 5, goals_scored: 1, minutes: 74 })]]);
    const [event] = diffLiveSnapshots(previous, current, CONTEXT);
    expect(event).toMatchObject({
      kind: "GOAL",
      playerId: 7,
      playerName: "Saka",
      rawPointsDelta: 5,
      minute: "74'",
      detail: "goals_scored 0 → 1",
    });
  });

  it("classifies an assist", () => {
    const previous = new Map([[9, stats()]]);
    const current = new Map([[9, stats({ total_points: 3, assists: 1 })]]);
    const [event] = diffLiveSnapshots(previous, current, CONTEXT);
    expect(event?.kind).toBe("ASSIST");
    expect(event?.rawPointsDelta).toBe(3);
  });

  it("classifies a yellow card as a negative change", () => {
    const previous = new Map([[9, stats()]]);
    const current = new Map([[9, stats({ total_points: -1, yellow_cards: 1 })]]);
    const [event] = diffLiveSnapshots(previous, current, CONTEXT);
    expect(event?.kind).toBe("YELLOW CARD");
    expect(event?.rawPointsDelta).toBe(-1);
  });

  it("classifies a bonus change in either direction", () => {
    const previous = new Map([[7, stats({ total_points: 6, bonus: 1 })]]);
    const current = new Map([[7, stats({ total_points: 8, bonus: 3 })]]);
    expect(diffLiveSnapshots(previous, current, CONTEXT)[0]?.kind).toBe("BONUS CHANGE");
  });

  it("falls back to POINTS CHANGE when the cause is ambiguous", () => {
    const previous = new Map([[7, stats()]]);
    const current = new Map([[7, stats({ total_points: 1 })]]);
    const [event] = diffLiveSnapshots(previous, current, CONTEXT);
    expect(event?.kind).toBe("POINTS CHANGE");
    expect(event?.detail).toBe("unattributed points change");
  });

  it("awards a save point only when a three-save threshold is crossed", () => {
    const previous = new Map([[7, stats({ total_points: 2, saves: 3 })]]);
    const crossing = new Map([[7, stats({ total_points: 3, saves: 6 })]]);
    expect(diffLiveSnapshots(previous, crossing, CONTEXT)[0]?.kind).toBe("SAVE POINT");
    const belowThreshold = new Map([[7, stats({ total_points: 2, saves: 5 })]]);
    expect(diffLiveSnapshots(previous, belowThreshold, CONTEXT)).toHaveLength(0);
  });

  it("ignores identical snapshots and players missing from the previous snapshot", () => {
    const previous = new Map<number, LiveStats>([
      [7, stats()],
    ]);
    const current = new Map<number, LiveStats>([
      [7, stats()],
      [99, stats({ total_points: 4, goals_scored: 1 })],
    ]);
    expect(diffLiveSnapshots(previous, current, CONTEXT)).toHaveLength(0);
  });
});
