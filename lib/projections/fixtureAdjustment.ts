import type { PlayerFixture } from "@/types/player";
import type { TeamStrength } from "@/types/projection";

export interface FixtureAdjustmentOptions {
  ownTeam?: TeamStrength;
  opponentTeam?: TeamStrength;
}

export interface FixtureAdjustmentResult {
  attackMultiplier: number;
  cleanSheetProbability: number;
  /** Goals against over a full match, always consistent with the clean-sheet probability. */
  expectedGoalsAgainst: number;
}

/** Goals against for an average side, used to scale save volume to the fixture. */
export const LEAGUE_AVERAGE_GOALS_AGAINST = 1.35;

/**
 * Attacking home advantage, measured over all 380 fixtures of 2025/26 rather
 * than assumed: home sides averaged 1.551 xG and away sides 1.264, so against
 * the 1.408 league mean the multipliers are 1.102 and 0.898. Actual goals
 * agree (1.453 against 1.203). The previous 1.03/0.97 was about a third of
 * the real spread, and disagreed with the 0.9/1.1 already used on the
 * goals-against side of the same fixture. Re-derive with
 * `npx tsx scripts/backtest/sweep.ts`.
 */
export const HOME_ATTACK_MULTIPLIER = 1.102;
export const AWAY_ATTACK_MULTIPLIER = 0.898;

/**
 * Clamp on ownAttack / opponentDefence. Walk-forward strengths for 2025/26 ran
 * 0.47-1.62, so the old [0.78, 1.22] truncated a real signal on 24.5% of
 * team-fixtures. Backtested: widening to [0.70, 1.35] lowered expected-points
 * RMSE by 0.0008 with the paired confidence interval excluding zero, and won
 * 24 of 33 gameweeks. The gain is flat from here all the way to unclamped, so
 * this is the narrowest window that captures all of it. A window is still
 * wanted: blendInSeasonForm floors a defence ratio at 0.05, which would let an
 * unclamped ratio reach about 25.
 */
const ATTACK_RATIO_CLAMP = [0.7, 1.35] as const;

/**
 * Backstop on the attack multiplier, deliberately wider than the range the
 * ratio clamp already allows, so ATTACK_RATIO_CLAMP is the operative limit and
 * this only catches a genuinely absurd input.
 *
 * It used to be [0.7, 1.3], which bound on 14% of forward-fixtures and did real
 * damage at the top: a strong attack against a weak defence computes past 1.3
 * in a third of its fixtures, and every one of them collapsed onto the same
 * number. Over 2025/26 that flattened Erling Haaland's 30 fixtures onto a
 * 0.89-1.30 range when the inputs said 0.89-1.57, and 11 of the 30 sat pinned
 * on the ceiling - so the model could not tell his best fixture from his median
 * one. Forwards' modelled swing between their easiest and hardest fixtures came
 * to 0.73 points against an observed 1.07.
 *
 * This is a calibration fix, not a measured accuracy win: widening the clamp
 * left match-level RMSE unchanged (+0.0006, confidence interval spanning zero)
 * and top-30 selection flat. Single-match points are too noisy to reward
 * getting the slope right, but a ceiling that erases a third of a player's
 * fixture variation misleads anyone planning a run of fixtures.
 */
const MULTIPLIER_CLAMP = [0.55, 1.6] as const;

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

const TIER_STEP = 0.08;

function cleanPosition(value: number): number {
  const pos = (value - consensusStrengthTiers[0]) / TIER_STEP;
  const snapped = Math.abs(pos - Math.round(pos)) < 1e-7 ? Math.round(pos) : pos;
  return clamp(snapped, 0, 4);
}

/**
 * Bilinear interpolation over the market-calibrated clean-sheet probabilities.
 * Instead of snapping continuous defence and attack ratings onto discrete rungs,
 * this computes a smooth 2D surface across the 5 tiers ([0.84, 0.92, 1.00, 1.08, 1.16]),
 * so that clean sheet probabilities update continuously as team form shifts.
 */
export function interpolatedCleanSheet(
  isHome: boolean,
  ownDefence: number,
  opponentAttack: number,
): number {
  const grid = cleanSheetProbabilities[isHome ? "home" : "away"];
  const r = cleanPosition(ownDefence);
  const c = cleanPosition(opponentAttack);
  const r0 = clamp(Math.floor(r), 0, 3);
  const c0 = clamp(Math.floor(c), 0, 3);
  const fr = r - r0;
  const fc = c - c0;
  const val = grid[r0][c0] * (1 - fr) * (1 - fc)
    + grid[r0 + 1][c0] * fr * (1 - fc)
    + grid[r0][c0 + 1] * (1 - fr) * fc
    + grid[r0 + 1][c0 + 1] * fr * fc;
  return Math.round(clamp(val, 0.02, 0.9) * 10000) / 10000;
}

/** Returns transparent attacking and clean-sheet adjustments for one fixture. */
export function calculateFixtureAdjustment(
  fixture: PlayerFixture,
  options: FixtureAdjustmentOptions = {},
): FixtureAdjustmentResult {
  const difficulty = fixture.difficulty === undefined
    ? 3
    : clamp(Math.round(fixture.difficulty), 1, 5);
  const base = difficultyMultiplier[difficulty] ?? 1;
  const venue = fixture.isHome ? HOME_ATTACK_MULTIPLIER : AWAY_ATTACK_MULTIPLIER;
  // Only live in the no-strengths fallback below: once a table lookup happens,
  // this is overwritten from the clean-sheet probability. Its 0.9/1.1 spread
  // matches the measured home advantage (1.227) closely enough to leave alone.
  let expectedGoalsAgainst = LEAGUE_AVERAGE_GOALS_AGAINST * (fixture.isHome ? 0.9 : 1.1);
  let attackMultiplier = base * venue;
  let cleanSheetProbability: number | undefined;

  const own = options.ownTeam;
  const opponent = options.opponentTeam;
  if (own && opponent) {
    const ownAttack = fixture.isHome ? own.attackHome : own.attackAway;
    const ownDefence = fixture.isHome ? own.defenceHome : own.defenceAway;
    const opponentAttack = fixture.isHome ? opponent.attackAway : opponent.attackHome;
    const opponentDefence = fixture.isHome ? opponent.defenceAway : opponent.defenceHome;
    if (ownAttack > 0 && opponentDefence > 0) {
      attackMultiplier *= clamp(ownAttack / opponentDefence, ATTACK_RATIO_CLAMP[0], ATTACK_RATIO_CLAMP[1]);
    }
    if (ownDefence > 0 && opponentAttack > 0) {
      cleanSheetProbability = interpolatedCleanSheet(fixture.isHome, ownDefence, opponentAttack);
    }
  } else {
    expectedGoalsAgainst /= Math.pow(base, 2);
  }
  attackMultiplier = clamp(attackMultiplier, MULTIPLIER_CLAMP[0], MULTIPLIER_CLAMP[1]);
  cleanSheetProbability ??= clamp(Math.exp(-expectedGoalsAgainst), 0.03, 0.65);
  // One goals-against number per fixture. Inverting the clean-sheet probability
  // keeps the lookup table and the goals-conceded deduction from disagreeing:
  // both now come from the same Poisson.
  expectedGoalsAgainst = -Math.log(clamp(cleanSheetProbability, 0.03, 0.9));
  return {
    attackMultiplier,
    cleanSheetProbability,
    expectedGoalsAgainst,
  };
}
