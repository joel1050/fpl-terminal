import { describe, expect, it } from "vitest";

import { exactCompletePartialSquad, exactOptimizeFullSquad } from "../../lib/optimizer/exactOptimizer";
import { legalSquad, playerMap, costOf } from "../../lib/analysis/context";
import type { Player, Position } from "../../types/player";

function player(id: number, position: Position, priceTenths: number, points: number, teamId?: number): Player {
  const fixtures = [1, 2, 3].map((gameweek) => ({
    gameweek,
    opponentTeamId: 1000 + id,
    opponentShortName: "OPP",
    isHome: true,
    expectedPoints: points,
    expectedMinutes: 90,
    fixture: { gameweek, opponentTeamId: 1000 + id, opponentShortName: "OPP", isHome: true },
  }));
  return {
    id,
    firstName: `P${id}`,
    lastName: "Test",
    displayName: `P${id}`,
    teamId: teamId ?? 100 + id,
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
      next10: points * 10,
      expectedMinutes: 90,
      valueNext5: points * 5 / (priceTenths / 10),
      riskScore: 0,
      confidence: "HIGH",
      factors: [],
    },
  };
}

const players = [
  player(1, "GK", 50, 5), player(2, "GK", 45, 4), player(3, "GK", 40, 1),
  ...Array.from({ length: 6 }, (_, index) => player(10 + index, "DEF", 45, 4)),
  ...Array.from({ length: 6 }, (_, index) => player(20 + index, "MID", 60, 5)),
  ...Array.from({ length: 4 }, (_, index) => player(30 + index, "FWD", 70, 5)),
];

describe("chip-aware exact solves", () => {
  it("matches the legacy horizon solve when given the same explicit gameweeks", async () => {
    const legacy = await exactOptimizeFullSquad({
      players, squad: [], budgetTenths: 1000, gameweek: 1, horizon: 3,
    });
    const explicit = await exactOptimizeFullSquad({
      players, squad: [], budgetTenths: 1000, gameweek: 1, gameweeks: [1, 2, 3], horizon: 3,
    });
    expect(legacy.legal).toBe(true);
    expect(explicit.playerIds.sort((a, b) => a - b)).toEqual(legacy.playerIds.sort((a, b) => a - b));
    expect(explicit.objective).toBeCloseTo(legacy.objective ?? 0, 8);
  });

  it("solves a one-gameweek Free Hit squad within selling value plus bank", async () => {
    const result = await exactOptimizeFullSquad({
      players, squad: [], budgetTenths: 1000, gameweek: 2, gameweeks: [2], horizon: 1,
    });
    expect(result.legal).toBe(true);
    expect(result.playerIds).toHaveLength(15);
    expect(legalSquad(result.playerIds, playerMap(players), { budgetTenths: 1000 }).legal).toBe(true);
    expect(result.captainsByGameweek).toEqual([{ gameweek: 2, playerId: expect.any(Number) }]);
  });

  it("solves a wildcard over an explicit remaining horizon", async () => {
    const result = await exactCompletePartialSquad({
      players, squad: [], budgetTenths: 1000, gameweek: 1, gameweeks: [1, 2, 3], horizon: 3,
    });
    expect(result.legal).toBe(true);
    expect(result.captainsByGameweek).toHaveLength(3);
  });

  it("keeps locks and exclusions as constraints in generated squads", async () => {
    const result = await exactOptimizeFullSquad({
      players, squad: [], lockedPlayerIds: [1], excludedPlayerIds: [30], budgetTenths: 1000,
      gameweek: 1, gameweeks: [1], horizon: 1,
    });
    expect(result.legal).toBe(true);
    expect(result.playerIds).toContain(1);
    expect(result.playerIds).not.toContain(30);
  });

  it("enforces the budget on chip solves", async () => {
    const result = await exactOptimizeFullSquad({
      players, squad: [], budgetTenths: 100, gameweek: 1, gameweeks: [1], horizon: 1,
    });
    expect(result.legal).toBe(false);
  });

  it("weights the full squad for bench-boost solves", async () => {
    const expensiveBench = player(40, "MID", 130, 12);
    const pool = [...players, expensiveBench];
    const normal = await exactOptimizeFullSquad({
      players: pool, squad: [], budgetTenths: 1100, gameweek: 1, gameweeks: [1], horizon: 1,
    });
    const boosted = await exactOptimizeFullSquad({
      players: pool, squad: [], budgetTenths: 1100, gameweek: 1, gameweeks: [1], horizon: 1, benchBoost: true,
    });
    expect(normal.legal).toBe(true);
    expect(boosted.legal).toBe(true);
    const map = playerMap(pool);
    // Bench Boost values every point, so the boosted squad cannot be worth
    // less across all fifteen than the cheap-bench squad.
    const valueOf = (ids: number[]) => ids.reduce((sum, id) => sum + (map.get(id)?.projection?.nextGW ?? 0), 0);
    expect(valueOf(boosted.playerIds)).toBeGreaterThanOrEqual(valueOf(normal.playerIds));
    expect(costOf(boosted.playerIds, map)).toBeLessThanOrEqual(1100);
  });
});
