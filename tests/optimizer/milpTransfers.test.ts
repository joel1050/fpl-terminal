import { describe, expect, it } from "vitest";
import type { Player, Position } from "@/types/player";
import { findMilpTransferSuggestions } from "@/lib/optimizer/milpTransfers";

function player(id: number, position: Position, priceTenths: number, points: number, teamId: number = id): Player {
  const fixtures = Array.from({ length: 10 }, (_, i) => ({
    gameweek: i + 1,
    opponentTeamId: 99,
    opponentShortName: "OPP",
    isHome: true,
    expectedPoints: points,
    expectedMinutes: 90,
    fixture: { gameweek: i + 1, opponentTeamId: 99, opponentShortName: "OPP", isHome: true },
  }));
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
    ownership: 10,
    status: "a",
    current: { totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 90 },
    fixtures,
    projection: {
      playerId: id,
      expectedMinutes: 90,
      valueNext5: points / (priceTenths / 10),
      riskScore: 0,
      confidence: "HIGH",
      factors: [],
      nextGW: points,
      next3: points * 3,
      next5: points * 5,
      next10: points * 10,
      fixtures,
    },
  };
}

const squad: Player[] = [
  player(1, "GK", 45, 3.0, 1),
  player(2, "GK", 40, 1.0, 2),
  player(3, "DEF", 50, 3.5, 3),
  player(4, "DEF", 45, 3.0, 4),
  player(5, "DEF", 45, 3.0, 5),
  player(6, "DEF", 40, 2.0, 6),
  player(7, "DEF", 40, 2.0, 7),
  player(8, "MID", 80, 5.0, 8),
  player(9, "MID", 75, 4.5, 9),
  player(10, "MID", 65, 4.0, 10),
  player(11, "MID", 55, 3.0, 11),
  player(12, "MID", 45, 2.0, 12),
  player(13, "FWD", 140, 8.0, 13),
  player(14, "FWD", 70, 4.0, 14),
  player(15, "FWD", 55, 3.0, 15),
];

const targets: Player[] = [
  // High value replacements
  player(16, "MID", 60, 5.5, 16),
  player(17, "DEF", 50, 4.5, 17),
  player(18, "FWD", 75, 6.0, 18),
  // Worse replacement that frees up lots of cash
  player(19, "MID", 40, 1.0, 19),
];

const allPlayers = [...squad, ...targets];

describe("MILP multi-transfers", () => {
  it("finds single transfer suggestions", async () => {
    const suggestions = await findMilpTransferSuggestions({
      squad,
      players: allPlayers,
      gameweek: 1,
      horizon: 5,
      bankTenths: 10,
      maxTransfers: 1,
    });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].transfersCount).toBe(1);
    expect(suggestions[0].projectedDelta).toBeGreaterThan(0);
  });

  it("finds chained multi-transfer suggestions for k=2", async () => {
    const suggestions = await findMilpTransferSuggestions({
      squad,
      players: allPlayers,
      gameweek: 1,
      horizon: 5,
      bankTenths: 10,
      maxTransfers: 2,
    });
    const multi = suggestions.filter((s) => s.transfersCount === 2);
    expect(multi.length).toBeGreaterThan(0);
    expect(multi[0].moves).toHaveLength(2);
  });

  it("respects locked player constraints", async () => {
    const suggestions = await findMilpTransferSuggestions({
      squad,
      players: allPlayers,
      gameweek: 1,
      horizon: 5,
      bankTenths: 10,
      maxTransfers: 2,
      lockedPlayerIds: [11, 12],
    });
    for (const suggestion of suggestions) {
      if (suggestion.moves) {
        for (const m of suggestion.moves) {
          expect(m.outgoingPlayerId).not.toBe(11);
          expect(m.outgoingPlayerId).not.toBe(12);
        }
      }
    }
  });

  it("only returns suggestions that induce positive points gained and ranks strictly by points gained", async () => {
    const suggestions = await findMilpTransferSuggestions({
      squad,
      players: allPlayers,
      gameweek: 1,
      horizon: 5,
      bankTenths: 10,
      maxTransfers: 2,
    });

    // All suggestions must have projectedDelta > 0 (strictly positive points gained)
    for (const s of suggestions) {
      expect(s.projectedDelta).toBeGreaterThan(0);
      expect(s.afterXp).toBeGreaterThan(s.beforeXp);
    }

    // Must be ranked descending by projectedDelta (points gained over that horizon)
    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i - 1].projectedDelta).toBeGreaterThanOrEqual(suggestions[i].projectedDelta);
    }
  });

  it("returns no suggestions if no legal transfer improves points", async () => {
    // Only available target has strictly worse expected points
    const worseUniverse = [...squad, player(20, "MID", 45, 1.0, 20)];
    const suggestions = await findMilpTransferSuggestions({
      squad,
      players: worseUniverse,
      gameweek: 1,
      horizon: 5,
      bankTenths: 0,
      maxTransfers: 1,
    });
    expect(suggestions).toEqual([]);
  });

  it("orders multi-transfers by which one frees up money first", async () => {
    const suggestions = await findMilpTransferSuggestions({
      squad,
      players: allPlayers,
      gameweek: 1,
      horizon: 5,
      bankTenths: 10,
      maxTransfers: 2,
    });
    const multi = suggestions.filter((s) => s.transfersCount === 2);
    expect(multi.length).toBeGreaterThan(0);
    for (const s of multi) {
      expect(s.moves).toBeDefined();
      expect(s.moves!.length).toBe(2);
      expect(s.moves![0].cashReleasedTenths).toBeDefined();
      expect(s.moves![1].cashReleasedTenths).toBeDefined();
      // First move must free up at least as much or more cash than second move
      expect(s.moves![0].cashReleasedTenths!).toBeGreaterThanOrEqual(s.moves![1].cashReleasedTenths!);
    }
  });
});
