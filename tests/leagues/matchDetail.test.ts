import { describe, expect, it } from "vitest";
import { allocateBonus, buildMatchDetail } from "@/lib/leagues/matchDetail";
import type { FixtureStatLine, FixtureView, LiveEntryPlayer } from "@/types/leagues";

function statLine(
  identifier: string,
  home: Array<[number, number]>,
  away: Array<[number, number]> = [],
): FixtureStatLine {
  return {
    identifier,
    home: home.map(([element, value]) => ({ element, value })),
    away: away.map(([element, value]) => ({ element, value })),
  };
}

function fixture(overrides: Partial<FixtureView> = {}): FixtureView {
  return {
    id: 10,
    kickoffTime: null,
    homeTeamId: 1,
    awayTeamId: 2,
    homeShortName: "HOM",
    awayShortName: "AWY",
    homeScore: 2,
    awayScore: 1,
    state: "LIVE",
    bonusSettled: false,
    minutes: 74,
    ...overrides,
  };
}

function owned(
  elementId: number,
  points: number,
  multiplier: number,
  overrides: Partial<LiveEntryPlayer> = {},
): LiveEntryPlayer {
  return {
    elementId,
    position: multiplier > 0 ? 1 : 12,
    elementType: 3,
    positionCode: "MID",
    onBench: multiplier === 0,
    multiplier,
    isCaptain: multiplier > 1,
    isViceCaptain: false,
    points,
    expectedPoints: 0,
    status: "LIVE",
    fixtures: [],
    ...overrides,
  };
}

const NAMES = new Map<number, string>([
  [11, "Haaland"],
  [12, "Foden"],
  [13, "Ederson"],
  [21, "Saka"],
  [22, "Rice"],
]);

const TEAMS = new Map<number, number>([[11, 1], [12, 1], [13, 1], [21, 2], [22, 2], [99, 3]]);

function detailOf(
  stats: FixtureStatLine[],
  options: { fixtureOverrides?: Partial<FixtureView>; ownedPlayers?: LiveEntryPlayer[] } = {},
) {
  return buildMatchDetail(fixture({ stats, ...options.fixtureOverrides }), {
    ownedPlayers: options.ownedPlayers ?? [],
    teamIdByElement: TEAMS,
    nameByElement: NAMES,
  });
}

describe("allocateBonus", () => {
  it("awards three, two and one down a clean ranking", () => {
    const awards = allocateBonus([
      { elementId: 11, bps: 41 },
      { elementId: 12, bps: 37 },
      { elementId: 13, bps: 30 },
      { elementId: 21, bps: 12 },
    ]);
    expect(awards.get(11)).toBe(3);
    expect(awards.get(12)).toBe(2);
    expect(awards.get(13)).toBe(1);
    expect(awards.get(21)).toBe(0);
  });

  it("gives two tied leaders three each and the next player one", () => {
    const awards = allocateBonus([
      { elementId: 11, bps: 41 },
      { elementId: 12, bps: 41 },
      { elementId: 13, bps: 30 },
      { elementId: 21, bps: 12 },
    ]);
    expect(awards.get(11)).toBe(3);
    expect(awards.get(12)).toBe(3);
    expect(awards.get(13)).toBe(1);
    expect(awards.get(21)).toBe(0);
  });

  it("gives three tied leaders three each and nobody else a bonus", () => {
    const awards = allocateBonus([
      { elementId: 11, bps: 41 },
      { elementId: 12, bps: 41 },
      { elementId: 13, bps: 41 },
      { elementId: 21, bps: 30 },
    ]);
    expect(awards.get(11)).toBe(3);
    expect(awards.get(12)).toBe(3);
    expect(awards.get(13)).toBe(3);
    expect(awards.get(21)).toBe(0);
  });

  it("gives two tied runners-up two each and awards no single point", () => {
    const awards = allocateBonus([
      { elementId: 11, bps: 41 },
      { elementId: 12, bps: 37 },
      { elementId: 13, bps: 37 },
      { elementId: 21, bps: 30 },
    ]);
    expect(awards.get(11)).toBe(3);
    expect(awards.get(12)).toBe(2);
    expect(awards.get(13)).toBe(2);
    expect(awards.get(21)).toBe(0);
  });

  it("hands no bonus to a player who scored nothing on the BPS scale", () => {
    const awards = allocateBonus([
      { elementId: 11, bps: 12 },
      { elementId: 12, bps: 0 },
      { elementId: 13, bps: -2 },
    ]);
    expect(awards.get(11)).toBe(3);
    expect(awards.get(12)).toBe(0);
    expect(awards.get(13)).toBe(0);
  });
});

describe("buildMatchDetail", () => {
  it("names scorers and assisters on the side that made them", () => {
    const detail = detailOf([
      statLine("goals_scored", [[11, 2]], [[21, 1]]),
      statLine("assists", [[12, 1]]),
    ]);
    expect(detail.scorers).toEqual([
      { elementId: 11, name: "Haaland", side: "HOME", count: 2, owned: false },
      { elementId: 21, name: "Saka", side: "AWAY", count: 1, owned: false },
    ]);
    expect(detail.assists).toEqual([
      { elementId: 12, name: "Foden", side: "HOME", count: 1, owned: false },
    ]);
  });

  it("marks the players in your own squad", () => {
    const detail = detailOf(
      [statLine("goals_scored", [[11, 1]], [[21, 1]])],
      { ownedPlayers: [owned(11, 8, 2)] },
    );
    expect(detail.scorers.map((row) => row.owned)).toEqual([true, false]);
  });

  it("ranks BPS across both sides and derives provisional bonus", () => {
    const detail = detailOf([statLine("bps", [[11, 41], [12, 30]], [[21, 37]])]);
    expect(detail.bonus.map((row) => [row.elementId, row.bps, row.bonus])).toEqual([
      [11, 41, 3],
      [21, 37, 2],
      [12, 30, 1],
    ]);
    expect(detail.bonusConfirmed).toBe(false);
  });

  it("prefers the bonus FPL has confirmed over a provisional reading", () => {
    const detail = detailOf(
      [
        statLine("bps", [[11, 41], [12, 30]], [[21, 37]]),
        statLine("bonus", [[11, 3], [12, 1]], [[21, 2]]),
      ],
      { fixtureOverrides: { state: "FINISHED", bonusSettled: true } },
    );
    expect(detail.bonusConfirmed).toBe(true);
    expect(detail.bonus.map((row) => [row.elementId, row.bonus])).toEqual([[11, 3], [21, 2], [12, 1]]);
  });

  it("keeps reading the BPS table while a finished match awaits its bonus", () => {
    const detail = detailOf(
      [
        statLine("bps", [[11, 41], [12, 30]], [[21, 37]]),
        statLine("bonus", [], []),
      ],
      { fixtureOverrides: { state: "FINISHED", bonusSettled: true } },
    );
    expect(detail.bonusConfirmed).toBe(false);
    expect(detail.bonus.map((row) => [row.elementId, row.bonus])).toEqual([[11, 3], [21, 2], [12, 1]]);
  });

  it("totals only what your players banked towards your score", () => {
    const detail = detailOf([], {
      ownedPlayers: [owned(11, 8, 2), owned(12, 3, 1), owned(13, 6, 0), owned(21, 5, 1)],
    });
    expect(detail.owned.map((player) => player.elementId)).toEqual([11, 12, 13, 21]);
    expect(detail.ownedPoints).toBe(24);
  });

  it("leaves out squad players whose club is not in this match", () => {
    const detail = detailOf([], { ownedPlayers: [owned(11, 8, 1), owned(99, 20, 1)] });
    expect(detail.owned.map((player) => player.elementId)).toEqual([11]);
    expect(detail.ownedPoints).toBe(8);
  });

  it("reports nothing for a match that has not kicked off", () => {
    const detail = detailOf([], { fixtureOverrides: { state: "UPCOMING", stats: undefined } });
    expect(detail.scorers).toEqual([]);
    expect(detail.assists).toEqual([]);
    expect(detail.bonus).toEqual([]);
  });
});
