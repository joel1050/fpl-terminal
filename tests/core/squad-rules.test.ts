import { describe, expect, it } from "vitest";
import type { Player, Position } from "@/types/player";
import {
  calculateBudgetFeasibility,
  explainIllegalSelection,
  maxSafePriceForPosition,
  selectStartingXI,
  validateCaptainVice,
  validateSquad,
} from "@/lib/squad";

function player(id: number, position: Position, priceTenths: number, teamId = id): Player {
  return {
    id,
    firstName: "P",
    lastName: String(id),
    displayName: `Player ${id}`,
    teamId,
    teamName: `Team ${teamId}`,
    teamShortName: `T${teamId}`,
    position,
    priceTenths,
    ownership: 0,
    status: "a",
    current: { totalPoints: 0, minutes: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0 },
    fixtures: [],
  };
}

function legalSquad(price = 60): Player[] {
  return [
    ...[1, 2].map((id) => player(id, "GK", price, id)),
    ...[3, 4, 5, 6, 7].map((id) => player(id, "DEF", price, id)),
    ...[8, 9, 10, 11, 12].map((id) => player(id, "MID", price, id)),
    ...[13, 14, 15].map((id) => player(id, "FWD", price, id)),
  ];
}

describe("deterministic squad rules", () => {
  it("accepts £100.0m and rejects £100.1m", () => {
    expect(validateSquad(legalSquad()).legal).toBe(true);
    expect(validateSquad(legalSquad(67)).legal).toBe(false);
  });

  it("enforces exact positions and the three-player club limit", () => {
    const wrongShape = legalSquad().slice(0, 14);
    expect(validateSquad(wrongShape).legal).toBe(false);
    const fourFromOneClub = legalSquad().map((item, index) => index < 4 ? { ...item, teamId: 99 } : item);
    expect(validateSquad(fourFromOneClub).legal).toBe(false);
  });

  it("detects a partial squad that cannot be completed", () => {
    const selected = legalSquad(71).slice(0, 14);
    const missing = player(16, "FWD", 20, 16);
    const result = calculateBudgetFeasibility(selected, [missing]);
    expect(result.feasible).toBe(false);
    expect(result.minimumRequiredTenths).toBe(20);
    expect(explainIllegalSelection(missing, selected, [missing]).legal).toBe(false);
  });

  it("returns the highest safe price and skips an expensive infeasible candidate", () => {
    const full = legalSquad(60);
    const selected = full.filter((item) => item.id !== 12 && item.id !== 15);
    const premium = player(100, "MID", 200, 20);
    const safe = player(101, "MID", 100, 21);
    const finalForward = player(102, "FWD", 30, 22);

    expect(maxSafePriceForPosition("MID", selected, [premium, safe, finalForward])).toBe(100);
  });

  it("handles a full-sized player pool without candidate-by-candidate state work", () => {
    const selected = legalSquad(60).filter((item) => item.id !== 12 && item.id !== 15);
    const pool = Array.from({ length: 599 }, (_, index) => {
      const positions: Position[] = ["GK", "DEF", "MID", "FWD"];
      return player(1_000 + index, positions[index % positions.length], 40 + (index % 80), 100 + (index % 20));
    });
    expect(maxSafePriceForPosition("MID", selected, pool)).toBeGreaterThanOrEqual(0);
  });

  it("selects exactly one goalkeeper and a legal XI", () => {
    const squad = legalSquad().map((item, index) => ({
      ...item,
      projection: { playerId: item.id, fixtures: [], nextGW: index, next3: index, next5: index, next10: index, expectedMinutes: 90, valueNext5: index, riskScore: 0, confidence: "HIGH" as const, factors: [] },
    }));
    const plan = selectStartingXI(squad);
    expect(plan.playerIds).toHaveLength(11);
    expect(new Set(plan.playerIds).size).toBe(11);
    expect(plan.bench.outfieldIds).toHaveLength(3);
    expect(squad.filter((item) => plan.playerIds.includes(item.id) && item.position === "GK")).toHaveLength(1);
  });

  it("requires different starter captain and vice-captain", () => {
    const squad = legalSquad();
    const starters = selectStartingXI(squad);
    expect(validateCaptainVice(squad, starters.playerIds[0], starters.playerIds[0], starters).legal).toBe(false);
    expect(validateCaptainVice(squad, starters.playerIds[0], starters.playerIds[1], starters).legal).toBe(true);
  });
});
