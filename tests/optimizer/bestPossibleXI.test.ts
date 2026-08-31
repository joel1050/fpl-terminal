import { describe, expect, it } from "vitest";

import { exactBestPossibleXI } from "../../lib/optimizer/bestPossibleXI";
import type { Player, Position } from "../../types/player";

/** A player whose projected points are fixed per gameweek, blank gameweeks included. */
function scheduledPlayer(id: number, position: Position, priceTenths: number, teamId: number, pointsByGameweek: Record<number, number>): Player {
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
    teamId,
    teamName: `Team ${teamId}`,
    teamShortName: `T${teamId}`,
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

const flat = (points: number) => ({ 1: points, 2: points });

// Clubs 1 and 5 each carry four premium options, so the three-per-club cap bites.
const market: Player[] = [
  scheduledPlayer(1, "GK", 50, 10, flat(5)),
  scheduledPlayer(2, "GK", 40, 11, flat(2)),
  scheduledPlayer(10, "DEF", 60, 1, flat(6)),
  scheduledPlayer(11, "DEF", 60, 1, flat(5.9)),
  scheduledPlayer(12, "DEF", 60, 1, flat(5.8)),
  scheduledPlayer(13, "DEF", 60, 1, flat(5.7)),
  scheduledPlayer(14, "DEF", 45, 2, flat(1)),
  scheduledPlayer(15, "DEF", 45, 3, flat(0.9)),
  scheduledPlayer(16, "DEF", 45, 4, flat(0.8)),
  scheduledPlayer(20, "MID", 80, 5, flat(8)),
  scheduledPlayer(21, "MID", 80, 5, flat(7.9)),
  scheduledPlayer(22, "MID", 80, 5, flat(7.8)),
  scheduledPlayer(23, "MID", 80, 5, flat(7.7)),
  scheduledPlayer(24, "MID", 50, 6, flat(1)),
  scheduledPlayer(25, "MID", 50, 7, flat(0.9)),
  scheduledPlayer(30, "FWD", 85, 8, flat(9)),
  scheduledPlayer(31, "FWD", 85, 8, flat(8.9)),
  scheduledPlayer(32, "FWD", 85, 8, flat(1)),
  scheduledPlayer(33, "FWD", 55, 9, flat(0.9)),
];

describe("best possible XI from the market", () => {
  it("takes the highest-scoring legal XI and crowns its best player", async () => {
    const result = await exactBestPossibleXI({ players: market, gameweek: 1, budgetTenths: 1000 });

    expect(result.legal).toBe(true);
    expect(result.playerIds).toHaveLength(11);
    // Club caps drop the fourth premium defender and midfielder, leaving two 1.0 fillers.
    expect(result.projectedXI).toBeCloseTo(66.3, 6);
    expect(result.captainId).toBe(30);
    expect(result.projectedTotal).toBeCloseTo(75.3, 6);
  });

  it("never spends more than a club may contribute", async () => {
    const result = await exactBestPossibleXI({ players: market, gameweek: 1, budgetTenths: 1000 });
    const clubs = result.playerIds.reduce((counts, id) => {
      const teamId = market.find((player) => player.id === id)!.teamId;
      counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
      return counts;
    }, new Map<number, number>());

    expect(Math.max(...clubs.values())).toBeLessThanOrEqual(3);
    expect(result.playerIds).toEqual(expect.arrayContaining([10, 11, 12, 20, 21, 22]));
    expect(result.playerIds).not.toContain(13);
    expect(result.playerIds).not.toContain(23);
  });

  it("holds the ceiling under budget when the squad pot cannot afford the best XI", async () => {
    const result = await exactBestPossibleXI({ players: market, gameweek: 1, budgetTenths: 640 });

    expect(result.legal).toBe(true);
    expect(result.costTenths).toBeLessThanOrEqual(640);
    expect(result.projectedXI).toBeLessThan(66.3);
  });

  it("reports an error instead of an illegal XI when no formation fits the pot", async () => {
    const result = await exactBestPossibleXI({ players: market, gameweek: 1, budgetTenths: 500 });

    expect(result.legal).toBe(false);
    expect(result.playerIds).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("scores a blank gameweek as zero rather than reusing another gameweek", async () => {
    const blanked = market.map((player) => player.id === 30
      ? scheduledPlayer(30, "FWD", 85, 8, { 1: 9 })
      : player);
    const first = await exactBestPossibleXI({ players: blanked, gameweek: 1, budgetTenths: 1000 });
    const second = await exactBestPossibleXI({ players: blanked, gameweek: 2, budgetTenths: 1000 });

    expect(first.legal).toBe(true);
    expect(second.legal).toBe(true);
    expect(first.playerIds).toContain(30);
    expect(second.playerIds).not.toContain(30);
    expect(second.projectedXI).toBeLessThan(first.projectedXI);
  });
});
