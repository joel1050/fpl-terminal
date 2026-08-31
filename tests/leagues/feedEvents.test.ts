import { describe, expect, it } from "vitest";
import {
  feedTone,
  LIVE_FEED_MAX_EVENTS,
  LIVE_FEED_MAX_ROUTINE_EVENTS,
  matchesFeedFilter,
  mergeFeedEvents,
  type FeedFilter,
} from "@/lib/leagues/feedEvents";
import type { FeedEventKind, LiveFeedEvent } from "@/types/leagues";

function event(overrides: Partial<LiveFeedEvent> & { id: string }): LiveFeedEvent {
  return {
    kind: "GOAL",
    eventClass: "ATTACKING",
    playerId: 7,
    pointsDelta: 5,
    seeded: false,
    at: 1_000,
    ...overrides,
  };
}

const routine = (id: string, at = 1_000): LiveFeedEvent =>
  event({ id, at, kind: "APPEARANCE", eventClass: "ROUTINE", pointsDelta: 1 });

describe("mergeFeedEvents", () => {
  it("collapses the same event read twice", () => {
    const first = [event({ id: "7-GOAL-1" })];
    const again = [event({ id: "7-GOAL-1", at: 2_000 })];

    expect(mergeFeedEvents(first, again)).toHaveLength(1);
  });

  it("keeps the reading that was watched happening over the reconstructed one", () => {
    const watched = [event({ id: "7-GOAL-1", minute: "74'", seeded: false, at: 1_000 })];
    const reconstructed = [event({ id: "7-GOAL-1", minute: undefined, seeded: true, at: 5_000 })];

    const [merged] = mergeFeedEvents(watched, reconstructed);
    expect(merged?.minute).toBe("74'");
    expect(merged?.seeded).toBe(false);
  });

  it("lets a later reading replace an earlier one of equal standing", () => {
    const provisional = [event({ id: "7-BONUS CHANGE-12", kind: "BONUS CHANGE", eventClass: "BONUS", pointsDelta: 3, at: 1_000 })];
    const settled = [event({ id: "7-BONUS CHANGE-12", kind: "BONUS CHANGE", eventClass: "BONUS", pointsDelta: 2, at: 2_000 })];

    const merged = mergeFeedEvents(provisional, settled);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.pointsDelta).toBe(2);
  });

  it("puts the newest first and breaks ties by what matters most", () => {
    const merged = mergeFeedEvents([], [
      routine("a-APPEARANCE-1", 2_000),
      event({ id: "b-GOAL-1", at: 2_000 }),
      event({ id: "c-GOAL-1", at: 3_000 }),
    ]);

    expect(merged.map((item) => item.id)).toEqual(["c-GOAL-1", "b-GOAL-1", "a-APPEARANCE-1"]);
  });

  it("never lets routine points push a goal out of the feed", () => {
    const flood = Array.from({ length: LIVE_FEED_MAX_EVENTS * 2 }, (_, index) =>
      routine(`${index}-APPEARANCE-1`, 5_000));
    const goal = event({ id: "7-GOAL-1", at: 1_000 });

    const merged = mergeFeedEvents([goal], flood);

    expect(merged).toContainEqual(goal);
    expect(merged.filter((item) => item.eventClass === "ROUTINE")).toHaveLength(LIVE_FEED_MAX_ROUTINE_EVENTS);
    expect(merged.length).toBeLessThanOrEqual(LIVE_FEED_MAX_EVENTS);
  });

  it("holds a whole Gameweek of scoring events", () => {
    const scoring = Array.from({ length: 300 }, (_, index) => event({ id: `${index}-GOAL-1` }));
    expect(mergeFeedEvents([], scoring)).toHaveLength(300);
  });
});

describe("matchesFeedFilter", () => {
  const mine = { owned: true, ownerCount: 3, userMultiplier: 2 };
  const bench = { owned: true, ownerCount: 1, userMultiplier: 0 };
  const rivals = { owned: false, ownerCount: 2, userMultiplier: 0 };
  const nobody = { owned: false, ownerCount: 0, userMultiplier: 0 };

  const shown = (kind: FeedEventKind, filter: FeedFilter, context: typeof mine, extra: Partial<LiveFeedEvent> = {}) =>
    matchesFeedFilter(event({ id: "x", kind, ...extra }), filter, context);

  it("defaults to the players the viewer or their league actually holds", () => {
    expect(shown("GOAL", "FOCUS", mine)).toBe(true);
    expect(shown("GOAL", "FOCUS", rivals)).toBe(true);
    expect(shown("CLEAN SHEET", "FOCUS", nobody, { eventClass: "DEFENSIVE" })).toBe(false);
  });

  it("still surfaces the events that matter whoever owns them", () => {
    expect(shown("GOAL", "FOCUS", nobody)).toBe(true);
    expect(shown("RED CARD", "FOCUS", nobody, { eventClass: "DISCIPLINE" })).toBe(true);
  });

  it("keeps routine appearance points out of every view but ALL", () => {
    const appearance = { eventClass: "ROUTINE" as const };
    expect(shown("APPEARANCE", "FOCUS", mine, appearance)).toBe(false);
    expect(shown("APPEARANCE", "MY LEAGUE", mine, appearance)).toBe(false);
    expect(shown("APPEARANCE", "ALL", nobody, appearance)).toBe(true);
    // A viewer looking at their own squad should see everything it scored.
    expect(shown("APPEARANCE", "MY TEAM", mine, appearance)).toBe(true);
  });

  it("reads BONUS as bonus alone", () => {
    expect(shown("BONUS CHANGE", "BONUS", mine, { eventClass: "BONUS" })).toBe(true);
    expect(shown("CLEAN SHEET", "BONUS", mine, { eventClass: "DEFENSIVE" })).toBe(false);
    expect(shown("SAVE POINT", "BONUS", mine, { eventClass: "DEFENSIVE" })).toBe(false);
  });

  it("reads NEGATIVE as points the viewer actually lost", () => {
    const card = { pointsDelta: -1, eventClass: "DISCIPLINE" as const };
    expect(shown("YELLOW CARD", "LOSSES", mine, card)).toBe(true);
    expect(shown("YELLOW CARD", "LOSSES", rivals, card)).toBe(true);
    expect(shown("GOAL", "LOSSES", mine)).toBe(false);
    // A booking on the viewer's own bench takes nothing off their score.
    expect(shown("YELLOW CARD", "LOSSES", bench, card)).toBe(false);
  });

  it("limits MY LEAGUE to players a rival actually holds", () => {
    expect(shown("GOAL", "MY LEAGUE", rivals)).toBe(true);
    expect(shown("GOAL", "MY LEAGUE", nobody)).toBe(false);
  });
});

describe("feedTone", () => {
  it("marks what the event did to the viewer's own score", () => {
    // A goal by their captain: five points became ten.
    expect(feedTone(5 * 2)).toBe("gain");
    expect(feedTone(-1)).toBe("loss");
  });

  it("stays neutral for a player who scores nothing for the viewer", () => {
    // Nobody else's squad, and their own bench, both earn them nothing.
    expect(feedTone(0)).toBe("flat");
  });
});
