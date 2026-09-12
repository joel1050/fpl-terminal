import { describe, expect, it } from "vitest";
import { normalizeBootstrap } from "@/components/terminal/TerminalApp";
import { BREAKDOWN_COMPONENT_KEYS, gameweekBreakdown } from "@/lib/projections/breakdown";

const PACKED = [1.9, 0.44, 0.21, 1.12, -0.51, 0, 0.38, 0.3, -0.09];

const CURRENT = {
  totalPoints: 30, goals: 1, assists: 2, cleanSheets: 3, bonus: 4, minutes: 900,
  expectedGoals: 1.8, expectedAssists: 0.9, expectedGoalsConceded: 9.9,
  goalsConceded: 11, saves: 0, defensiveContribution: 84, yellowCards: 3,
};

function bootstrapWith(packedComponents: unknown) {
  return normalizeBootstrap({
    data: {
      players: [{
        id: 1,
        firstName: "Test",
        lastName: "Player",
        displayName: "Test Player",
        teamId: 1,
        teamName: "Test",
        teamShortName: "TST",
        position: "DEF",
        priceTenths: 50,
        current: CURRENT,
        projection: {
          nextGW: 3.75,
          next3: 9,
          next5: 15,
          next10: 30,
          fixtures: [{
            gameweek: 2,
            expectedPoints: 3.75,
            expectedMinutes: 80,
            fixture: { gameweek: 2, opponentTeamId: 2, opponentShortName: "OPP", isHome: true },
            packedComponents,
          }],
        },
      }],
    },
  }).players[0];
}

describe("points breakdown on the bootstrap payload", () => {
  it("carries the packed breakdown through to the browser", () => {
    const player = bootstrapWith(PACKED);
    expect(player.projection.fixtures[0].packedComponents).toEqual(PACKED);
  });

  it("explains the gameweek the profile displays", () => {
    const breakdown = gameweekBreakdown(bootstrapWith(PACKED), 2)!;
    expect(breakdown.rows.find((row) => row.key === "cleanSheets")!.points).toBe(1.12);
    expect(breakdown.rows.find((row) => row.key === "goalsConceded")!.deduction).toBe(true);
    expect(breakdown.total).toBeCloseTo(3.75, 2);
  });

  it("leaves the breakdown out when the payload omits or malforms it", () => {
    expect(bootstrapWith(undefined).projection.fixtures[0].packedComponents).toBeUndefined();
    expect(bootstrapWith("nonsense").projection.fixtures[0].packedComponents).toBeUndefined();
    expect(bootstrapWith([1, 2]).projection.fixtures[0].packedComponents).toBeUndefined();
    expect(gameweekBreakdown(bootstrapWith(undefined), 2)).toBeNull();
  });

  it("reads a short payload as a mistake rather than padding it with zeroes", () => {
    const short = PACKED.slice(0, BREAKDOWN_COMPONENT_KEYS.length - 1);
    expect(bootstrapWith(short).projection.fixtures[0].packedComponents).toBeUndefined();
  });
});

describe("stats the breakdown quotes as evidence", () => {
  it("carries the defensive and disciplinary totals the rows need", () => {
    const { current } = bootstrapWith(PACKED);
    expect(current.expectedGoalsConceded).toBe(9.9);
    expect(current.goalsConceded).toBe(11);
    expect(current.defensiveContribution).toBe(84);
    expect(current.yellowCards).toBe(3);
  });

  it("gives a defender every row a figure to stand on", () => {
    const rows = gameweekBreakdown(bootstrapWith(PACKED), 2)!.rows;
    for (const row of rows) {
      expect(row.evidence.length, `${row.key} has no evidence`).toBeGreaterThan(0);
    }
    expect(rows.find((row) => row.key === "cards")!.evidence[0]).toEqual({ label: "This season", value: "0.30" });
  });
});
