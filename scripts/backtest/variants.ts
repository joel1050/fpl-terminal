/**
 * Section 7 as a parameterized function, so each proposed change is one flag.
 * `BASELINE` reproduces lib/projections/fixtureAdjustment.ts exactly; the
 * replication is asserted against the real module in validate.ts.
 */
import type { PlayerFixture, Position } from "@/types/player";
import type { TeamStrength } from "@/types/projection";

export interface Variant {
  /** Multiply by FPL's 1-5 difficulty rating on top of the strength ratio. */
  useDifficultyBase: boolean;
  /** Attacking venue multipliers, home and away. */
  venue: readonly [number, number];
  /** Clamp on the ownAttack / opponentDefence ratio. */
  attackRatioClamp: readonly [number, number];
  /** Clamp on the final attack and defence multipliers. */
  multiplierClamp: readonly [number, number];
  /**
   * Clean sheets from the 5x5 tier table snapped to the nearest cell, from the
   * same table read continuously, or from a continuous Poisson lambda.
   * BILINEAR interpolates inside the grid and stops at the end rungs;
   * BILINEAR_OPEN carries the edge gradient past them.
   */
  cleanSheet: "TABLE" | "BILINEAR" | "BILINEAR_OPEN" | "POISSON";
  /** League average goals conceded, the Poisson scale. */
  leagueAverageGoals: number;
  /** Save volume scales with the derived lambda, or with the opponent's attack. */
  savesEnvironment: "LAMBDA" | "OPPONENT_ATTACK";
}

/** What lib/projections/fixtureAdjustment.ts does today. validate.ts gates this. */
export const BASELINE: Variant = {
  useDifficultyBase: true,
  venue: [1.102, 0.898],
  attackRatioClamp: [0.7, 1.35],
  multiplierClamp: [0.55, 1.6],
  cleanSheet: "TABLE",
  leagueAverageGoals: 1.35,
  savesEnvironment: "LAMBDA",
};

/** Measured over all 380 fixtures of 2025/26; see sweep.ts. */
export const MEASURED_VENUE = [1.102, 0.898] as const;

/** Section 7 as it stood before this backtest, kept so the arms stay re-runnable. */
export const LEGACY: Variant = {
  ...BASELINE,
  venue: [1.03, 0.97],
  attackRatioClamp: [0.78, 1.22],
  multiplierClamp: [0.7, 1.3],
};

const difficultyMultiplier: Record<number, number> = { 1: 1.14, 2: 1.07, 3: 1, 4: 0.92, 5: 0.84 };
const consensusStrengthTiers = [0.84, 0.92, 1, 1.08, 1.16] as const;

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

/**
 * Reads the market table at an arbitrary point instead of snapping to a cell.
 * `open` decides what happens outside 0.84-1.16: false stops at the end rung,
 * true carries the edge gradient onwards, held inside [-3, 7] so one freak
 * strength cannot run the extrapolation off a cliff.
 */
function interpolatedCleanSheet(isHome: boolean, ownDefence: number, opponentAttack: number, open: boolean): number {
  const grid = cleanSheetProbabilities[isHome ? "home" : "away"];
  const position = (value: number) => (open
    ? clamp((value - consensusStrengthTiers[0]) / TIER_STEP, -3, 7)
    : clamp((value - consensusStrengthTiers[0]) / TIER_STEP, 0, 4));
  const r = position(ownDefence), c = position(opponentAttack);
  const r0 = clamp(Math.floor(r), 0, 3), c0 = clamp(Math.floor(c), 0, 3);
  const fr = r - r0, fc = c - c0;
  return clamp(
    grid[r0][c0] * (1 - fr) * (1 - fc) + grid[r0 + 1][c0] * fr * (1 - fc)
      + grid[r0][c0 + 1] * (1 - fr) * fc + grid[r0 + 1][c0 + 1] * fr * fc,
    0.02, 0.9,
  );
}

function nearestStrengthTier(value: number): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  consensusStrengthTiers.forEach((tier, index) => {
    const distance = Math.abs(value - tier);
    if (distance < nearestDistance) { nearestIndex = index; nearestDistance = distance; }
  });
  return nearestIndex;
}

export interface AdjustmentResult {
  attackMultiplier: number;
  cleanSheetProbability: number;
  expectedGoalsAgainst: number;
  savesEnvironment: number;
}

export function adjust(
  fixture: PlayerFixture,
  options: { ownTeam?: TeamStrength; opponentTeam?: TeamStrength; position?: Position },
  variant: Variant,
): AdjustmentResult {
  const difficulty = fixture.difficulty === undefined ? 3 : clamp(Math.round(fixture.difficulty), 1, 5);
  const base = variant.useDifficultyBase ? (difficultyMultiplier[difficulty] ?? 1) : 1;
  const [homeVenue, awayVenue] = variant.venue;
  const venue = fixture.isHome ? homeVenue : awayVenue;
  // Home sides concede less because the visiting attack travels: the goals-against
  // venue term is the mirror of the attacking one.
  const concedeVenue = fixture.isHome ? awayVenue : homeVenue;

  let expectedGoalsAgainst = variant.leagueAverageGoals * (fixture.isHome ? 0.9 : 1.1);
  let attackMultiplier = base * venue;
  let cleanSheetProbability: number | undefined;
  let opponentAttackRatio = 1;

  const own = options.ownTeam;
  const opponent = options.opponentTeam;
  if (own && opponent) {
    const ownAttack = fixture.isHome ? own.attackHome : own.attackAway;
    const ownDefence = fixture.isHome ? own.defenceHome : own.defenceAway;
    const opponentAttack = fixture.isHome ? opponent.attackAway : opponent.attackHome;
    const opponentDefence = fixture.isHome ? opponent.defenceAway : opponent.defenceHome;
    if (ownAttack > 0 && opponentDefence > 0) {
      attackMultiplier *= clamp(ownAttack / opponentDefence, variant.attackRatioClamp[0], variant.attackRatioClamp[1]);
    }
    if (ownDefence > 0 && opponentAttack > 0) {
      opponentAttackRatio = opponentAttack;
      if (variant.cleanSheet === "POISSON") {
        // One continuous lambda. Clean sheets, the concede deduction and save
        // volume all descend from it, so nothing is quantized away.
        expectedGoalsAgainst = variant.leagueAverageGoals * (opponentAttack / ownDefence) * concedeVenue;
        cleanSheetProbability = clamp(Math.exp(-expectedGoalsAgainst), 0.02, 0.9);
      } else {
        expectedGoalsAgainst *= Math.pow(clamp(opponentAttack / ownDefence, 0.55, 1.8), 1.5);
        cleanSheetProbability = variant.cleanSheet === "TABLE"
          ? cleanSheetProbabilities[fixture.isHome ? "home" : "away"]
            [nearestStrengthTier(ownDefence)][nearestStrengthTier(opponentAttack)]
          : interpolatedCleanSheet(fixture.isHome, ownDefence, opponentAttack, variant.cleanSheet === "BILINEAR_OPEN");
      }
    }
  } else if (variant.useDifficultyBase) {
    expectedGoalsAgainst /= Math.pow(base, 2);
  }

  attackMultiplier = clamp(attackMultiplier, variant.multiplierClamp[0], variant.multiplierClamp[1]);
  cleanSheetProbability ??= clamp(Math.exp(-expectedGoalsAgainst), 0.03, 0.65);
  expectedGoalsAgainst = -Math.log(clamp(cleanSheetProbability, 0.03, 0.9));

  const savesEnvironment = variant.savesEnvironment === "OPPONENT_ATTACK"
    ? clamp(opponentAttackRatio, 0.7, 1.4)
    : clamp(expectedGoalsAgainst / variant.leagueAverageGoals, 0.7, 1.4);

  return { attackMultiplier, cleanSheetProbability, expectedGoalsAgainst, savesEnvironment };
}
