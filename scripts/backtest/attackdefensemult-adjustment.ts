/** Isolated fixture adjustment adapter for the attack/defence multiplier experiment. */
import type { CleanSheetStrength } from "@/lib/projections/cleanSheetStrength";
import {
  ATTACK_RATIO_BOUNDS,
  ATTACK_MULTIPLIER_BOUNDS,
  DEFAULT_CLEAN_SHEET_DISPERSION,
  DEFAULT_LEAGUE_MEAN_XG,
  evaluateAttackDefenseModel,
  type AttackDefenseModel,
} from "./attackdefensemult-model";
import {
  calculateFixtureAdjustment,
  type FixtureAdjustmentResult,
} from "@/lib/projections/fixtureAdjustment";
import type { PlayerFixture } from "@/types/player";
import type { TeamStrength } from "@/types/projection";

export interface AttackDefenseFixtureAdjustmentOptions {
  model: AttackDefenseModel;
  ownTeam?: TeamStrength;
  opponentTeam?: TeamStrength;
  ownCleanSheet?: CleanSheetStrength;
  opponentCleanSheet?: CleanSheetStrength;
  ownElo?: number;
  opponentElo?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Baseline delegates to the unchanged production function. Experimental arms
 * replace only attack multiplier and rated conceding mean/probability; every
 * other projection expression stays in the copied production pipeline.
 */
export function attackdefensemultFixtureAdjustment(
  fixture: PlayerFixture,
  options: AttackDefenseFixtureAdjustmentOptions,
): FixtureAdjustmentResult {
  if (options.model.family === "baseline") {
    return calculateFixtureAdjustment(fixture, {
      ownTeam: options.ownTeam,
      opponentTeam: options.opponentTeam,
      ownCleanSheet: options.ownCleanSheet,
      opponentCleanSheet: options.opponentCleanSheet,
    });
  }

  const { ownTeam, opponentTeam, ownCleanSheet, opponentCleanSheet, ownElo, opponentElo } = options;
  if (!ownTeam || !opponentTeam || !ownCleanSheet || !opponentCleanSheet
    || typeof ownElo !== "number" || !Number.isFinite(ownElo)
    || typeof opponentElo !== "number" || !Number.isFinite(opponentElo)) {
    throw new Error(`Fixture ${fixture.fixtureId ?? "unknown"}: experimental adjustment lacks rated team inputs.`);
  }

  const ownAttack = fixture.isHome ? ownTeam.attackHome : ownTeam.attackAway;
  const opponentDefence = fixture.isHome ? opponentTeam.defenceAway : opponentTeam.defenceHome;
  if (!(ownAttack > 0) || !(opponentDefence > 0)) {
    throw new Error(`Fixture ${fixture.fixtureId ?? "unknown"}: experimental attack ratio is not positive.`);
  }
  const attackRatio = clamp(ownAttack / opponentDefence, ATTACK_RATIO_BOUNDS[0], ATTACK_RATIO_BOUNDS[1]);
  const ratedConcedingRatio = opponentCleanSheet.attack / ownCleanSheet.defence;
  const result = evaluateAttackDefenseModel(options.model, {
    difficulty: fixture.exactDifficulty ?? fixture.difficulty ?? 3,
    ownElo,
    opponentElo,
    attackRatio,
    ratedConcedingRatio,
    isHome: fixture.isHome,
    leagueMeanXg: DEFAULT_LEAGUE_MEAN_XG,
  }, DEFAULT_CLEAN_SHEET_DISPERSION);
  if (result.attackMultiplier < ATTACK_MULTIPLIER_BOUNDS[0] || result.attackMultiplier > ATTACK_MULTIPLIER_BOUNDS[1]) {
    throw new Error(`Fixture ${fixture.fixtureId ?? "unknown"}: experimental attack multiplier escaped production bounds.`);
  }
  return {
    attackMultiplier: result.attackMultiplier,
    expectedGoalsAgainst: result.expectedGoalsAgainst,
    cleanSheetProbability: result.cleanSheetProbability,
  };
}
