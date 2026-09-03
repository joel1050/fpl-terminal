import { describe, expect, it } from "vitest";
import type { Player, Position } from "@/types/player";
import { pickWeeklyTeam, scoreLineupWithChip } from "@/lib/squad/weeklyLineup";

function player(id: number, position: Position, points: number, status = "a", gameweeks = [1]): Player {
  const fixtures = gameweeks.map((gameweek) => ({
    gameweek,
    expectedPoints: points,
    expectedMinutes: 90,
    fixture: { gameweek, opponentTeamId: 99, opponentShortName: "T", isHome: true },
  }));
  const total = points * gameweeks.length;
  return {
    id,
    firstName: "P",
    lastName: String(id),
    displayName: `P${id}`,
    teamId: id,
    teamName: `T${id}`,
    teamShortName: `T${id}`,
    position,
    priceTenths: 50,
    ownership: 0,
    status,
    current: { totalPoints: total, pointsPer90: points, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 90 },
    fixtures: [],
    projection: {
      playerId: id,
      fixtures,
      nextGW: points,
      next3: points * 3,
      next5: points * 5,
      next10: points * 10,
      expectedMinutes: 90,
      valueNext5: points,
      riskScore: 5,
      confidence: "HIGH",
      factors: [],
    },
  };
}

function squad(statuses: Record<number, string> = {}): Player[] {
  return [
    player(1, "GK", 5, statuses[1] ?? "a"), player(2, "GK", 4, statuses[2] ?? "a"),
    player(3, "DEF", 5, statuses[3] ?? "a"), player(4, "DEF", 5, statuses[4] ?? "a"),
    player(5, "DEF", 5, statuses[5] ?? "a"), player(6, "DEF", 5, statuses[6] ?? "a"),
    player(7, "DEF", 5, statuses[7] ?? "a"),
    player(8, "MID", 5, statuses[8] ?? "a"), player(9, "MID", 5, statuses[9] ?? "a"),
    player(10, "MID", 5, statuses[10] ?? "a"), player(11, "MID", 5, statuses[11] ?? "a"),
    player(12, "MID", 5, statuses[12] ?? "a"),
    player(13, "FWD", 5, statuses[13] ?? "a"), player(14, "FWD", 5, statuses[14] ?? "a"),
    player(15, "FWD", 5, statuses[15] ?? "a"),
  ];
}

describe("chip-aware weekly scoring", () => {
  it("scores a normal week as XI plus captain bonus plus autosubs", () => {
    const plan = pickWeeklyTeam({ squad: squad(), gameweek: 1, riskMode: "BALANCED", chip: null });
    expect(plan.projectedXI).toBe(55);
    expect(plan.captainBonus).toBe(5);
    expect(plan.autosubValue).toBe(0);
    expect(plan.projectedTotal).toBe(60);
  });

  it("doubles the captain bonus under Triple Captain", () => {
    const plan = pickWeeklyTeam({ squad: squad(), gameweek: 1, riskMode: "BALANCED", chip: "3xc" });
    expect(plan.projectedXI).toBe(55);
    expect(plan.captainBonus).toBe(10);
    expect(plan.projectedTotal).toBe(65);
  });

  it("scores all fifteen under Bench Boost with zero autosub value", () => {
    const plan = pickWeeklyTeam({ squad: squad(), gameweek: 1, riskMode: "BALANCED", chip: "bboost" });
    expect(plan.projectedXI).toBe(74); // 5 + 4 + 5*5 + 5*5 + 5*3
    expect(plan.captainBonus).toBe(5);
    expect(plan.autosubValue).toBe(0);
    expect(plan.projectedTotal).toBe(79);
    expect(plan.starterIds).toHaveLength(11);
  });

  it("promotes the vice-captain when the captain is unavailable", () => {
    // Player 8 carries 10 points but is injured; the armband expectation
    // falls to the 9.8-point vice-captain.
    const withPoints = (item: Player, points: number, status = item.status): Player => ({
      ...item,
      status,
      projection: {
        ...item.projection!,
        fixtures: item.projection!.fixtures.map((fixture) => ({ ...fixture, expectedPoints: points })),
        nextGW: points,
      },
    });
    const players = squad().map((item) => {
      if (item.id === 8) return withPoints(item, 10, "i");
      if (item.id === 10) return withPoints(item, 9.8);
      return item;
    });
    const normal = pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "AGGRESSIVE", chip: null });
    expect(normal.captainBonus).toBeCloseTo(9.8, 3);
    const triple = pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "AGGRESSIVE", chip: "3xc" });
    expect(triple.captainBonus).toBeCloseTo(19.6, 3);
  });

  it("returns blanks as zero for every chip", () => {
    for (const chip of [null, "bboost", "3xc"] as const) {
      const plan = pickWeeklyTeam({ squad: squad(), gameweek: 2, riskMode: "AGGRESSIVE", chip });
      expect(plan.projectedXI).toBe(0);
      expect(plan.projectedTotal).toBe(0);
    }
  });

  it("sums both fixtures of a double gameweek, including the bench", () => {
    const players = squad().map((item) => ({
      ...item,
      projection: {
        ...item.projection!,
        fixtures: [
          { gameweek: 1, expectedPoints: 4, expectedMinutes: 90, fixture: { gameweek: 1, opponentTeamId: 1, opponentShortName: "A", isHome: true } },
          { gameweek: 1, expectedPoints: 5, expectedMinutes: 90, fixture: { gameweek: 1, opponentTeamId: 2, opponentShortName: "B", isHome: false } },
        ],
      },
    }));
    expect(pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "AGGRESSIVE", chip: null }).projectedXI).toBe(99);
    expect(pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "AGGRESSIVE", chip: "bboost" }).projectedXI).toBe(135);
  });

  it("scores a saved lineup with chip effects and keeps fingerprints chip-sensitive", () => {
    const players = squad();
    const optimal = pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "BALANCED", chip: null });
    const saved = {
      starterIds: optimal.starterIds,
      benchGoalkeeperId: optimal.benchGoalkeeperId,
      benchOrder: [...optimal.benchOrder],
      captainId: optimal.captainId,
      viceCaptainId: optimal.viceCaptainId,
    };
    const triple = scoreLineupWithChip(players, 1, "BALANCED", "3xc", saved);
    expect(triple.projectedTotal).toBe(optimal.projectedXI + 2 * optimal.captainBonus + optimal.autosubValue);
    const bench = scoreLineupWithChip(players, 1, "BALANCED", "bboost", saved);
    expect(bench.autosubValue).toBe(0);
    expect(bench.projectedXI).toBe(74);
    expect(optimal.projectionFingerprint).not.toBe(
      pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "BALANCED", chip: "bboost" }).projectionFingerprint,
    );
  });
});
