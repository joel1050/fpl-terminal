import { describe, expect, it } from "vitest";
import type { Player } from "@/types/player";
import { projectPlayer, regressPer90 } from "@/lib/projections";

function defender(overrides: Partial<Player> = {}): Player {
  return {
    id: 1,
    firstName: "Test",
    lastName: "Defender",
    displayName: "Test Defender",
    teamId: 1,
    teamName: "Test",
    teamShortName: "TST",
    position: "DEF",
    priceTenths: 40,
    ownership: 0,
    status: "a",
    current: { totalPoints: 0, minutes: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0 },
    fixtures: [{ gameweek: 1, opponentTeamId: 2, opponentShortName: "OPP", isHome: true, difficulty: 3 }],
    ...overrides,
  };
}

describe("defender attacking priors", () => {
  it("uses the conservative prior when no historical or current attacking sample exists", () => {
    const projection = projectPlayer(defender(), { currentGameweek: 1, horizon: 1, expectedMinutes: 90 });
    const attackMultiplier = 1.03;

    expect(projection.components?.goals).toBeCloseTo(0.02 * attackMultiplier * 6, 8);
    expect(projection.components?.assists).toBeCloseTo(0.02 * attackMultiplier * 3, 8);
  });

  it("keeps the position prior override scoped to xG", () => {
    const projection = projectPlayer(defender(), {
      currentGameweek: 1,
      horizon: 1,
      expectedMinutes: 90,
      positionPrior: { DEF: 0.5 },
    });
    const attackMultiplier = 1.03;

    expect(projection.components?.goals).toBeCloseTo(0.5 * attackMultiplier * 6, 8);
    expect(projection.components?.assists).toBeCloseTo(0.02 * attackMultiplier * 3, 8);
  });

  it("keeps current-only defenders regressed toward the conservative prior", () => {
    const projection = projectPlayer(defender({
      current: {
        totalPoints: 0,
        minutes: 90,
        goals: 0,
        assists: 0,
        cleanSheets: 0,
        bonus: 0,
        expectedGoals: 0.9,
        expectedAssists: 0.9,
      },
    }), { currentGameweek: 1, horizon: 1, expectedMinutes: 90 });
    const attackMultiplier = 1.03;
    const regressedCurrentRate = regressPer90(0.02 * 0.9 + 0.9 * 0.1, 9, 0.02, 900);

    expect(projection.components?.goals).toBeCloseTo(regressedCurrentRate * attackMultiplier * 6, 8);
    expect(projection.components?.assists).toBeCloseTo(regressedCurrentRate * attackMultiplier * 3, 8);
  });

  it("keeps mapped defenders on regressed historical xG and xA rates", () => {
    const projection = projectPlayer(defender({
      historical: {
        season: "2025/26",
        minutes: 900,
        expectedGoals: 18,
        expectedAssists: 18,
      },
    }), { currentGameweek: 1, horizon: 1, expectedMinutes: 90 });
    const attackMultiplier = 1.03;
    const historicalRate = regressPer90(1.8, 900, 0.08, 900);

    expect(projection.components?.goals).toBeCloseTo(historicalRate * attackMultiplier * 6, 8);
    expect(projection.components?.assists).toBeCloseTo(historicalRate * attackMultiplier * 3, 8);
    expect(projection.components?.goals).toBeGreaterThan(0.02 * attackMultiplier * 6);
    expect(projection.components?.assists).toBeGreaterThan(0.02 * attackMultiplier * 3);
  });
});
