import { describe, expect, it } from "vitest";
import type { Player } from "@/types/player";
import { keeperSavePercentage, projectPlayer } from "@/lib/projections";

function keeper(overrides?: Partial<Player>): Player {
  return {
    id: 1,
    firstName: "Test",
    lastName: "Keeper",
    displayName: "Test Keeper",
    teamId: 1,
    teamName: "Test",
    teamShortName: "TST",
    position: "GK",
    priceTenths: 50,
    ownership: 0,
    status: "a",
    current: { totalPoints: 0, minutes: 180, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, saves: 12, goalsConceded: 5 },
    historical: { season: "2025/26", minutes: 2_835, starts: 32, saves: 95, goalsConceded: 40 },
    fixtures: [{ gameweek: 4, opponentTeamId: 2, opponentShortName: "OPP", isHome: true, difficulty: 2 }],
    ...overrides,
  };
}

describe("keeperSavePercentage", () => {
  it("returns the empirical rate with no prior weight", () => {
    // (95 + 12) saves / (95 + 40 + 12 + 5) shots = 107 / 152.
    expect(keeperSavePercentage(keeper(), 0, 0.661)).toBeCloseTo(107 / 152, 12);
  });

  it("returns the league rate at infinite prior weight", () => {
    expect(keeperSavePercentage(keeper(), Number.POSITIVE_INFINITY, 0.661)).toBe(0.661);
  });

  it("falls back to the league rate with no shots faced", () => {
    const rookie = keeper({
      current: { totalPoints: 0, minutes: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0 },
      historical: undefined,
    });
    expect(keeperSavePercentage(rookie, 0, 0.661)).toBe(0.661);
  });

  it("clamps a perfect record below 1 so volume stays finite", () => {
    const perfect = keeper({
      current: { totalPoints: 0, minutes: 90, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, saves: 8, goalsConceded: 0 },
      historical: undefined,
    });
    expect(keeperSavePercentage(perfect, 0, 0.661)).toBe(0.95);
  });
});

describe("coherent saves option", () => {
  it("defaults to shipped behaviour when the kappa override is absent", () => {
    const options = { currentGameweek: 4, horizon: 1 as const, expectedMinutes: 90 };
    const shipped = projectPlayer(keeper(), options);
    const explicit = projectPlayer(keeper(), { ...options, savePercentageKappa: undefined });
    expect(explicit.fixtures[0]?.components?.saves).toBe(shipped.fixtures[0]?.components?.saves);
  });

  it("makes infinite-kappa saves a pure function of the team lambda", () => {
    const options = {
      currentGameweek: 4,
      horizon: 1 as const,
      expectedMinutes: 90,
      savePercentageKappa: Number.POSITIVE_INFINITY,
      leagueSavePercentage: 0.67,
    };
    const first = projectPlayer(keeper({ id: 1 }), options);
    const second = projectPlayer(
      keeper({ id: 2, current: { totalPoints: 0, minutes: 90, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, saves: 30, goalsConceded: 30 } }),
      options,
    );
    expect(first.fixtures[0]?.components?.saves).toBe(second.fixtures[0]?.components?.saves);
  });

  it("keeps goalkeeper goals at zero on the coherent path", () => {
    const projection = projectPlayer(keeper(), {
      currentGameweek: 4,
      horizon: 1 as const,
      expectedMinutes: 90,
      savePercentageKappa: 100,
      leagueSavePercentage: 0.67,
    });
    expect(projection.fixtures[0]?.components?.goals).toBe(0);
  });
});
