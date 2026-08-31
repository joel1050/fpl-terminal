import { describe, expect, it } from "vitest";
import { diffLiveSnapshots, type LiveExplainBlock } from "@/lib/leagues/diffLiveSnapshots";
import type { LiveStats } from "@/lib/leagues/calculateLiveEntry";
import type { Position } from "@/types/player";

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
  positionByPlayer: new Map<number, Position>([[7, "MID"], [9, "DEF"]]),
  minuteLabelByTeam: new Map([[1, "74'"], [2, "68'"]]),
  now: NOW,
};

const kindsOf = (events: ReturnType<typeof diffLiveSnapshots>) => events.map((event) => event.kind);
const of = (events: ReturnType<typeof diffLiveSnapshots>, kind: string) =>
  events.filter((event) => event.kind === kind);

describe("diffLiveSnapshots", () => {
  describe("reading a Gameweek already in progress", () => {
    it("reconstructs every instance from cumulative stats on the first read", () => {
      const current = new Map([[7, stats({ total_points: 13, minutes: 90, goals_scored: 2, assists: 1 })]]);
      const events = diffLiveSnapshots(undefined, current, CONTEXT);

      expect(of(events, "GOAL")).toHaveLength(2);
      expect(of(events, "ASSIST")).toHaveLength(1);
      expect(of(events, "GOAL").map((event) => event.id)).toEqual(["7-GOAL-1", "7-GOAL-2"]);
    });

    it("counts a keeper's save points by threshold, not by save", () => {
      const current = new Map([[9, stats({ total_points: 4, minutes: 90, saves: 6 })]]);
      const events = diffLiveSnapshots(undefined, current, CONTEXT);

      expect(of(events, "SAVE POINT")).toHaveLength(2);
      expect(of(events, "SAVE POINT").map((event) => event.pointsDelta)).toEqual([1, 1]);
    });

    it("prices each reconstructed row on its own, not on the player's total", () => {
      const current = new Map([[7, stats({ total_points: 13, minutes: 90, goals_scored: 2, assists: 1 })]]);
      const events = diffLiveSnapshots(undefined, current, CONTEXT);

      expect(of(events, "GOAL").map((event) => event.pointsDelta)).toEqual([5, 5]);
      expect(of(events, "ASSIST")[0]?.pointsDelta).toBe(3);
      expect(events.reduce((sum, event) => sum + event.pointsDelta, 0)).toBe(13);
    });

    it("marks reconstructed rows and leaves their minute blank", () => {
      const current = new Map([[7, stats({ total_points: 6, minutes: 90, goals_scored: 1 })]]);
      const [goal] = of(diffLiveSnapshots(undefined, current, CONTEXT), "GOAL");

      expect(goal?.seeded).toBe(true);
      expect(goal?.minute).toBeUndefined();
    });

    it("treats an empty previous snapshot the same as no previous snapshot", () => {
      const current = new Map([[7, stats({ total_points: 5, goals_scored: 1, minutes: 74 })]]);
      expect(kindsOf(diffLiveSnapshots(new Map(), current, CONTEXT))).toContain("GOAL");
    });

    it("gives the same event the same id however it was read", () => {
      const kickoff = new Map([[7, stats({ minutes: 74, total_points: 1 })]]);
      const scored = new Map([[7, stats({ total_points: 6, minutes: 74, goals_scored: 1 })]]);

      const watched = diffLiveSnapshots(kickoff, scored, CONTEXT);
      const reconstructed = diffLiveSnapshots(undefined, scored, CONTEXT);

      expect(of(watched, "GOAL")[0]?.id).toBe(of(reconstructed, "GOAL")[0]?.id);
    });
  });

  describe("point attribution", () => {
    it("prices each event from FPL's own breakdown when it sends one", () => {
      const explain: LiveExplainBlock[] = [{
        fixtureId: 12,
        stats: [
          { identifier: "minutes", points: 2, value: 90 },
          { identifier: "goals_scored", points: 12, value: 2 },
          { identifier: "clean_sheets", points: 4, value: 1 },
        ],
      }];
      const current = new Map([[9, stats({ total_points: 18, minutes: 90, goals_scored: 2, clean_sheets: 1 })]]);
      const events = diffLiveSnapshots(undefined, current, {
        ...CONTEXT,
        explainByPlayer: new Map([[9, explain]]),
      });

      expect(of(events, "GOAL").map((event) => event.pointsDelta)).toEqual([6, 6]);
      expect(of(events, "CLEAN SHEET")[0]?.pointsDelta).toBe(4);
      expect(of(events, "GOAL")[0]?.fixtureId).toBe(12);
    });

    it("falls back to the standard points table when no breakdown arrives", () => {
      const current = new Map([
        [7, stats({ total_points: 5, minutes: 1, goals_scored: 1 })],
        [9, stats({ total_points: 6, minutes: 1, goals_scored: 1 })],
      ]);
      const events = diffLiveSnapshots(undefined, current, CONTEXT);

      expect(of(events, "GOAL").find((event) => event.playerId === 7)?.pointsDelta).toBe(5);
      expect(of(events, "GOAL").find((event) => event.playerId === 9)?.pointsDelta).toBe(6);
    });

    it("leaves the fixture unset when a Double Gameweek splits the stat", () => {
      const explain: LiveExplainBlock[] = [
        { fixtureId: 12, stats: [{ identifier: "goals_scored", points: 5, value: 1 }] },
        { fixtureId: 18, stats: [{ identifier: "goals_scored", points: 5, value: 1 }] },
      ];
      const current = new Map([[7, stats({ total_points: 12, minutes: 90, goals_scored: 2 })]]);
      const events = diffLiveSnapshots(undefined, current, {
        ...CONTEXT,
        explainByPlayer: new Map([[7, explain]]),
      });

      expect(of(events, "GOAL")).toHaveLength(2);
      expect(of(events, "GOAL").every((event) => event.fixtureId === undefined)).toBe(true);
    });

    it("keeps the rows adding up to the player's points change", () => {
      const previous = new Map([[7, stats()]]);
      const current = new Map([[7, stats({ total_points: 9, minutes: 90, goals_scored: 1 })]]);
      const events = diffLiveSnapshots(previous, current, CONTEXT);
      const total = events.reduce((sum, event) => sum + event.pointsDelta, 0);

      expect(total).toBe(9);
      expect(of(events, "POINTS CHANGE")[0]?.pointsDelta).toBe(2);
    });

    it("names both appearance points and keeps them out of the way", () => {
      const current = new Map([[7, stats({ total_points: 2, minutes: 90 })]]);
      const events = diffLiveSnapshots(undefined, current, CONTEXT);

      expect(kindsOf(events)).toEqual(expect.arrayContaining(["APPEARANCE", "SIXTY MINUTES"]));
      expect(events.every((event) => event.eventClass === "ROUTINE")).toBe(true);
      expect(kindsOf(events)).not.toContain("POINTS CHANGE");
    });

    it("does not spend FPL's single minutes line on both appearance points", () => {
      const explain: LiveExplainBlock[] = [{
        fixtureId: 12,
        stats: [{ identifier: "minutes", points: 2, value: 90 }],
      }];
      const current = new Map([[7, stats({ total_points: 2, minutes: 90 })]]);
      const events = diffLiveSnapshots(undefined, current, {
        ...CONTEXT,
        explainByPlayer: new Map([[7, explain]]),
      });

      expect(events.reduce((sum, event) => sum + event.pointsDelta, 0)).toBe(2);
      expect(kindsOf(events)).not.toContain("POINTS CHANGE");
    });

    it("gives a substitute the appearance point without the hour", () => {
      const previous = new Map([[7, stats()]]);
      const current = new Map([[7, stats({ total_points: 1, minutes: 12 })]]);
      const events = diffLiveSnapshots(previous, current, CONTEXT);

      expect(kindsOf(events)).toEqual(["APPEARANCE"]);
    });
  });

  describe("watching a Gameweek as it happens", () => {
    it("classifies a goal with the player's minute", () => {
      const previous = new Map([[7, stats({ minutes: 60, total_points: 2 })]]);
      const current = new Map([[7, stats({ total_points: 7, goals_scored: 1, minutes: 74 })]]);
      const [event] = of(diffLiveSnapshots(previous, current, CONTEXT), "GOAL");

      expect(event).toMatchObject({
        kind: "GOAL",
        playerId: 7,
        playerName: "Saka",
        pointsDelta: 5,
        minute: "74'",
        seeded: false,
        detail: "goals_scored 0 → 1",
      });
    });

    it("reports every stat that moved in one window, not just the first", () => {
      const previous = new Map([[7, stats({ minutes: 60, total_points: 2 })]]);
      const current = new Map([[7, stats({ total_points: 9, minutes: 74, goals_scored: 1, assists: 1, yellow_cards: 1 })]]);
      const kinds = kindsOf(diffLiveSnapshots(previous, current, CONTEXT));

      expect(kinds).toEqual(expect.arrayContaining(["GOAL", "ASSIST", "YELLOW CARD"]));
    });

    it("names the penalty events using the stat keys FPL actually sends", () => {
      const previous = new Map([[7, stats({ total_points: 2, minutes: 74 })], [9, stats({ total_points: 3, minutes: 74 })]]);
      const current = new Map([
        [7, stats({ total_points: 0, minutes: 74, penalties_missed: 1 })],
        [9, stats({ total_points: 8, minutes: 74, penalties_saved: 1 })],
      ]);
      const kinds = kindsOf(diffLiveSnapshots(previous, current, CONTEXT));

      expect(kinds).toContain("PENALTY MISS");
      expect(kinds).toContain("PENALTY SAVE");
    });

    it("awards a save point only when a three-save threshold is crossed", () => {
      const previous = new Map([[9, stats({ total_points: 2, minutes: 74, saves: 3 })]]);
      const crossing = new Map([[9, stats({ total_points: 3, minutes: 74, saves: 6 })]]);
      expect(kindsOf(diffLiveSnapshots(previous, crossing, CONTEXT))).toContain("SAVE POINT");

      const belowThreshold = new Map([[9, stats({ total_points: 2, minutes: 74, saves: 5 })]]);
      expect(diffLiveSnapshots(previous, belowThreshold, CONTEXT)).toHaveLength(0);
    });

    it("ignores a snapshot that has not moved", () => {
      const held = new Map([[7, stats({ total_points: 6, minutes: 90, goals_scored: 1 })]]);
      expect(diffLiveSnapshots(held, new Map(held), CONTEXT)).toHaveLength(0);
    });

    it("reconstructs a player who was missing from the previous snapshot", () => {
      const previous = new Map([[7, stats({ minutes: 74 })]]);
      const current = new Map([
        [7, stats({ minutes: 74 })],
        [9, stats({ total_points: 6, minutes: 74, goals_scored: 1 })],
      ]);
      const [goal] = of(diffLiveSnapshots(previous, current, CONTEXT), "GOAL");

      expect(goal?.playerId).toBe(9);
      expect(goal?.seeded).toBe(true);
    });
  });

  describe("bonus", () => {
    it("reports where the bonus stands rather than each revision", () => {
      const previous = new Map([[7, stats({ total_points: 6, minutes: 90, bonus: 1 })]]);
      const current = new Map([[7, stats({ total_points: 8, minutes: 90, bonus: 3 })]]);
      const [bonus] = of(diffLiveSnapshots(previous, current, CONTEXT), "BONUS CHANGE");

      expect(bonus?.pointsDelta).toBe(3);
      expect(bonus?.detail).toBe("bonus 1 → 3");
    });

    it("keeps one row per fixture so a settled score replaces the provisional one", () => {
      const explain: LiveExplainBlock[] = [{ fixtureId: 12, stats: [{ identifier: "bonus", points: 3, value: 3 }] }];
      const settled: LiveExplainBlock[] = [{ fixtureId: 12, stats: [{ identifier: "bonus", points: 2, value: 2 }] }];

      const provisional = diffLiveSnapshots(
        new Map([[7, stats({ total_points: 6, minutes: 90 })]]),
        new Map([[7, stats({ total_points: 9, minutes: 90, bonus: 3 })]]),
        { ...CONTEXT, explainByPlayer: new Map([[7, explain]]) },
      );
      const final = diffLiveSnapshots(
        new Map([[7, stats({ total_points: 9, minutes: 90, bonus: 3 })]]),
        new Map([[7, stats({ total_points: 8, minutes: 90, bonus: 2 })]]),
        { ...CONTEXT, explainByPlayer: new Map([[7, settled]]) },
      );

      expect(of(provisional, "BONUS CHANGE")[0]?.id).toBe(of(final, "BONUS CHANGE")[0]?.id);
      expect(of(final, "BONUS CHANGE")[0]?.pointsDelta).toBe(2);
    });

    it("does not repeat a bonus score that has not moved", () => {
      const held = new Map([[7, stats({ total_points: 8, minutes: 90, bonus: 3 })]]);
      expect(diffLiveSnapshots(held, new Map(held), CONTEXT)).toHaveLength(0);
    });
  });

  it("ranks a crowded batch so the goals survive the cap", () => {
    const current = new Map<number, LiveStats>();
    for (let playerId = 1; playerId <= 300; playerId += 1) {
      current.set(playerId, stats({ total_points: 2, minutes: 90 }));
    }
    current.set(999, stats({ total_points: 8, minutes: 90, goals_scored: 1 }));

    const events = diffLiveSnapshots(undefined, current, CONTEXT);
    expect(events.filter((event) => event.kind === "GOAL")).toHaveLength(1);
  });
});
