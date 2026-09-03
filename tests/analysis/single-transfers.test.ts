import { describe, expect, it } from "vitest";
import type { Player, Position } from "@/types/player";
import { findBestSingleTransfers } from "@/lib/analysis/singleTransfers";

function player(id: number, position: Position, priceTenths: number, points: number, teamId = id, status = "a"): Player {
  return {
    id,
    firstName: "P",
    lastName: String(id),
    displayName: `P${id}`,
    teamId,
    teamName: `T${teamId}`,
    teamShortName: `T${teamId}`,
    position,
    priceTenths,
    ownership: 0,
    status,
    current: { totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 90 },
    fixtures: [],
    projection: {
      playerId: id,
      fixtures: Array.from({ length: 5 }, (_, index) => ({
        gameweek: index + 1,
        expectedPoints: points,
        expectedMinutes: 90,
        fixture: { gameweek: index + 1, opponentTeamId: 1000 + id, opponentShortName: "OPP", isHome: true },
      })),
      nextGW: points,
      next3: points * 3,
      next5: points * 5,
      next10: points * 10,
      expectedMinutes: 90,
      valueNext5: points,
      riskScore: status === "a" ? 5 : 90,
      confidence: status === "a" ? "HIGH" : "LOW",
      factors: [],
    },
  };
}

const selected = [
  player(1, "GK", 45, 4), player(2, "GK", 40, 3),
  player(3, "DEF", 50, 6), player(4, "DEF", 48, 5), player(5, "DEF", 46, 4), player(6, "DEF", 44, 3), player(7, "DEF", 42, 2),
  player(8, "MID", 70, 8), player(9, "MID", 68, 7), player(10, "MID", 66, 6), player(11, "MID", 64, 5), player(12, "MID", 62, 4),
  player(13, "FWD", 85, 9), player(14, "FWD", 80, 8), player(15, "FWD", 75, 7),
];

describe("exact single-transfer optimizer", () => {
  it("returns only xP gains and prices released cash at 0.25 xP/GW per £1m", () => {
    const cashOnly = player(16, "MID", 47, 4);
    const both = player(17, "MID", 54, 5.5);
    const losing = player(18, "MID", 40, 4.5);

    expect(findBestSingleTransfers({ squad: selected, players: [...selected, cashOnly], gameweek: 1, horizon: 5, risk: "BALANCED", outgoingPlayerId: 12 })).toEqual([]);
    expect(findBestSingleTransfers({ squad: selected, players: [...selected, losing], gameweek: 1, horizon: 5, risk: "BALANCED", outgoingPlayerId: 11 })).toEqual([]);
    expect(findBestSingleTransfers({ squad: selected, players: [...selected, both], gameweek: 1, horizon: 5, risk: "BALANCED", outgoingPlayerId: 11 })[0])
      .toMatchObject({ projectedDelta: 2.5, projectedDeltaPerGW: 0.5, cashReleasedTenths: 10, score: 0.75, kind: "BOTH" });
  });

  it("uses lineup and captain effects instead of direct player xP", () => {
    const upgrade = player(16, "FWD", 85, 10);
    const [move] = findBestSingleTransfers({ squad: selected, players: [...selected, upgrade], gameweek: 1, horizon: 1, risk: "BALANCED", outgoingPlayerId: 13 });
    expect(move.projectedDelta).toBe(2); // one point in the XI and one captain bonus point
    expect(move.kind).toBe("XP_UPGRADE");
  });

  it("enforces locks, exclusions, budget, club limits, risk, and Pareto dominance", () => {
    const dominated = player(16, "DEF", 45, 6.5);
    const best = player(17, "DEF", 45, 7);
    const tooExpensive = player(18, "DEF", 400, 20);
    const risky = player(19, "DEF", 40, 20, 19, "i");
    const fourthFromClub = player(20, "DEF", 40, 20, 100);
    const squadWithThreeFromClub = selected.map((item, index) => index < 3 ? { ...item, teamId: 100 } : item);
    const universe = [...squadWithThreeFromClub, dominated, best, tooExpensive, risky, fourthFromClub];
    const moves = findBestSingleTransfers({ squad: squadWithThreeFromClub, players: universe, gameweek: 1, horizon: 1, risk: "SAFE", outgoingPlayerId: 4, excludedPlayerIds: [18] });

    expect(moves.map((move) => move.incomingPlayerId)).toEqual([17]);
    expect(findBestSingleTransfers({ squad: squadWithThreeFromClub, players: universe, gameweek: 1, horizon: 1, risk: "SAFE", outgoingPlayerId: 4, lockedPlayerIds: [4] })).toEqual([]);
  });

  it("returns no exact suggestions for an incomplete squad", () => {
    expect(findBestSingleTransfers({ squad: selected.slice(0, 14), players: selected, gameweek: 1 })).toEqual([]);
  });

  it("matches brute-force scoring after exact dominance pruning", () => {
    const alternatives = [player(16, "MID", 60, 5.5), player(17, "MID", 55, 5.2), player(18, "MID", 45, 4.7)];
    const input = { squad: selected, gameweek: 1, horizon: 3 as const, risk: "BALANCED" as const, outgoingPlayerId: 11 };
    const exact = findBestSingleTransfers({ ...input, players: [...selected, ...alternatives] });
    const brute = alternatives.flatMap((incoming) => findBestSingleTransfers({ ...input, players: [...selected, incoming] }));
    const dominates = (left: (typeof brute)[number], right: (typeof brute)[number]) => left.projectedDeltaPerGW >= right.projectedDeltaPerGW
      && left.cashReleasedTenths >= right.cashReleasedTenths
      && (left.projectedDeltaPerGW > right.projectedDeltaPerGW || left.cashReleasedTenths > right.cashReleasedTenths);
    const frontier = brute
      .filter((candidate, index) => !brute.some((other, otherIndex) => otherIndex !== index && dominates(other, candidate)))
      .sort((left, right) => right.score - left.score || right.projectedDelta - left.projectedDelta || right.cashReleasedTenths - left.cashReleasedTenths);
    expect(exact).toEqual(frontier);
  });
});

describe("selling prices", () => {
  // Player 11 was bought at 58 and is now 64: profit 6, so it sells for 58 + 3 = 61.
  const purchasePricesTenths = { 11: 58 };
  const cheaper = player(20, "MID", 55, 6);
  const dearer = player(21, "MID", 62, 6.5);

  it("releases the selling price, not the market price", () => {
    const suggestions = findBestSingleTransfers({
      squad: selected,
      players: [...selected, cheaper],
      gameweek: 1,
      horizon: 5,
      risk: "BALANCED",
      outgoingPlayerId: 11,
      bankTenths: 0,
      purchasePricesTenths,
    });
    expect(suggestions[0]).toMatchObject({ incomingPlayerId: 20, cashReleasedTenths: 6 }); // 61 − 55
  });

  it("refuses a transfer the bank cannot fund", () => {
    // Selling releases 61 with nothing in the bank, so a 62 target is out of
    // reach even though the squad's market total leaves plenty of headroom.
    const suggestions = findBestSingleTransfers({
      squad: selected,
      players: [...selected, dearer],
      gameweek: 1,
      horizon: 5,
      risk: "BALANCED",
      outgoingPlayerId: 11,
      bankTenths: 0,
      purchasePricesTenths,
    });
    expect(suggestions.some((item) => item.incomingPlayerId === 21)).toBe(false);
  });

  it("keeps market-price behaviour when no bank is supplied", () => {
    const suggestions = findBestSingleTransfers({
      squad: selected, players: [...selected, cheaper], gameweek: 1, horizon: 5, risk: "BALANCED", outgoingPlayerId: 11,
    });
    expect(suggestions[0]).toMatchObject({ incomingPlayerId: 20, cashReleasedTenths: 9 }); // 64 − 55
  });
});
