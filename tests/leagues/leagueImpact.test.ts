import { describe, expect, it } from "vitest";
import {
  buildLeagueOwnership,
  leagueAverageMultiplier,
  ownersOf,
  readLeagueImpact,
  relativeLeagueImpact,
} from "@/lib/leagues/leagueImpact";
import type { EntryPicks } from "@/types/leagues";

function picksOf(entryId: number, playerId: number, multiplier: number): EntryPicks {
  return {
    entryId,
    gameweek: 1,
    activeChip: null,
    automaticSubs: [],
    picks: [{ element: playerId, position: 1, elementType: 3, multiplier, isCaptain: multiplier > 1, isViceCaptain: false }],
    entryHistory: { event: 1 },
  };
}

describe("leagueAverageMultiplier", () => {
  it("averages each manager's multiplier across the sampled members", () => {
    const members = [picksOf(1, 7, 2), picksOf(2, 7, 1), picksOf(3, 7, 0), picksOf(4, 7, 1)];
    expect(leagueAverageMultiplier(members, 7)).toBeCloseTo((2 + 1 + 0 + 1) / 4);
  });

  it("treats non-owners as zero and handles an empty sample", () => {
    const members = [picksOf(1, 7, 2), picksOf(2, 9, 1)];
    expect(leagueAverageMultiplier(members, 7)).toBe(1);
    expect(leagueAverageMultiplier([], 7)).toBe(0);
  });
});

describe("relativeLeagueImpact", () => {
  it("scales the raw delta by the user's edge over the league average", () => {
    expect(relativeLeagueImpact(4, 2, 0.5)).toBe(6);
  });

  it("is negative when the league holds a stronger multiplier than the user", () => {
    expect(relativeLeagueImpact(5, 0, 1)).toBe(-5);
  });

  it("rounds the displayed impact to one decimal", () => {
    expect(relativeLeagueImpact(5, 2, 0.75)).toBe(6.3);
  });
});

describe("buildLeagueOwnership", () => {
  it("counts owners and averages over the whole sample in one pass", () => {
    const members = [picksOf(1, 7, 2), picksOf(2, 7, 1), picksOf(3, 9, 1), picksOf(4, 7, 0)];
    const ownership = buildLeagueOwnership(members, true);

    expect(ownership.sampleSize).toBe(4);
    // The fourth manager benched the player, so they do not count as an owner.
    expect(ownersOf(ownership, 7)).toBe(2);
    expect(ownersOf(ownership, 99)).toBe(0);
    expect(leagueAverageMultiplier(members, 7)).toBeCloseTo(3 / 4);
  });
});

describe("readLeagueImpact", () => {
  const ownership = (complete: boolean) =>
    buildLeagueOwnership([picksOf(1, 7, 2), picksOf(2, 7, 1)], complete);
  const read = (status: Parameters<typeof readLeagueImpact>[0]["status"], complete = true) =>
    readLeagueImpact({ ownership: ownership(complete), status, playerId: 7, pointsDelta: 4, userMultiplier: 2 });

  it("compares against the whole league when the whole league is loaded", () => {
    expect(read("READY")).toEqual({ kind: "READY", impact: 2, basis: "LEAGUE", sampleSize: 2 });
  });

  it("says when the comparison is only against the rows it has", () => {
    expect(read("READY", false)).toMatchObject({ basis: "SAMPLE", sampleSize: 2 });
  });

  it("reports no number rather than a number built on nothing", () => {
    expect(read("IDLE").kind).toBe("UNAVAILABLE");
    expect(read("ERROR").kind).toBe("UNAVAILABLE");
    expect(read("LOADING").kind).toBe("LOADING");
    expect(readLeagueImpact({
      ownership: buildLeagueOwnership([], true),
      status: "READY",
      playerId: 7,
      pointsDelta: 4,
      userMultiplier: 2,
    }).kind).toBe("UNAVAILABLE");
  });
});
