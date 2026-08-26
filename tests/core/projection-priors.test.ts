import { describe, expect, it } from "vitest";
import type { Player } from "@/types/player";
import { projectPlayer, regressPer90 } from "@/lib/projections";
import { HOME_ATTACK_MULTIPLIER } from "@/lib/projections/fixtureAdjustment";

// xG and xA are not goals and assists. A defender's chances are set-piece
// headers that convert at 0.70, while FPL awards 1.272 assists per xA.
// See GOAL_CONVERSION / ASSIST_CONVERSION in projectPlayer.ts.
const DEF_GOAL_POINTS = 6 * 0.7;
const DEF_ASSIST_POINTS = 3 * 1.272;

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
    const attackMultiplier = HOME_ATTACK_MULTIPLIER;

    expect(projection.components?.goals).toBeCloseTo(0.02 * attackMultiplier * DEF_GOAL_POINTS, 8);
    expect(projection.components?.assists).toBeCloseTo(0.02 * attackMultiplier * DEF_ASSIST_POINTS, 8);
  });

  it("keeps the position prior override scoped to xG", () => {
    const projection = projectPlayer(defender(), {
      currentGameweek: 1,
      horizon: 1,
      expectedMinutes: 90,
      positionPrior: { DEF: 0.5 },
    });
    const attackMultiplier = HOME_ATTACK_MULTIPLIER;

    expect(projection.components?.goals).toBeCloseTo(0.5 * attackMultiplier * DEF_GOAL_POINTS, 8);
    expect(projection.components?.assists).toBeCloseTo(0.02 * attackMultiplier * DEF_ASSIST_POINTS, 8);
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
    const attackMultiplier = HOME_ATTACK_MULTIPLIER;
    const regressedCurrentRate = regressPer90(0.02 * 0.9 + 0.9 * 0.1, 9, 0.02, 900);

    expect(projection.components?.goals).toBeCloseTo(regressedCurrentRate * attackMultiplier * DEF_GOAL_POINTS, 8);
    expect(projection.components?.assists).toBeCloseTo(regressedCurrentRate * attackMultiplier * DEF_ASSIST_POINTS, 8);
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
    const attackMultiplier = HOME_ATTACK_MULTIPLIER;
    const historicalRate = regressPer90(1.8, 900, 0.08, 900);

    expect(projection.components?.goals).toBeCloseTo(historicalRate * attackMultiplier * DEF_GOAL_POINTS, 8);
    expect(projection.components?.assists).toBeCloseTo(historicalRate * attackMultiplier * DEF_ASSIST_POINTS, 8);
    expect(projection.components?.goals).toBeGreaterThan(0.02 * attackMultiplier * DEF_GOAL_POINTS);
    expect(projection.components?.assists).toBeGreaterThan(0.02 * attackMultiplier * DEF_ASSIST_POINTS);
  });

  it("uses the recency-weighted in-season match history when playerForm is supplied", () => {
    const withoutForm = projectPlayer(defender({
      historical: { season: "2025/26", minutes: 900, expectedGoals: 1.8, expectedAssists: 1.8 },
    }), { currentGameweek: 1, horizon: 1, expectedMinutes: 90 });

    const hotForm = [
      { xg: 0.3, xa: 0.1, minutes: 90 },
      { xg: 0.5, xa: 0.1, minutes: 90 },
      { xg: 0.9, xa: 0.1, minutes: 90 }, // most recent match, well above the 0.1 historical xG/90 rate
    ];
    const withForm = projectPlayer(defender({
      id: 1,
      historical: { season: "2025/26", minutes: 900, expectedGoals: 1.8, expectedAssists: 1.8 },
    }), {
      currentGameweek: 1,
      horizon: 1,
      expectedMinutes: 90,
      playerForm: { 1: hotForm },
    });

    // A hot in-season match history should raise the projection above the
    // historical-only baseline, but a 24-match prior weight keeps 3 matches
    // from swinging it anywhere near the raw recent rate (0.9).
    expect(withForm.components?.goals).toBeGreaterThan(withoutForm.components?.goals ?? 0);
    const attackMultiplier = HOME_ATTACK_MULTIPLIER;
    expect(withForm.components?.goals).toBeLessThan(0.9 * attackMultiplier * DEF_GOAL_POINTS);
  });

  it("falls back to the cumulative current-season rate when no playerForm history exists yet", () => {
    const projection = projectPlayer(defender({
      current: {
        totalPoints: 0, minutes: 90, goals: 0, assists: 0, cleanSheets: 0, bonus: 0,
        expectedGoals: 0.9, expectedAssists: 0.9,
      },
    }), { currentGameweek: 1, horizon: 1, expectedMinutes: 90, playerForm: {} });
    const attackMultiplier = HOME_ATTACK_MULTIPLIER;
    const regressedCurrentRate = regressPer90(0.02 * 0.9 + 0.9 * 0.1, 9, 0.02, 900);

    expect(projection.components?.goals).toBeCloseTo(regressedCurrentRate * attackMultiplier * DEF_GOAL_POINTS, 8);
  });
});
