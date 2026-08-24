import { describe, expect, it } from "vitest";
import { aggregatePlayerStatus, fixtureStateOf, teamFixturesByTeam } from "@/lib/leagues/fixtureStatus";
import type { FixtureView } from "@/types/leagues";

function view(overrides: Partial<FixtureView>): FixtureView {
  return {
    id: 1,
    kickoffTime: null,
    homeTeamId: 10,
    awayTeamId: 20,
    homeShortName: "AAA",
    awayShortName: "BBB",
    homeScore: 0,
    awayScore: 0,
    state: "UPCOMING",
    minutes: undefined,
    ...overrides,
  };
}

describe("fixtureStateOf", () => {
  it("classifies upcoming, live and finished matches", () => {
    expect(fixtureStateOf({ finished: false, started: false })).toBe("UPCOMING");
    expect(fixtureStateOf({ finished: false, started: true, minutes: 34 })).toBe("LIVE");
    expect(fixtureStateOf({ finished: true, started: true, minutes: 90 })).toBe("FINISHED");
  });
});

describe("teamFixturesByTeam", () => {
  it("indexes both directions of every fixture", () => {
    const fixtures = [
      view({ id: 5, homeTeamId: 10, awayTeamId: 20 }),
      view({ id: 6, homeTeamId: 30, awayTeamId: 10 }),
    ];
    const byTeam = teamFixturesByTeam(fixtures);
    const homeSide = byTeam.get(10)!;
    const awaySide = byTeam.get(20)!;
    expect(homeSide).toHaveLength(2);
    expect(homeSide[0]).toMatchObject({ fixtureId: 5, opponentTeamId: 20, isHome: true });
    expect(homeSide[1]).toMatchObject({ fixtureId: 6, opponentTeamId: 30, isHome: false });
    expect(awaySide).toHaveLength(1);
    expect(awaySide[0]).toMatchObject({ fixtureId: 5, opponentTeamId: 10, isHome: false });
  });

  it("supports double gameweeks by returning multiple entries for one club", () => {
    const fixtures = [
      view({ id: 7, homeTeamId: 10, awayTeamId: 20, state: "FINISHED" }),
      view({ id: 8, homeTeamId: 40, awayTeamId: 10, state: "UPCOMING" }),
    ];
    const entries = teamFixturesByTeam(fixtures).get(10)!;
    expect(entries.map((entry) => entry.state)).toEqual(["FINISHED", "UPCOMING"]);
  });
});

describe("aggregatePlayerStatus", () => {
  const statuses = (states: Array<"UPCOMING" | "LIVE" | "FINISHED">) =>
    states.map((state, index) => ({
      fixtureId: index + 1,
      opponentTeamId: 20,
      isHome: true,
      state,
      kickoffTime: null,
    }));

  it("is TO_PLAY before any fixture starts", () => {
    expect(aggregatePlayerStatus(statuses(["UPCOMING"]))).toMatchObject({
      status: "TO_PLAY",
      started: false,
      remaining: 1,
    });
    expect(aggregatePlayerStatus([])).toMatchObject({ status: "TO_PLAY" });
  });

  it("is LIVE while any fixture is in play", () => {
    expect(aggregatePlayerStatus(statuses(["LIVE"]))).toMatchObject({ status: "LIVE", started: true });
  });

  it("is DONE once every fixture has finished", () => {
    expect(aggregatePlayerStatus(statuses(["FINISHED"]))).toMatchObject({ status: "DONE", remaining: 0 });
  });

  it("keeps a mixed double header live with a remaining fixture count", () => {
    expect(aggregatePlayerStatus(statuses(["FINISHED", "UPCOMING"]))).toMatchObject({
      status: "LIVE",
      started: true,
      remaining: 1,
      finished: 1,
    });
  });

  it("counts one DONE fixture plus one TO PLAY fixture without collapsing them", () => {
    const result = aggregatePlayerStatus(statuses(["FINISHED", "UPCOMING"]));
    expect(result.finished).toBe(1);
    expect(result.remaining).toBe(1);
  });
});

describe("provisionally finished fixtures", () => {
  it("counts a fixture whose bonus is still provisional as finished", () => {
    // FPL keeps `finished: false` until it confirms bonus, but the match is over.
    expect(fixtureStateOf({ started: true, finishedProvisional: true, minutes: 90 })).toBe("FINISHED");
    expect(fixtureStateOf({ started: true, finished: false, minutes: 74 })).toBe("LIVE");
  });
});
