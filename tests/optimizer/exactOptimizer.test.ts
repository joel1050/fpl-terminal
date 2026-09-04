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
  player(1, "GK", 50, 5), player(2, "GK", 45, 2), player(3, "GK", 40, 2),
  ...Array.from({ length: 5 }, (_, index) => player(10 + index, "DEF", 45, 4 + index / 10)),
  ...Array.from({ length: 5 }, (_, index) => player(20 + index, "MID", 60, 5 + index / 10)),
  ...Array.from({ length: 3 }, (_, index) => player(30 + index, "FWD", 70, 5 + index / 10)),
];

describe("exact optimizer", () => {
  it("returns an optimal legal squad", async () => {
    const result = await exactOptimizeFullSquad({ players, horizon: 5 });
    expect(result.legal).toBe(true);
    expect(result.optimal).toBe(true);
    expect(result.playerIds).toHaveLength(15);
    expect(result.captainsByGameweek).toHaveLength(5);
  });

  it("accepts two expensive locked goalkeepers", async () => {
    const result = await exactOptimizeFullSquad({ players, lockedPlayerIds: [1, 2], horizon: 5 });
    expect(result.legal).toBe(true);
    expect(result.playerIds).toEqual(expect.arrayContaining([1, 2]));
  });
});

/** A player whose projected points differ from gameweek to gameweek. */
function scheduledPlayer(id: number, position: Position, priceTenths: number, pointsByGameweek: Record<number, number>): Player {
  const fixtures = Object.entries(pointsByGameweek).map(([gameweek, points]) => ({
    gameweek: Number(gameweek),
    opponentTeamId: 1000 + id,
    opponentShortName: "OPP",
    isHome: true,
    expectedPoints: points,
    expectedMinutes: 90,
    fixture: { gameweek: Number(gameweek), opponentTeamId: 1000 + id, opponentShortName: "OPP", isHome: true },
  }));
  const total = fixtures.reduce((sum, fixture) => sum + fixture.expectedPoints, 0);
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
    current: { totalPoints: total, pointsPer90: total, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 90 },
    fixtures: fixtures.map((item) => item.fixture),
    projection: {
      playerId: id,
      fixtures,
      nextGW: pointsByGameweek[1] ?? 0,
      next3: total,
      next5: total,
      next10: total,
      expectedMinutes: 90,
      valueNext5: total / (priceTenths / 10),
      riskScore: 0,
      confidence: "HIGH",
      factors: [],
    },
  };
}

function withDnp(candidate: Player, probability: number): Player {
  return {
    ...candidate,
    selection: {
      startProbability: 1 - probability,
      cameoProbability: 0,
      noAppearanceProbability: probability,
      expectedMinutes: 90 * (1 - probability),
      nailedRating: 5,
      confidence: "HIGH",
      updatedAt: "2026-09-03T00:00:00.000Z",
      evidence: [],
    },
  };
}

const flat = (points: number) => ({ 1: points, 2: points, 3: points, 4: points, 5: points });

// Two rival midfielders: id 20 owns Gameweek 1, id 21 owns Gameweek 2.
const gameweekOneSpecialist = scheduledPlayer(20, "MID", 60, { 1: 12, 2: 0.5, 3: 1, 4: 1, 5: 1 });
const gameweekTwoSpecialist = scheduledPlayer(21, "MID", 60, { 1: 0.5, 2: 12, 3: 1, 4: 1, 5: 1 });
const rivalPool = [
  scheduledPlayer(1, "GK", 50, flat(5)), scheduledPlayer(2, "GK", 40, flat(2)),
  ...Array.from({ length: 5 }, (_, index) => scheduledPlayer(10 + index, "DEF", 45, flat(4))),
  gameweekOneSpecialist,
  gameweekTwoSpecialist,
  ...Array.from({ length: 4 }, (_, index) => scheduledPlayer(22 + index, "MID", 55, flat(3))),
  ...Array.from({ length: 3 }, (_, index) => scheduledPlayer(30 + index, "FWD", 70, flat(5))),
];

describe("planning gameweek", () => {
  it("optimizes the gameweek being planned, not the live one", async () => {
    const forGameweekOne = await exactOptimizeFullSquad({ players: rivalPool, gameweek: 1, horizon: 1 });
    const forGameweekTwo = await exactOptimizeFullSquad({ players: rivalPool, gameweek: 2, horizon: 1 });

    expect(forGameweekOne.legal).toBe(true);
    expect(forGameweekTwo.legal).toBe(true);
    expect(forGameweekOne.playerIds).toContain(20);
    expect(forGameweekTwo.playerIds).toContain(21);
    expect(forGameweekOne.captainsByGameweek).toEqual([{ gameweek: 1, playerId: 20 }]);
    expect(forGameweekTwo.captainsByGameweek).toEqual([{ gameweek: 2, playerId: 21 }]);
  });

  it("scores a blank gameweek as zero rather than reusing another gameweek", async () => {
    // id 20 plays only in Gameweek 1, so Gameweek 2 is a blank for them.
    const blankPool = rivalPool.map((candidate) => candidate.id === 20
      ? scheduledPlayer(20, "MID", 60, { 1: 12 })
      : candidate);
    const result = await exactOptimizeFullSquad({ players: blankPool, gameweek: 2, horizon: 1 });

    expect(result.legal).toBe(true);
    expect(result.captainsByGameweek).toEqual([{ gameweek: 2, playerId: 21 }]);
  });

  it("warns when the planned window runs past the projected fixtures", async () => {
    const result = await exactOptimizeFullSquad({ players: rivalPool, gameweek: 4, horizon: 5 });

    expect(result.legal).toBe(true);
    expect(result.warnings.some((warning) => /Projections cover Gameweeks 1-5/.test(warning))).toBe(true);
  });
});

describe("optimizer objective", () => {
  it("makes CHEAP value-aware instead of selecting the lowest price", async () => {
    const pool = [
      scheduledPlayer(1, "GK", 50, { 1: 10 }), scheduledPlayer(2, "GK", 50, { 1: 0 }),
      ...Array.from({ length: 5 }, (_, index) => scheduledPlayer(10 + index, "DEF", 50, { 1: index < 3 ? 10 : 0 })),
      ...Array.from({ length: 4 }, (_, index) => scheduledPlayer(20 + index, "MID", 50, { 1: 10 })),
      scheduledPlayer(24, "MID", 40, { 1: 0.2 }),
      scheduledPlayer(25, "MID", 45, { 1: 2 }),
      scheduledPlayer(26, "MID", 65, { 1: 2.8 }),
      ...Array.from({ length: 3 }, (_, index) => scheduledPlayer(30 + index, "FWD", 50, { 1: 10 })),
    ].map((candidate) => withDnp(candidate, 0.1));

    const [cheap, balanced, strong] = await Promise.all([
      exactOptimizeFullSquad({ players: pool, gameweek: 1, horizon: 1, bench: "CHEAP" }),
      exactOptimizeFullSquad({ players: pool, gameweek: 1, horizon: 1, bench: "BALANCED" }),
      exactOptimizeFullSquad({ players: pool, gameweek: 1, horizon: 1, bench: "STRONG" }),
    ]);

    expect([cheap.legal, balanced.legal, strong.legal]).toEqual([true, true, true]);
    expect(cheap.playerIds).toContain(25);
    expect(cheap.playerIds).not.toContain(24);
    expect(cheap.playerIds).not.toContain(26);
    expect(balanced.playerIds).toContain(26);
    expect(strong.objective).toBeGreaterThan(balanced.objective!);
  });

  it("selects players that can rotate through a different legal XI each gameweek", async () => {
    const pool = [
      scheduledPlayer(1, "GK", 50, { 1: 20, 2: 20, 3: 20 }),
      scheduledPlayer(2, "GK", 50, { 1: 0, 2: 0, 3: 0 }),
      ...Array.from({ length: 5 }, (_, index) => scheduledPlayer(10 + index, "DEF", 50, index < 3 ? { 1: 20, 2: 20, 3: 20 } : { 1: 0, 2: 0, 3: 0 })),
      scheduledPlayer(20, "MID", 50, { 1: 20, 2: 20, 3: 20 }),
      scheduledPlayer(21, "MID", 50, { 1: 20, 2: 20, 3: 20 }),
      scheduledPlayer(22, "MID", 50, { 1: 20, 2: 20, 3: 20 }),
      scheduledPlayer(23, "MID", 50, { 1: 10, 2: 0, 3: 0 }),
      scheduledPlayer(24, "MID", 50, { 1: 0, 2: 10, 3: 0 }),
      scheduledPlayer(25, "MID", 50, { 1: 6, 2: 6, 3: 0 }),
      ...Array.from({ length: 3 }, (_, index) => scheduledPlayer(30 + index, "FWD", 50, { 1: 20, 2: 20, 3: 20 })),
    ];

    const result = await exactOptimizeFullSquad({ players: pool, gameweek: 1, horizon: 3 });

    expect(result.legal).toBe(true);
    expect(result.playerIds).toEqual(expect.arrayContaining([23, 24]));
    expect(result.playerIds).not.toContain(25);
    expect(result.objective).toBe(680);
  });
});
