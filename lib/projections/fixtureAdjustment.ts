import type { PlayerFixture, Position } from "@/types/player";
import type { TeamStrength } from "@/types/projection";

export interface FixtureAdjustmentOptions {
  ownTeam?: TeamStrength;
  opponentTeam?: TeamStrength;
  position?: Position;
}

export interface FixtureAdjustmentResult {
  attackMultiplier: number;
  defenceMultiplier: number;
  cleanSheetProbability: number;
  overallMultiplier: number;
}

const difficultyMultiplier: Record<number, number> = {
  1: 1.14,
  2: 1.07,
  3: 1,
  4: 0.92,
  5: 0.84,
};

const consensusStrengthTiers = [0.84, 0.92, 1, 1.08, 1.16] as const;

// Market-calibrated clean-sheet probabilities. Rows are the defending team's
// tier; columns are the opponent's attacking tier.
const cleanSheetProbabilities = {
  home: [
    [0.26, 0.24, 0.20, 0.15, 0.11],
    [0.36, 0.31, 0.27, 0.24, 0.17],
    [0.39, 0.33, 0.28, 0.24, 0.17],
    [0.42, 0.36, 0.31, 0.27, 0.19],
    [0.50, 0.42, 0.39, 0.33, 0.27],
  ],
  away: [
    [0.23, 0.16, 0.15, 0.12, 0.06],
    [0.31, 0.25, 0.20, 0.17, 0.11],
    [0.33, 0.27, 0.22, 0.18, 0.13],
    [0.36, 0.30, 0.25, 0.21, 0.15],
    [0.42, 0.35, 0.34, 0.30, 0.18],
  ],
} as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function nearestStrengthTier(value: number): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  consensusStrengthTiers.forEach((tier, index) => {
    const distance = Math.abs(value - tier);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  });
  return nearestIndex;
}

/** Returns transparent attacking/defensive adjustments for one fixture. */
export function calculateFixtureAdjustment(
  fixture: PlayerFixture,
  options: FixtureAdjustmentOptions = {},
): FixtureAdjustmentResult {
  const difficulty = fixture.difficulty === undefined
    ? 3
    : clamp(Math.round(fixture.difficulty), 1, 5);
  const base = difficultyMultiplier[difficulty] ?? 1;
  const venue = fixture.isHome ? 1.03 : 0.97;
  let expectedGoalsAgainst = 1.35 * (fixture.isHome ? 0.9 : 1.1);
  let attackMultiplier = base * venue;
  // Easy opponents improve both attacking returns and clean-sheet odds.
  let defenceMultiplier = base * (fixture.isHome ? 1.03 : 0.97);
  let cleanSheetProbability: number | undefined;

  const own = options.ownTeam;
  const opponent = options.opponentTeam;
  if (own && opponent) {
    const ownAttack = fixture.isHome ? own.attackHome : own.attackAway;
    const ownDefence = fixture.isHome ? own.defenceHome : own.defenceAway;
    const opponentAttack = fixture.isHome ? opponent.attackAway : opponent.attackHome;
    const opponentDefence = fixture.isHome ? opponent.defenceAway : opponent.defenceHome;
    if (ownAttack > 0 && opponentDefence > 0) {
      attackMultiplier *= clamp(ownAttack / opponentDefence, 0.78, 1.22);
    }
    if (ownDefence > 0 && opponentAttack > 0) {
      defenceMultiplier *= clamp(ownDefence / opponentAttack, 0.78, 1.22);
      expectedGoalsAgainst *= Math.pow(clamp(opponentAttack / ownDefence, 0.55, 1.8), 1.5);
      const ownDefenceTier = nearestStrengthTier(ownDefence);
      const opponentAttackTier = nearestStrengthTier(opponentAttack);
      cleanSheetProbability = cleanSheetProbabilities[fixture.isHome ? "home" : "away"]
        [ownDefenceTier][opponentAttackTier];
    }
  } else {
    expectedGoalsAgainst /= Math.pow(base, 2);
  }
  attackMultiplier = clamp(attackMultiplier, 0.7, 1.3);
  defenceMultiplier = clamp(defenceMultiplier, 0.7, 1.3);
  cleanSheetProbability ??= clamp(Math.exp(-expectedGoalsAgainst), 0.03, 0.65);
  const position = options.position;
  const overallMultiplier = position === "GK" || position === "DEF"
    ? defenceMultiplier
    : attackMultiplier;
  return { attackMultiplier, defenceMultiplier, cleanSheetProbability, overallMultiplier };
}

/** A scalar fixture multiplier for directional comparisons and simple callers. */
export function fixtureAdjustment(
  fixture: PlayerFixture,
  options: FixtureAdjustmentOptions = {},
): number {
  return calculateFixtureAdjustment(fixture, options).overallMultiplier;
}

export const fixtureMultiplier = fixtureAdjustment;
export const adjustFixture = calculateFixtureAdjustment;
