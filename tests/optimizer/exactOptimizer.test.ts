import { describe, expect, it } from "vitest";

import { exactOptimizeFullSquad } from "../../lib/optimizer/exactOptimizer";
import type { Player, Position } from "../../types/player";

function player(id: number, position: Position, priceTenths: number, points: number): Player {
  const fixtures = Array.from({ length: 5 }, (_, index) => ({
    gameweek: index + 1,
    opponentTeamId: 1000 + id,
    opponentShortName: "OPP",
    isHome: true,
    expectedPoints: points,
    expectedMinutes: 90,
    fixture: { gameweek: index + 1, opponentTeamId: 1000 + id, opponentShortName: "OPP", isHome: true },
  }));
  return {
    id,
    firstName: `P${id}`,
    lastName: "Test",
    displayName: `P${id}`,
    teamId: 100 + id,
    teamName: `Team ${id}`,
    teamShortName: `T${id}`,
    position,
    priceTenths,
    ownership: 0,
    status: "a",
    current: { totalPoints: points, pointsPer90: points, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 90 },
    fixtures: fixtures.map((item) => item.fixture),
    projection: {
      playerId: id,
      fixtures,
      nextGW: points,
      next3: points * 3,
      next5: points * 5,
      expectedMinutes: 90,
      valueNext5: points * 5 / (priceTenths / 10),
      riskScore: 0,
      confidence: "HIGH",
      factors: [],
    },
  };
}

const players = [
  player(1, "GK", 50, 5), player(2, "GK", 45, 2), player(3, "GK", 40, 2),
  ...Array.from({ length: 5 }, (_, index) => player(10 + index, "DEF", 45, 4 + index / 10)),
  ...Array.from({ length: 5 }, (_, index) => player(20 + index, "MID", 60, 5 + index / 10)),
  ...Array.from({ length: 3 }, (_, index) => player(30 + index, "FWD", 70, 5 + index / 10)),
];

describe("exact optimizer", () => {
  it("returns an optimal legal squad with a cheap reserve goalkeeper", async () => {
    const result = await exactOptimizeFullSquad({ players, horizon: 5, risk: "BALANCED", bench: "BALANCED" });
    expect(result.legal).toBe(true);
    expect(result.optimal).toBe(true);
    expect(result.playerIds).toHaveLength(15);
    const benchGoalkeeperId = result.analysis?.bench.find((id) => players.find((candidate) => candidate.id === id)?.position === "GK");
    expect(players.find((candidate) => candidate.id === benchGoalkeeperId)?.priceTenths).toBe(40);
    expect(result.captainsByGameweek).toHaveLength(5);
  });

  it("accepts two expensive locked goalkeepers", async () => {
    const result = await exactOptimizeFullSquad({ players, lockedPlayerIds: [1, 2], horizon: 5, risk: "BALANCED", bench: "BALANCED" });
    expect(result.legal).toBe(true);
    expect(result.playerIds).toEqual(expect.arrayContaining([1, 2]));
  });
});
