import { describe, expect, it } from "vitest";
import {
  AWAY_ATTACK_MULTIPLIER,
  HOME_ATTACK_MULTIPLIER,
  calculateFixtureAdjustment,
} from "@/lib/projections/fixtureAdjustment";
import type { TeamStrength } from "@/types/projection";

function team(teamId: number, attack: number, defence: number): TeamStrength {
  return {
    teamId,
    attackHome: attack,
    attackAway: attack,
    defenceHome: defence,
    defenceAway: defence,
    overall: (attack + defence) / 2,
  };
}

/** Neutral difficulty keeps `base` at 1.0 so venue and the ratio are the only terms. */
const neutralAway = { gameweek: 1, opponentTeamId: 2, opponentShortName: "OPP", isHome: false, difficulty: 3 };
const neutralHome = { ...neutralAway, isHome: true };

/** Attack multiplier for a side whose attack/opponent-defence ratio is `ratio`. */
function attackFor(ratio: number, isHome = false): number {
  return calculateFixtureAdjustment(isHome ? neutralHome : neutralAway, {
    ownTeam: team(1, ratio, 1),
    opponentTeam: team(2, 1, 1),
  }).attackMultiplier;
}

describe("fixture adjustment", () => {
  it("uses the measured home advantage, not a token one", () => {
    const home = calculateFixtureAdjustment(neutralHome).attackMultiplier;
    const away = calculateFixtureAdjustment(neutralAway).attackMultiplier;
    expect(home).toBeCloseTo(HOME_ATTACK_MULTIPLIER, 10);
    expect(away).toBeCloseTo(AWAY_ATTACK_MULTIPLIER, 10);
    // Measured over 2025/26: 1.551 home xG against 1.264 away.
    expect(home / away).toBeCloseTo(1.227, 2);
  });

  it("separates matchups the old [0.78, 1.22] clamp flattened together", () => {
    // Both of these truncated to 1.22 before the clamp was widened.
    expect(attackFor(1.34)).toBeGreaterThan(attackFor(1.25));
    expect(attackFor(0.72)).toBeLessThan(attackFor(0.8));
    expect(attackFor(1.3)).toBeCloseTo(AWAY_ATTACK_MULTIPLIER * 1.3, 10);
  });

  it("still clamps past the widened window", () => {
    // blendInSeasonForm floors a defence ratio at 0.05, so an unbounded ratio
    // could reach ~25. Beyond the window every ratio collapses to the edge.
    expect(attackFor(1.4)).toBeCloseTo(attackFor(25), 10);
    expect(attackFor(0.6)).toBeCloseTo(attackFor(0.01), 10);
    expect(attackFor(1.4)).toBeCloseTo(AWAY_ATTACK_MULTIPLIER * 1.35, 10);
  });

  it("keeps the outer multiplier clamp, which carries the top of the range", () => {
    const extreme = calculateFixtureAdjustment(
      { ...neutralHome, difficulty: 1 },
      { ownTeam: team(1, 1.35, 1), opponentTeam: team(2, 1, 1) },
    );
    // 1.14 base * 1.102 venue * 1.35 ratio = 1.696 before the guard.
    expect(extreme.attackMultiplier).toBe(1.3);
  });

  it("keeps goals-against and the clean-sheet probability on one Poisson", () => {
    const result = calculateFixtureAdjustment(neutralHome, {
      ownTeam: team(1, 1, 1),
      opponentTeam: team(2, 1, 1),
    });
    expect(Math.exp(-result.expectedGoalsAgainst)).toBeCloseTo(result.cleanSheetProbability, 10);
  });
});
