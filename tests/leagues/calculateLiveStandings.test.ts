import { describe, expect, it } from "vitest";
import { calculateLiveStandings } from "@/lib/leagues/calculateLiveStandings";
import type { EntryPick, EntryPicks, ClassicStandingRow, FixtureView } from "@/types/leagues";
import type { LiveStats } from "@/lib/leagues/calculateLiveEntry";

const USER_ENTRY_ID = 4827193;

const ROWS: ClassicStandingRow[] = [
  { entryId: 111, entryName: "Guardians United", playerName: "Alice Chen", rank: 1, lastRank: 1, total: 1900, eventTotal: 61 },
  { entryId: USER_ENTRY_ID, entryName: "Expected Toulouse", playerName: "Joel Tester", rank: 2, lastRank: 5, total: 1890, eventTotal: 58 },
  { entryId: 222, entryName: "Green Azure FC", playerName: "Mike Li", rank: 3, lastRank: 2, total: 1885, eventTotal: 47 },
];

function memberPicks(
  entryId: number,
  totalPoints: number,
  recordedPoints: number,
  starters: Array<{ element: number; multiplier?: number }>,
): EntryPicks {
  const picks: EntryPick[] = starters.map((starter, index) => ({
    element: starter.element,
    position: index + 1,
    elementType: 3,
    multiplier: starter.multiplier ?? 1,
    isCaptain: false,
    isViceCaptain: false,
  }));
  return {
    entryId,
    gameweek: 26,
    activeChip: null,
    automaticSubs: [],
    picks,
    entryHistory: { event: 26, points: recordedPoints, totalPoints, eventTransfersCost: 0 },
  };
}

function fixture(id: number, homeTeamId: number, awayTeamId: number, state: FixtureView["state"]): FixtureView {
  return {
    id,
    kickoffTime: null,
    homeTeamId,
    awayTeamId,
    homeShortName: `T${homeTeamId}`,
    awayShortName: `T${awayTeamId}`,
    homeScore: state === "UPCOMING" ? null : 1,
    awayScore: state === "UPCOMING" ? null : 0,
    state,
    minutes: state === "FINISHED" ? 90 : undefined,
  };
}

const FIXTURES: FixtureView[] = [
  fixture(1, 100, 101, "FINISHED"),
  fixture(2, 102, 103, "UPCOMING"),
];

const TEAM_BY_ELEMENT = new Map<number, number>([
  [7, 100],
  [8, 101],
  [9, 102],
]);

const LIVE_STATS = new Map<number, LiveStats>([
  [7, { total_points: 10, minutes: 60 }],
  [8, { total_points: 5, minutes: 60 }],
]);

function completeInput() {
  return {
    rows: ROWS,
    userEntryId: USER_ENTRY_ID,
    picksByEntry: new Map([
      [111, memberPicks(111, 1900, 50, [{ element: 8 }])],
      [USER_ENTRY_ID, memberPicks(USER_ENTRY_ID, 1890, 0, [{ element: 7, multiplier: 2 }])],
      [222, memberPicks(222, 1885, 45, [{ element: 9 }])],
    ]),
    liveElementsByElement: LIVE_STATS,
    fixtures: FIXTURES,
    teamIdByElement: TEAM_BY_ELEMENT,
    completePopulation: true,
  };
}

describe("calculateLiveStandings", () => {
  it("computes live totals without double-counting the current Gameweek", () => {
    const result = calculateLiveStandings(completeInput());
    expect(result.completePopulation).toBe(true);
    expect(result.calculatedEntries).toBe(3);
    const leader = result.rows[0];
    expect(leader.isUser).toBe(true);
    // pre-Gameweek total is official total minus already-recorded points: 1890 - 0.
    expect(leader.preGameweekTotal).toBe(1890);
    expect(leader.gameweekPoints).toBe(20);
    expect(leader.liveTotal).toBe(1910);
  });

  it("sorts by live total and derives movement from the official rank", () => {
    const result = calculateLiveStandings(completeInput());
    expect(result.rows.map((row) => row.entryId)).toEqual([USER_ENTRY_ID, 111, 222]);
    expect(result.rows.map((row) => row.localRank)).toEqual([1, 2, 3]);
    expect(result.rows.find((row) => row.entryId === USER_ENTRY_ID)?.movement).toBe(1);
    expect(result.rows.find((row) => row.entryId === 111)?.movement).toBe(-1);
    expect(result.rows.find((row) => row.entryId === 222)?.movement).toBe(0);
  });

  it("counts remaining starting fixtures per member", () => {
    const result = calculateLiveStandings(completeInput());
    // Entry 222 owns the only player whose fixture has not started yet.
    expect(result.rows.find((row) => row.entryId === 222)?.leftToPlay).toBe(1);
    expect(result.rows.find((row) => row.entryId === USER_ENTRY_ID)?.leftToPlay).toBe(0);
  });

  it("never claims a local live rank when the league population is incomplete", () => {
    const result = calculateLiveStandings({ ...completeInput(), completePopulation: false });
    expect(result.completePopulation).toBe(false);
    expect(result.calculatedEntries).toBe(0);
    expect(result.rows.map((row) => Number.isNaN(row.movement))).toEqual([true, true, true]);
    expect(result.rows.map((row) => Number.isNaN(row.gameweekPoints))).toEqual([true, true, true]);
    expect(result.rows[0].localRank).toBe(1);
    expect(result.rows[0].liveTotal).toBe(1900);
  });

  it("keeps FPL's own Gameweek points when no live figure can be claimed", () => {
    const result = calculateLiveStandings({ ...completeInput(), completePopulation: false });
    expect(result.rows.map((row) => row.officialGameweekPoints)).toEqual([61, 58, 47]);
  });

  it("falls back to official totals when any member's picks are missing", () => {
    const input = completeInput();
    input.picksByEntry.delete(222);
    const result = calculateLiveStandings(input);
    expect(result.completePopulation).toBe(false);
    expect(result.calculatedEntries).toBe(0);
    expect(result.rows.find((row) => row.entryId === USER_ENTRY_ID)?.officialTotal).toBe(1890);
  });
});
