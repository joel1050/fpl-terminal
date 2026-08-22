import { describe, expect, it } from "vitest";
import type { Player, Position } from "@/types/player";
import {
  enumerateLegalStartingXIs,
  expectedAutosubValue,
  pickWeeklyTeam,
  probabilityDidNotPlay,
  validateWeeklyLineup,
} from "@/lib/squad/weeklyLineup";

function player(id: number, position: Position, points: number, status = "a"): Player {
  return {
    id,
    firstName: "P",
    lastName: String(id),
    displayName: `P${id}`,
    teamId: id,
    teamName: `T${id}`,
    teamShortName: `T${id}`,
    position,
    priceTenths: 50,
    ownership: 0,
    status,
    current: { totalPoints: points, pointsPer90: points, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 90 },
    fixtures: [],
    projection: {
      playerId: id,
      fixtures: [{ gameweek: 1, expectedPoints: points, expectedMinutes: 90, fixture: { gameweek: 1, opponentTeamId: 99, opponentShortName: "T", isHome: true } }],
      nextGW: points,
      next3: points * 3,
      next5: points * 5,
      expectedMinutes: 90,
      valueNext5: points,
      riskScore: status === "d" ? 50 : 5,
      confidence: "HIGH",
      factors: [],
    },
  };
}

function squad(): Player[] {
  return [
    player(1, "GK", 5), player(2, "GK", 4),
    player(3, "DEF", 5), player(4, "DEF", 5), player(5, "DEF", 5), player(6, "DEF", 5), player(7, "DEF", 5),
    player(8, "MID", 5), player(9, "MID", 5), player(10, "MID", 5), player(11, "MID", 5), player(12, "MID", 5),
    player(13, "FWD", 5), player(14, "FWD", 5), player(15, "FWD", 5),
  ];
}

describe("weekly lineup engine", () => {
  it("enumerates legal XIs and returns the approved lineup contract", () => {
    const players = squad();
    const xIs = enumerateLegalStartingXIs(players);
    const plan = pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "BALANCED" });
    expect(xIs.length).toBeGreaterThan(0);
    expect(plan.starterIds).toHaveLength(11);
    expect(plan.formation).toMatch(/^\d-\d-\d$/);
    expect(plan.benchOrder).toHaveLength(3);
    expect(plan.benchGoalkeeperId).toBe(2);
    expect(plan.projectionFingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("rejects malformed squads without inventing a lineup", () => {
    const plan = pickWeeklyTeam({ squad: squad().slice(0, 14), gameweek: 1, riskMode: "SAFE" });
    expect(plan.starterIds).toHaveLength(0);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("validates captain, vice-captain, bench, and formation state", () => {
    const players = squad();
    const plan = pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "SAFE" });
    expect(validateWeeklyLineup(plan, players).legal).toBe(true);
    expect(validateWeeklyLineup({ ...plan, viceCaptainId: plan.captainId }, players).legal).toBe(false);
    expect(validateWeeklyLineup({ ...plan, formation: "5-5-0" }, players).legal).toBe(false);
    expect(validateWeeklyLineup({ ...plan, gameweek: 0 }, players).legal).toBe(false);
    expect(validateWeeklyLineup({ ...plan, projectionFingerprint: "" }, players).legal).toBe(false);
  });

  it("uses pDNP and preserves formation when evaluating autosub permutations", () => {
    const players = squad().map((item) => item.id === 3 ? { ...item, status: "i" } : item);
    expect(probabilityDidNotPlay(players.find((item) => item.id === 3)!, 1)).toBe(1);
    expect(probabilityDidNotPlay(players.find((item) => item.id === 4)!, 1)).toBe(0);
    const starters = [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15]; // 3-4-3
    const value = expectedAutosubValue(starters, 2, [12, 6, 7], players, 1);
    expect(value).toBe(5); // MID 12 is skipped; DEF 6 is the first legal replacement.
  });

  it("uses the near-equal window for risk-aware tie-breaking", () => {
    const players = squad().map((item) => item.id === 8 ? { ...item, status: "d" } : item);
    const safe = pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "SAFE" });
    const aggressive = pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "AGGRESSIVE" });
    expect(safe.starterIds).not.toContain(8);
    expect(aggressive.starterIds).toContain(8);
  });

  it("sums both fixtures in a double gameweek", () => {
    const players = squad().map((item) => item.id === 1
      ? { ...item, projection: { ...item.projection!, fixtures: [
        { ...item.projection!.fixtures[0], expectedPoints: 4 },
        { ...item.projection!.fixtures[0], expectedPoints: 5 },
      ] } }
      : item);
    expect(pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "AGGRESSIVE" }).projectedXI).toBe(59);
  });

  it("returns zero points and certain non-appearance for a projected blank gameweek", () => {
    const players = squad();
    const plan = pickWeeklyTeam({ squad: players, gameweek: 2, riskMode: "AGGRESSIVE" });
    expect(plan.projectedXI).toBe(0);
    expect(plan.projectedTotal).toBe(0);
    expect(probabilityDidNotPlay(players[0], 2)).toBe(1);
  });

  it("uses raw xPts for captain and appearance-adjusted xPts for vice-captain", () => {
    const withPoints = (item: Player, points: number, status = item.status): Player => ({
      ...item,
      status,
      projection: {
        ...item.projection!,
        fixtures: item.projection!.fixtures.map((fixture) => ({ ...fixture, expectedPoints: points })),
        nextGW: points,
      },
    });
    const players = squad().map((item) => {
      if (item.id === 8) return withPoints(item, 10);
      if (item.id === 9) return withPoints(item, 9.9, "d");
      if (item.id === 10) return withPoints(item, 9.8);
      return item;
    });
    const plan = pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "AGGRESSIVE" });
    expect(plan.captainId).toBe(8);
    expect(plan.viceCaptainId).toBe(10);
  });

  it("includes goalkeeper points in expected autosub value", () => {
    const players = squad().map((item) => item.id === 1 ? { ...item, status: "i" } : item);
    const starters = [1, 3, 4, 5, 8, 9, 10, 11, 13, 14, 15];
    expect(expectedAutosubValue(starters, 2, [12, 6, 7], players, 1)).toBe(4);
  });

  it("keeps projection fingerprints stable across ordering and sensitive to xPts changes", () => {
    const players = squad();
    const first = pickWeeklyTeam({ squad: players, gameweek: 1, riskMode: "BALANCED" });
    const reordered = pickWeeklyTeam({ squad: [...players].reverse(), gameweek: 1, riskMode: "BALANCED" });
    const changed = players.map((item) => item.id === 1
      ? { ...item, projection: { ...item.projection!, fixtures: [{ ...item.projection!.fixtures[0], expectedPoints: 5.5 }] } }
      : item);
    const changedPlan = pickWeeklyTeam({ squad: changed, gameweek: 1, riskMode: "BALANCED" });
    expect(reordered.projectionFingerprint).toBe(first.projectionFingerprint);
    expect(changedPlan.projectionFingerprint).not.toBe(first.projectionFingerprint);
  });
});
