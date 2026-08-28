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
    const forGameweekOne = await exactOptimizeFullSquad({ players: rivalPool, gameweek: 1, horizon: 1, risk: "BALANCED", bench: "BALANCED" });
    const forGameweekTwo = await exactOptimizeFullSquad({ players: rivalPool, gameweek: 2, horizon: 1, risk: "BALANCED", bench: "BALANCED" });

    expect(forGameweekOne.legal).toBe(true);
    expect(forGameweekTwo.legal).toBe(true);
    expect(forGameweekOne.playerIds).toContain(20);
    expect(forGameweekOne.playerIds).not.toContain(21);
    expect(forGameweekTwo.playerIds).toContain(21);
    expect(forGameweekTwo.playerIds).not.toContain(20);
    expect(forGameweekOne.captainsByGameweek).toEqual([{ gameweek: 1, playerId: 20 }]);
    expect(forGameweekTwo.captainsByGameweek).toEqual([{ gameweek: 2, playerId: 21 }]);
  });

  it("scores a blank gameweek as zero rather than reusing another gameweek", async () => {
    // id 20 plays only in Gameweek 1, so Gameweek 2 is a blank for them.
    const blankPool = rivalPool.map((candidate) => candidate.id === 20
      ? scheduledPlayer(20, "MID", 60, { 1: 12 })
      : candidate);
    const result = await exactOptimizeFullSquad({ players: blankPool, gameweek: 2, horizon: 1, risk: "BALANCED", bench: "BALANCED" });

    expect(result.legal).toBe(true);
    expect(result.playerIds).not.toContain(20);
    expect(result.captainsByGameweek).toEqual([{ gameweek: 2, playerId: 21 }]);
  });

  it("warns when the planned window runs past the projected fixtures", async () => {
    const result = await exactOptimizeFullSquad({ players: rivalPool, gameweek: 4, horizon: 5, risk: "BALANCED", bench: "BALANCED" });

    expect(result.legal).toBe(true);
    expect(result.warnings.some((warning) => /Projections cover Gameweeks 1-5/.test(warning))).toBe(true);
  });
});

describe("bench strategy", () => {
  // The same pool with a cheap and an expensive option for every outfield slot.
  const benchPool = [
    scheduledPlayer(1, "GK", 50, flat(5)), scheduledPlayer(2, "GK", 40, flat(1)),
    ...Array.from({ length: 5 }, (_, index) => scheduledPlayer(10 + index, "DEF", 60, flat(5))),
    ...Array.from({ length: 3 }, (_, index) => scheduledPlayer(15 + index, "DEF", 40, flat(1.2))),
    ...Array.from({ length: 5 }, (_, index) => scheduledPlayer(20 + index, "MID", 70, flat(6))),
    ...Array.from({ length: 3 }, (_, index) => scheduledPlayer(25 + index, "MID", 45, flat(1.5))),
    ...Array.from({ length: 3 }, (_, index) => scheduledPlayer(30 + index, "FWD", 75, flat(6))),
    ...Array.from({ length: 3 }, (_, index) => scheduledPlayer(33 + index, "FWD", 45, flat(1.5))),
  ];
  const cost = (ids: readonly number[]) => ids.reduce((sum, id) => sum + (benchPool.find((candidate) => candidate.id === id)?.priceTenths ?? 0), 0);
  const solve = (bench: "CHEAP" | "BALANCED" | "STRONG", horizon: 1 | 3 | 5 | 10) =>
    exactOptimizeFullSquad({ players: benchPool, gameweek: 1, horizon, risk: "BALANCED", bench });

  it("buys a cheaper squad under CHEAP than under BALANCED or STRONG", async () => {
    const [cheap, balanced, strong] = await Promise.all([solve("CHEAP", 1), solve("BALANCED", 1), solve("STRONG", 1)]);

    expect([cheap.legal, balanced.legal, strong.legal]).toEqual([true, true, true]);
    expect(cost(cheap.playerIds)).toBeLessThan(cost(balanced.playerIds));
    expect(cost(balanced.playerIds)).toBeLessThanOrEqual(cost(strong.playerIds));
  });

  it("keeps CHEAP effective on a ten-gameweek horizon", async () => {
    const [cheap, balanced] = await Promise.all([solve("CHEAP", 10), solve("BALANCED", 10)]);

    expect(cost(cheap.playerIds)).toBeLessThan(cost(balanced.playerIds));
  });
});
