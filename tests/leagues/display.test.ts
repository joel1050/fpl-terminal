import { describe, expect, it } from "vitest";
import { fixtureTag, kickoffLabel, playerValueLabel, roleMarkerFor } from "@/lib/leagues/display";
import type { LiveEntryPlayer } from "@/types/leagues";

const SHORT_NAMES = new Map([[7, "CHE"], [8, "BOU"]]);

function player(overrides: Partial<LiveEntryPlayer>): LiveEntryPlayer {
  return {
    elementId: 1,
    position: 1,
    elementType: 3,
    positionCode: "MID",
    onBench: false,
    multiplier: 1,
    isCaptain: false,
    isViceCaptain: false,
    points: 0,
    expectedPoints: 6.1,
    status: "TO_PLAY",
    fixtures: [],
    ...overrides,
  };
}

describe("captain and vice-captain markers", () => {
  it("marks only the actual captain with C", () => {
    expect(roleMarkerFor({ isCaptain: true, isViceCaptain: false })).toBe("C");
  });

  it("marks only the actual vice-captain with VC", () => {
    expect(roleMarkerFor({ isCaptain: false, isViceCaptain: true })).toBe("VC");
  });

  it("gives every other player no marker at all", () => {
    expect(roleMarkerFor({ isCaptain: false, isViceCaptain: false })).toBeNull();
  });
});

describe("xP versus P display switching", () => {
  it("shows model xP for a player whose Gameweek has not started", () => {
    const label = playerValueLabel(player({ status: "TO_PLAY", expectedPoints: 6.1 }));
    expect(label).toEqual({ value: "6.1", unit: "xP", started: false });
  });

  it("shows actual points once a player is live", () => {
    const label = playerValueLabel(player({ status: "LIVE", points: 9 }));
    expect(label).toEqual({ value: "9", unit: "P", started: true });
  });

  it("shows actual points after the fixture finished", () => {
    const label = playerValueLabel(player({ status: "DONE", points: 12 }));
    expect(label.unit).toBe("P");
    expect(label.started).toBe(true);
  });

  it("keeps actual accumulated points as primary in a partially played double gameweek", () => {
    const label = playerValueLabel(player({ status: "LIVE", points: 4 }));
    expect(label.value).toBe("4");
    expect(label.unit).toBe("P");
  });
});

describe("captaincy multiplied on the card", () => {
  it("doubles the captain's projection before kickoff", () => {
    const label = playerValueLabel(player({ status: "TO_PLAY", expectedPoints: 6.1, multiplier: 2, isCaptain: true }));
    expect(label).toEqual({ value: "12.2", unit: "xP", started: false });
  });

  it("doubles the captain's actual points once they are playing", () => {
    const label = playerValueLabel(player({ status: "LIVE", points: 9, multiplier: 2, isCaptain: true }));
    expect(label.value).toBe("18");
  });

  it("triples a Triple Captain", () => {
    const label = playerValueLabel(player({ status: "TO_PLAY", expectedPoints: 6.1, multiplier: 3, isCaptain: true }));
    expect(label.value).toBe("18.3");
  });

  it("shows a benched player's own value rather than nothing", () => {
    const label = playerValueLabel(player({ status: "DONE", points: 5, multiplier: 0, onBench: true }));
    expect(label.value).toBe("5");
  });
});

describe("opponent tags", () => {
  it("renders kickoff time for upcoming fixtures", () => {
    const tag = fixtureTag(
      { fixtureId: 1, opponentTeamId: 8, isHome: false, state: "UPCOMING", kickoffTime: "2026-08-22T17:30:00Z" },
      SHORT_NAMES,
    );
    expect(tag.startsWith("BOU(A)")).toBe(true);
    expect(tag).toContain(kickoffLabel("2026-08-22T17:30:00Z"));
  });

  it("appends the current minute while a match is live", () => {
    const tag = fixtureTag({ fixtureId: 2, opponentTeamId: 7, isHome: true, state: "LIVE", minutes: 74 }, SHORT_NAMES);
    expect(tag).toBe("CHE(H) · 74'");
  });

  it("labels finished matches with FT", () => {
    const tag = fixtureTag({ fixtureId: 3, opponentTeamId: 7, isHome: true, state: "FINISHED", minutes: 90 }, SHORT_NAMES);
    expect(tag).toBe("CHE(H) · FT");
  });

  it("caps displayed minutes at 90", () => {
    const tag = fixtureTag({ fixtureId: 4, opponentTeamId: 7, isHome: true, state: "LIVE", minutes: 120 }, SHORT_NAMES);
    expect(tag).toBe("CHE(H) · 90'");
  });
});
