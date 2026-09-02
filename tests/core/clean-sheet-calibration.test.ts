import { describe, expect, it } from "vitest";
import { calculateFixtureAdjustment } from "@/lib/projections/fixtureAdjustment";
import type { TeamStrength } from "@/types/projection";

function team(teamId: number, strength: number): TeamStrength {
  return {
    teamId,
    attackHome: strength,
    attackAway: strength,
    defenceHome: strength,
    defenceAway: strength,
    overall: strength,
  };
}

function cleanSheetProbability(
  isHome: boolean,
  ownStrength: number,
  opponentStrength: number,
): number {
  return calculateFixtureAdjustment(
    {
      gameweek: 1,
      opponentTeamId: 2,
      opponentShortName: "OPP",
      isHome,
      difficulty: 3,
    },
    {
      ownTeam: team(1, ownStrength),
      opponentTeam: team(2, opponentStrength),
    },
  ).cleanSheetProbability;
}

describe("market-calibrated clean-sheet probabilities", () => {
  it("prices Coventry away to Arsenal at 6%", () => {
    expect(cleanSheetProbability(false, 0.84, 1.16)).toBe(0.06);
  });

  it("prices Arsenal at home to Coventry at 50%", () => {
    expect(cleanSheetProbability(true, 1.16, 0.84)).toBe(0.5);
  });

  it("uses separate home and away tables", () => {
    expect(cleanSheetProbability(true, 1, 1)).toBe(0.28);
    expect(cleanSheetProbability(false, 1, 1)).toBe(0.22);
  });

  it("improves as defence strengthens and declines as the opponent attack strengthens", () => {
    const tiers = [0.84, 0.92, 1, 1.08, 1.16];
    const homeByDefence = tiers.map((strength) => cleanSheetProbability(true, strength, 1));
    const awayByDefence = tiers.map((strength) => cleanSheetProbability(false, strength, 1));
    const homeByAttack = tiers.map((strength) => cleanSheetProbability(true, 1, strength));
    const awayByAttack = tiers.map((strength) => cleanSheetProbability(false, 1, strength));

    expect(homeByDefence).toEqual([0.2, 0.27, 0.28, 0.31, 0.39]);
    expect(awayByDefence).toEqual([0.15, 0.2, 0.22, 0.25, 0.34]);
    expect(homeByAttack).toEqual([0.39, 0.33, 0.28, 0.24, 0.17]);
    expect(awayByAttack).toEqual([0.33, 0.27, 0.22, 0.18, 0.13]);
  });

  it("keeps the difficulty-only fallback when team strengths are absent", () => {
    const easyHome = calculateFixtureAdjustment({
      gameweek: 1,
      opponentTeamId: 2,
      opponentShortName: "EASY",
      isHome: true,
      difficulty: 1,
    });
    const difficultAway = calculateFixtureAdjustment({
      gameweek: 1,
      opponentTeamId: 3,
      opponentShortName: "HARD",
      isHome: false,
      difficulty: 5,
    });

    expect(easyHome.cleanSheetProbability).toBeGreaterThan(difficultAway.cleanSheetProbability);
    expect(difficultAway.cleanSheetProbability).toBeCloseTo(
      Math.exp(-(1.35 * 1.1) / (0.84 ** 2)),
      10,
    );
  });

  it("interpolates smoothly between tiers without discrete jumps", () => {
    // Tier 1 (0.92) is 0.27; Tier 2 (1.00) is 0.28.
    // Midpoint 0.96 should interpolate smoothly to 0.275.
    const mid = cleanSheetProbability(true, 0.96, 1.0);
    expect(mid).toBe(0.275);
    expect(mid).toBeGreaterThan(cleanSheetProbability(true, 0.92, 1.0));
    expect(mid).toBeLessThan(cleanSheetProbability(true, 1.00, 1.0));
  });
});
