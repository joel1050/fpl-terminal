import { describe, expect, it } from "vitest";
import { applyFallbackAutosubs, calculateLiveEntry, type LiveStats } from "@/lib/leagues/calculateLiveEntry";
import type { EntryPick, EntryPicks, FixtureView } from "@/types/leagues";

function pick(
  element: number,
  position: number,
  elementType: number,
  multiplier = 0,
  flags: { captain?: boolean; vice?: boolean } = {},
): EntryPick {
  return {
    element,
    position,
    elementType,
    multiplier,
    isCaptain: flags.captain ?? false,
    isViceCaptain: flags.vice ?? false,
  };
}

function picksOf(list: EntryPick[], overrides: Partial<EntryPicks> = {}): EntryPicks {
  return {
    entryId: 1,
    gameweek: 1,
    activeChip: null,
    automaticSubs: [],
    picks: list,
    entryHistory: { event: 1, points: 0, totalPoints: 0, eventTransfersCost: 0 },
    ...overrides,
  };
}

function fixture(
  id: number,
  homeTeamId: number,
  awayTeamId: number,
  state: FixtureView["state"],
  minutes?: number,
): FixtureView {
  return {
    id,
    kickoffTime: state === "UPCOMING" ? "2026-08-22T17:30:00Z" : null,
    homeTeamId,
    awayTeamId,
    bonusSettled: state === "FINISHED",
    homeShortName: `T${homeTeamId}`,
    awayShortName: `T${awayTeamId}`,
    homeScore: state === "UPCOMING" ? null : 1,
    awayScore: state === "UPCOMING" ? null : 0,
    state,
    minutes,
  };
}

function stats(totalPoints: number, extra: LiveStats = {}): LiveStats {
  return { total_points: totalPoints, minutes: totalPoints > 0 ? 60 : 0, ...extra };
}

const TEAM_BY_ELEMENT = new Map<number, number>([
  [101, 10],
  [102, 11],
  [103, 11],
  [111, 10],
  [112, 10],
  [113, 10],
  [121, 9],
  [122, 9],
  [131, 8],
  [141, 12],
]);

const BASE_XI: EntryPick[] = [
  pick(101, 1, 1, 1),
  pick(111, 2, 2, 1),
  pick(112, 3, 2, 1),
  pick(113, 4, 2, 1),
  pick(121, 5, 3, 1),
  pick(122, 6, 3, 1),
  pick(131, 7, 4, 1, { captain: true }),
  pick(141, 8, 4, 1),
];

const BASE_BENCH: EntryPick[] = [
  pick(102, 12, 1, 0),
  pick(103, 13, 3, 0),
];

const BASE_FIXTURES: FixtureView[] = [
  fixture(1, 10, 9, "LIVE", 60),
  fixture(2, 8, 12, "FINISHED", 90),
];

describe("calculateLiveEntry", () => {
  it("scores a normal starter with multiplier 1 and ignores a zero-multiplier bench", () => {
    const result = calculateLiveEntry({
      picks: picksOf([...BASE_XI, ...BASE_BENCH]),
      liveElementsByElement: new Map([[101, stats(6)]]),
      fixtures: BASE_FIXTURES,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    expect(result.grossPoints).toBe(6);
    expect(result.startersPoints).toBe(6);
    expect(result.benchPoints).toBe(0);
    expect(result.netPoints).toBe(6);
    expect(result.hitCost).toBe(0);
  });

  it("doubles captain points using FPL's supplied multiplier", () => {
    const captain = pick(101, 1, 1, 2, { captain: true });
    const result = calculateLiveEntry({
      picks: picksOf([captain, ...BASE_XI.slice(1), ...BASE_BENCH]),
      liveElementsByElement: new Map([[101, stats(6)]]),
      fixtures: BASE_FIXTURES,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    expect(result.grossPoints).toBe(12);
  });

  it("applies the Triple Captain multiplier of 3", () => {
    const tripleCaptain = pick(101, 1, 1, 3, { captain: true });
    const result = calculateLiveEntry({
      picks: picksOf([tripleCaptain, ...BASE_XI.slice(1), ...BASE_BENCH], { activeChip: "3xc" }),
      liveElementsByElement: new Map([[101, stats(6)]]),
      fixtures: BASE_FIXTURES,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    expect(result.grossPoints).toBe(18);
    expect(result.activeChip).toBe("3xc");
  });

  it("counts Bench Boost bench points because FPL supplies multiplier 1 for all 15", () => {
    const boostedBench: EntryPick[] = [pick(102, 12, 1, 1), pick(103, 13, 3, 1)];
    const result = calculateLiveEntry({
      picks: picksOf([...BASE_XI, ...boostedBench], { activeChip: "bboost" }),
      liveElementsByElement: new Map([
        [102, stats(2)],
        [103, stats(5)],
      ]),
      fixtures: BASE_FIXTURES,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    expect(result.benchPoints).toBe(7);
    expect(result.grossPoints).toBe(7);
  });

  it("subtracts the official transfer-hit cost", () => {
    const result = calculateLiveEntry({
      picks: picksOf([...BASE_XI, ...BASE_BENCH], {
        entryHistory: { event: 1, points: 20, totalPoints: 1000, eventTransfersCost: 8 },
      }),
      liveElementsByElement: new Map([[101, stats(6)]]),
      fixtures: BASE_FIXTURES,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    expect(result.hitCost).toBe(8);
    expect(result.netPoints).toBe(-2);
  });

  it("keeps negative player points", () => {
    const result = calculateLiveEntry({
      picks: picksOf([...BASE_XI, ...BASE_BENCH]),
      liveElementsByElement: new Map([
        [101, stats(-2)],
        [111, stats(-1)],
      ]),
      fixtures: BASE_FIXTURES,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    expect(result.grossPoints).toBe(-3);
    expect(result.netPoints).toBe(-3);
  });

  it("applies official automatic substitutions before scoring", () => {
    const result = calculateLiveEntry({
      picks: picksOf([...BASE_XI, ...BASE_BENCH], {
        automaticSubs: [{ elementIn: 103, elementOut: 121 }],
      }),
      liveElementsByElement: new Map([
        [121, stats(0, { minutes: 0 })],
        [103, stats(5, { minutes: 60 })],
      ]),
      fixtures: BASE_FIXTURES,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    expect(result.grossPoints).toBe(5);
    expect(result.startersPoints).toBe(0);
    expect(result.benchPoints).toBe(5);
  });

  it("gives the armband to the vice-captain when the captain is substituted out", () => {
    // FPL never hands the armband to a bench player: the vice-captain takes it
    // and the substitute comes on at a plain multiplier of one.
    const result = calculateLiveEntry({
      picks: picksOf(
        [
          ...BASE_XI.slice(0, 6),
          pick(131, 7, 4, 2, { captain: true }),
          pick(141, 8, 4, 1, { vice: true }),
          ...BASE_BENCH,
        ],
        { automaticSubs: [{ elementIn: 103, elementOut: 131 }] },
      ),
      liveElementsByElement: new Map([
        [131, stats(0, { minutes: 0 })],
        [103, stats(7, { minutes: 90 })],
        [141, stats(5, { minutes: 90 })],
      ]),
      fixtures: BASE_FIXTURES,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    const byId = new Map(result.playerPoints.map((player) => [player.elementId, player]));
    expect(byId.get(131)?.multiplier).toBe(0);
    expect(byId.get(103)?.multiplier).toBe(1);
    expect(byId.get(141)?.multiplier).toBe(2);
    // Substitute 7 plus the doubled vice-captain 10.
    expect(result.grossPoints).toBe(17);
  });

  it("triples the vice-captain when a Triple Captain blanks and is substituted", () => {
    const tripleCaptain = pick(131, 7, 4, 3, { captain: true });
    const result = calculateLiveEntry({
      picks: picksOf(
        [...BASE_XI.slice(0, 6), tripleCaptain, pick(141, 8, 4, 1, { vice: true }), ...BASE_BENCH],
        { activeChip: "3xc", automaticSubs: [{ elementIn: 103, elementOut: 131 }] },
      ),
      liveElementsByElement: new Map([
        [131, stats(0, { minutes: 0 })],
        [103, stats(2, { minutes: 90 })],
        [141, stats(4, { minutes: 90 })],
      ]),
      fixtures: BASE_FIXTURES,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    const byId = new Map(result.playerPoints.map((player) => [player.elementId, player]));
    expect(byId.get(141)?.multiplier).toBe(3);
    expect(byId.get(103)?.multiplier).toBe(1);
    expect(result.grossPoints).toBe(14);
  });

  it("moves the C marker to the vice-captain once the armband passes to them", () => {
    const captainIdle = pick(131, 7, 4, 2, { captain: true });
    const vicePlaying = pick(121, 5, 3, 1, { vice: true });
    const squad: EntryPick[] = [
      pick(101, 1, 1, 1),
      pick(111, 2, 2, 1),
      pick(112, 3, 2, 1),
      pick(113, 4, 2, 1),
      vicePlaying,
      pick(122, 6, 3, 1),
      captainIdle,
      pick(141, 8, 4, 1),
      ...BASE_BENCH,
    ];
    const result = calculateLiveEntry({
      picks: picksOf(squad),
      liveElementsByElement: new Map([
        [131, stats(0, { minutes: 0 })],
        [121, stats(4, { minutes: 75 })],
      ]),
      fixtures: [fixture(1, 8, 12, "FINISHED", 90), fixture(2, 10, 9, "LIVE", 75)],
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    const byId = new Map(result.playerPoints.map((player) => [player.elementId, player]));
    expect(byId.get(121)?.isCaptain).toBe(true);
    expect(byId.get(121)?.isViceCaptain).toBe(false);
    expect(byId.get(131)?.isCaptain).toBe(false);
  });

  it("keeps the C marker on a captain who is still to play", () => {
    const result = calculateLiveEntry({
      picks: picksOf([
        ...BASE_XI.slice(0, 6),
        pick(131, 7, 4, 2, { captain: true }),
        pick(141, 8, 4, 1, { vice: true }),
        ...BASE_BENCH,
      ]),
      liveElementsByElement: new Map(),
      fixtures: BASE_FIXTURES,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    const byId = new Map(result.playerPoints.map((player) => [player.elementId, player]));
    expect(byId.get(131)?.isCaptain).toBe(true);
    expect(byId.get(141)?.isViceCaptain).toBe(true);
  });

  it("previews a fallback autosub when the official feed has not published one", () => {
    const idleGoalkeeperXI: EntryPick[] = [
      pick(101, 1, 1, 1),
      ...BASE_XI.slice(1),
    ];
    const multipliers = applyFallbackAutosubs(
      picksOf([...idleGoalkeeperXI, ...BASE_BENCH]),
      new Map<number, LiveStats>([
        [101, { total_points: 0, minutes: 0 }],
        [102, { total_points: 3, minutes: 60 }],
      ]),
      new Map([[101, { status: "DONE", started: true, remaining: 0, finished: 1, live: 0 }]]),
    );
    expect(multipliers.get(101)).toBe(0);
    expect(multipliers.get(102)).toBe(1);
  });

  it("moves the armband to the vice-captain when the captain completes zero minutes", () => {
    const captainIdle = pick(131, 7, 4, 2, { captain: true });
    const vicePlaying = pick(121, 5, 3, 1, { vice: true });
    const squad: EntryPick[] = [
      pick(101, 1, 1, 1),
      pick(111, 2, 2, 1),
      pick(112, 3, 2, 1),
      pick(113, 4, 2, 1),
      vicePlaying,
      pick(122, 6, 3, 1),
      captainIdle,
      pick(141, 8, 4, 1),
      ...BASE_BENCH,
    ];
    const result = calculateLiveEntry({
      picks: picksOf(squad),
      liveElementsByElement: new Map([
        [131, stats(0, { minutes: 0 })],
        [121, stats(4, { minutes: 75 })],
      ]),
      fixtures: [
        fixture(1, 10, 9, "LIVE", 60),
        fixture(2, 8, 12, "FINISHED", 90),
        fixture(3, 9, 10, "FINISHED", 90),
      ],
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    expect(result.grossPoints).toBe(8);
  });

  it("keeps an autosub at 1x and moves a blanking captain's multiplier to the vice-captain", () => {
    const captainIdle = pick(131, 7, 4, 2, { captain: true });
    const vicePlaying = pick(121, 5, 3, 1, { vice: true });
    const result = calculateLiveEntry({
      picks: picksOf([
        ...BASE_XI.slice(0, 4),
        vicePlaying,
        BASE_XI[5],
        captainIdle,
        BASE_XI[7],
        ...BASE_BENCH,
      ]),
      liveElementsByElement: new Map([
        [101, stats(0, { minutes: 90 })],
        [111, stats(0, { minutes: 90 })],
        [112, stats(0, { minutes: 90 })],
        [113, stats(0, { minutes: 90 })],
        [131, stats(0, { minutes: 0 })],
        [121, stats(4, { minutes: 75 })],
        [122, stats(0, { minutes: 90 })],
        [141, stats(0, { minutes: 90 })],
        [103, stats(6, { minutes: 90 })],
      ]),
      fixtures: [
        fixture(1, 8, 12, "FINISHED", 90),
        fixture(2, 9, 10, "FINISHED", 90),
        fixture(3, 11, 7, "FINISHED", 90),
      ],
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    const byId = new Map(result.playerPoints.map((player) => [player.elementId, player]));
    expect(byId.get(131)?.multiplier).toBe(0);
    expect(byId.get(103)?.multiplier).toBe(1);
    expect(byId.get(121)?.multiplier).toBe(2);
    expect(result.grossPoints).toBe(14);
  });

  it("checks each fallback autosub against the formation produced by earlier autosubs", () => {
    const starters = [
      pick(1, 1, 1, 1),
      pick(2, 2, 2, 1), pick(3, 3, 2, 1), pick(4, 4, 2, 1), pick(5, 5, 2, 1),
      pick(6, 6, 3, 1), pick(7, 7, 3, 1), pick(8, 8, 3, 1), pick(9, 9, 3, 1),
      pick(10, 10, 4, 1), pick(11, 11, 4, 1),
    ];
    const multipliers = applyFallbackAutosubs(
      picksOf([...starters, pick(12, 12, 1), pick(13, 13, 3), pick(14, 14, 4), pick(15, 15, 2)]),
      new Map([
        [2, { total_points: 0, minutes: 0 }],
        [3, { total_points: 0, minutes: 0 }],
        [13, { total_points: 5, minutes: 90 }],
        [14, { total_points: 6, minutes: 90 }],
      ]),
      new Map([
        [2, { status: "DONE", started: true, remaining: 0, finished: 1, live: 0 }],
        [3, { status: "DONE", started: true, remaining: 0, finished: 1, live: 0 }],
      ]),
    );
    expect(multipliers.get(2)).toBe(0);
    expect(multipliers.get(13)).toBe(1);
    expect(multipliers.get(3)).toBe(1);
    expect(multipliers.get(14)).toBe(0);
  });

  it("counts only the players FPL is scoring, never the bench", () => {
    // Team 9 has not kicked off, so bench midfielder 103 (team 11, upcoming)
    // and starter 121 (team 9) would both read as TO PLAY without the guard.
    const fixtures: FixtureView[] = [
      fixture(1, 10, 8, "FINISHED", 90),
      fixture(2, 9, 12, "UPCOMING"),
      fixture(3, 11, 7, "UPCOMING"),
    ];
    const result = calculateLiveEntry({
      picks: picksOf([...BASE_XI, ...BASE_BENCH]),
      liveElementsByElement: new Map([[101, stats(6, { minutes: 90 })]]),
      fixtures,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    const bench = result.playerPoints.filter((player) => player.onBench);
    expect(bench.every((player) => player.multiplier === 0)).toBe(true);
    // Five of team 10 plus forward 131 of team 8 are done; 121 and 122 of team 9
    // and forward 141 of team 12 are still to play. The two benched players count
    // for nothing either way.
    expect(result.done + result.live + result.toPlay).toBe(8);
    expect(result.toPlay).toBe(3);
  });

  it("counts a substitute who replaced an idle starter, and drops the starter", () => {
    const fixtures: FixtureView[] = [
      fixture(1, 10, 9, "FINISHED", 90),
      fixture(2, 8, 12, "FINISHED", 90),
      fixture(3, 11, 7, "UPCOMING"),
    ];
    const result = calculateLiveEntry({
      picks: picksOf([...BASE_XI, ...BASE_BENCH], {
        automaticSubs: [{ elementIn: 103, elementOut: 121 }],
      }),
      liveElementsByElement: new Map([
        [121, stats(0, { minutes: 0 })],
        [103, stats(0, { minutes: 0 })],
      ]),
      fixtures,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    const substitute = result.playerPoints.find((player) => player.elementId === 103);
    const replaced = result.playerPoints.find((player) => player.elementId === 121);
    expect(substitute?.multiplier).toBe(1);
    expect(replaced?.multiplier).toBe(0);
    // The substitute's team has not kicked off, so exactly one player is to play.
    expect(result.toPlay).toBe(1);
  });

  it("treats a starter without a fixture as done rather than waiting on them", () => {
    const result = calculateLiveEntry({
      picks: picksOf([...BASE_XI, ...BASE_BENCH]),
      liveElementsByElement: new Map(),
      fixtures: [fixture(1, 10, 9, "FINISHED", 90)],
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    // Forwards 131 (team 8) and 141 (team 12) have no fixture this Gameweek.
    expect(result.toPlay).toBe(0);
    expect(result.done).toBe(8);
  });

  it("classifies a double-gameweek player with one finished and one upcoming fixture as still live", () => {
    const dgwFixtures: FixtureView[] = [
      fixture(1, 10, 9, "FINISHED", 90),
      fixture(2, 10, 8, "UPCOMING"),
    ];
    const result = calculateLiveEntry({
      picks: picksOf([...BASE_XI, ...BASE_BENCH]),
      liveElementsByElement: new Map([
        [111, stats(4, { minutes: 90 })],
        [131, stats(0, { minutes: 0 })],
      ]),
      fixtures: dgwFixtures,
      teamIdByElement: TEAM_BY_ELEMENT,
    });
    const defender = result.playerPoints.find((player) => player.elementId === 111);
    const forward = result.playerPoints.find((player) => player.elementId === 131);
    expect(defender?.status).toBe("LIVE");
    expect(defender?.points).toBe(4);
    expect(defender?.fixtures).toHaveLength(2);
    expect(forward?.status).toBe("TO_PLAY");
    expect(result.done).toBeGreaterThan(0);
    expect(result.toPlay).toBeGreaterThan(0);
  });
});
