import { describe, expect, it } from "vitest";
import type { Player, Position } from "../../types/player";
import { analyzeSquad } from "../../lib/analysis/analyzeSquad";
import { findReplacements, suggestForSlot } from "../../lib/analysis/replacements";
import { simulateChange } from "../../lib/analysis/simulateChange";
import { optimizeAroundLockedPlayers } from "../../lib/optimizer/optimizer";

function player(id: number, position: Position, priceTenths: number, teamId = 100 + id, points = 5): Player {
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
    current: { totalPoints: points, pointsPer90: points, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 90 },
    fixtures: [{ gameweek: 1, opponentTeamId: teamId + 1, opponentShortName: "T", isHome: true, difficulty: 2 }],
  };
}

const universe = [
  player(1, "GK", 50), player(2, "GK", 45), player(3, "GK", 40),
  player(4, "DEF", 55), player(5, "DEF", 52), player(6, "DEF", 50), player(7, "DEF", 48), player(8, "DEF", 46), player(9, "DEF", 44), player(10, "DEF", 42),
  player(11, "MID", 70), player(12, "MID", 68), player(13, "MID", 65), player(14, "MID", 62), player(15, "MID", 60), player(16, "MID", 55), player(17, "MID", 50),
  player(18, "FWD", 85), player(19, "FWD", 78), player(20, "FWD", 65), player(21, "FWD", 55),
];
const squad = [1, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 18, 19, 20, 2];

describe("squad analysis", () => {
  it("returns cost, starters, bench, and explainable weaknesses", () => {
    const result = analyzeSquad({ squad, players: universe });
    expect(result.totalCostTenths).toBe(899);
    expect(result.startingXI).toHaveLength(11);
    expect(result.bench).toHaveLength(4);
    expect(result.weaknesses.every((weakness) => weakness.reasons.length > 0)).toBe(true);
  });

  it("keeps replacements legal and respects exclusions", () => {
    const candidates = findReplacements({ outgoingPlayerId: 15, squad, players: universe, excludedPlayerIds: [16] });
    expect(candidates.some((candidate) => candidate.playerId === 16)).toBe(false);
    expect(candidates.every((candidate) => !squad.includes(candidate.playerId))).toBe(true);
  });

  it("does not mutate the squad while simulating", () => {
    const result = simulateChange({ squad, players: universe, outId: 15, inId: 16 });
    expect(result.after.totalCostTenths).toBe(result.before.totalCostTenths - 5);
    expect(squad).toContain(15);
    expect(squad).not.toContain(16);
  });
});

describe("optimizer", () => {
  it("returns a legal full squad and preserves a lock", () => {
    const result = optimizeAroundLockedPlayers({ players: universe, lockedPlayerIds: [18] });
    expect(result.legal).toBe(true);
    expect(result.playerIds).toHaveLength(15);
    expect(result.playerIds).toContain(18);
    expect(new Set(result.playerIds).size).toBe(15);
    const backupGoalkeeperId = result.analysis?.bench.find((id) => universe.find((item) => item.id === id)?.position === "GK");
    expect(universe.find((item) => item.id === backupGoalkeeperId)?.priceTenths).toBe(40);
  });

  it("preserves two compatible fixed goalkeepers without requiring a £4.0m backup", () => {
    const result = optimizeAroundLockedPlayers({ players: universe, lockedPlayerIds: [1, 2] });
    expect(result.legal).toBe(true);
    expect(result.playerIds).toEqual(expect.arrayContaining([1, 2]));
  });

  it("completes an empty slot with a budget-safe candidate", () => {
    const result = suggestForSlot({ position: "FWD", currentSquad: squad.slice(0, -2), players: universe });
    expect(result.maxAffordablePriceTenths).toBeDefined();
    expect(result.every((candidate) => candidate.priceTenths <= (result.maxAffordablePriceTenths ?? 0))).toBe(true);
  });
});
