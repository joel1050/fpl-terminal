import { describe, expect, it } from "vitest";
import { exactOptimizeFullSquad, financeContext } from "../../lib/optimizer/exactOptimizer";
import type { Player, Position } from "../../types/player";

function player(id: number, position: Position, price: number, points: number): Player {
  const fixtures = Array.from({ length: 3 }, (_, offset) => ({
    gameweek: offset + 1,
    opponentTeamId: 1000 + id,
    opponentShortName: "OPP",
    isHome: true,
    expectedPoints: points,
    expectedMinutes: 90,
    fixture: { gameweek: offset + 1, opponentTeamId: 1000 + id, opponentShortName: "OPP", isHome: true },
  }));
  return {
    id, firstName: `P${id}`, lastName: "Test", displayName: `P${id}`,
    teamId: 100 + id, teamName: `Team ${id}`, teamShortName: `T${id}`,
    position, priceTenths: price, ownership: 0, status: "a",
    current: { totalPoints: points, pointsPer90: points, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 90 },
    fixtures: fixtures.map((f) => f.fixture),
    projection: {
      playerId: id, fixtures, nextGW: points, next3: points * 3, next5: points * 5, next10: points * 10,
      expectedMinutes: 90, valueNext5: points, riskScore: 0, confidence: "HIGH", factors: [],
    },
  };
}

const squad = [
  player(1, "GK", 50, 5), player(2, "GK", 45, 2),
  ...Array.from({ length: 5 }, (_, i) => player(10 + i, "DEF", 45, 4 + i / 10)),
  ...Array.from({ length: 5 }, (_, i) => player(20 + i, "MID", 60, 5 + i / 10)),
  ...Array.from({ length: 3 }, (_, i) => player(30 + i, "FWD", 70, 5 + i / 10)),
];
const purchasePrices = Object.fromEntries(squad.map((candidate) => [
  candidate.id,
  candidate.id === 20 ? 50 : candidate.priceTenths,
]));

describe("exact optimizer finance", () => {
  it("budgets the full owned squad selling value plus bank and prices owned slots at selling value", () => {
    const context = financeContext({
      players: squad,
      bankTenths: 8,
      purchasePricesTenths: { 20: 50, 30: 60 },
    }, [20, 30, 21]);
    expect(context).not.toBeNull();
    // 20 bought at 50 now 60 -> 55; 30 bought at 60 now 70 -> 65.
    expect(context?.budgetTenths).toBe(8 + 55 + 65 + 60);
    expect(context?.costOf(squad.find((p) => p.id === 20)!)).toBe(55);
    expect(context?.costOf(squad.find((p) => p.id === 21)!)).toBe(60);
  });

  it("returns null when either finance input is missing", () => {
    expect(financeContext({ players: squad, bankTenths: 8 }, [20])).toBeNull();
    expect(financeContext({ players: squad, purchasePricesTenths: { 20: 50 } }, [20])).toBeNull();
  });

  it("accepts an appreciated locked squad at selling value rather than market value", async () => {
    const result = await exactOptimizeFullSquad({
      players: squad,
      squad: squad.map((p) => p.id),
      lockedPlayerIds: squad.map((p) => p.id),
      budgetTenths: 825,
      bankTenths: 0,
      purchasePricesTenths: purchasePrices,
      gameweek: 1,
      horizon: 1,
    });
    expect(result.legal).toBe(true);
    expect(result.playerIds).toHaveLength(15);
    expect(result.analysis?.totalCostTenths).toBe(825);
    expect(result.analysis?.bankTenths).toBe(0);
  });

  it("requires enough bank to buy an incoming player at market price", async () => {
    const incoming = player(99, "MID", 56, 20);
    const locked = squad.filter((candidate) => candidate.id !== 20).map((candidate) => candidate.id);
    const common = {
      players: [...squad, incoming],
      squad: squad.map((p) => p.id),
      lockedPlayerIds: locked,
      budgetTenths: 825,
      purchasePricesTenths: purchasePrices,
      gameweek: 1,
      horizon: 1,
    } as const;
    const [withoutBank, withBank] = await Promise.all([
      exactOptimizeFullSquad({ ...common, bankTenths: 0 }),
      exactOptimizeFullSquad({ ...common, bankTenths: 1 }),
    ]);
    expect(withoutBank.playerIds).toContain(20);
    expect(withoutBank.playerIds).not.toContain(99);
    expect(withBank.playerIds).toContain(99);
    expect(withBank.playerIds).not.toContain(20);
  });

  it("keeps market-price behavior when finance inputs are absent", async () => {
    const [withinBudget, belowMarketCost] = await Promise.all([
      exactOptimizeFullSquad({ players: squad, horizon: 1 }),
      exactOptimizeFullSquad({ players: squad, budgetTenths: 829, horizon: 1 }),
    ]);
    expect(withinBudget.legal).toBe(true);
    expect(belowMarketCost.legal).toBe(false);
  });

  it("counts owned selling value and market price for incoming players", async () => {
    const context = financeContext({
      players: squad,
      bankTenths: 0,
      purchasePricesTenths: Object.fromEntries(squad.slice(0, 14).map((p) => [p.id, p.priceTenths - 10])),
    }, squad.slice(0, 14).map((p) => p.id));
    expect(context).not.toBeNull();
    // Every owned player sells below market under the official rule, and the
    // incoming (non-owned) player in each calculation costs market price.
    expect(context!.costOf(squad.find((p) => p.id === 13)!)).toBeLessThan(squad.find((p) => p.id === 13)!.priceTenths);
    expect(context!.costOf(squad.find((p) => p.id === 32)!)).toBe(squad.find((p) => p.id === 32)!.priceTenths);
  });
});
