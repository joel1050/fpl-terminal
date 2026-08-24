import type { TeamStrength } from "@/types/projection";

export interface TeamMatchXG {
  xgFor: number;
  xgAgainst: number;
}

/**
 * decay=0.90 and priorWeight=10 are backtested, not guessed: walking forward
 * through the 2023/24 and 2024-25 seasons, this pair maximized clean-sheet
 * AUC and goals-scored correlation against actual results, using team xG
 * (not goals or win/draw/loss - both scored worse than never updating the
 * preseason prior at all) as the in-season observed signal.
 *
 * priorWeight was re-derived against a prior quantized into 5 tiers - the
 * same granularity as data/manual/team-strengths.json - rather than FPL's
 * continuous preseason rating. A coarser prior deserves less trust relative
 * to observed form, so this app's optimal weight (10) is lower than what a
 * continuous-rating backtest found (16): both beat a never-updated prior in
 * both seasons checked individually, and this app's real prior is the
 * coarse one. Both parameters sit in a flat plateau (decay 0.85-0.95, W
 * 7-13 all land within ~0.1% AUC), so this is a defensible default, not a
 * razor's-edge optimum.
 */
export const DEFAULT_DECAY = 0.9;
export const DEFAULT_PRIOR_WEIGHT = 10;

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 1;
}

/**
 * Blends each team's prior attack/defence ratio with a recency-weighted
 * average of its own observed xG for/against. Weight decays geometrically
 * per match (most recent match played = weight 1, one match before that =
 * decay, two before = decay^2, ...), so the blend tracks a team's current
 * process without a hard "last N matches" cliff. `priorWeight` is the
 * preseason prior's influence in "matches worth" of evidence; the observed
 * side's influence grows toward its own ceiling (1 / (1 - decay)) as more
 * matches are played, so the prior never fully disappears but stops
 * dominating once a real sample exists.
 */
export function blendInSeasonForm(
  prior: Record<number, { attack: number; defence: number }>,
  history: Record<number, readonly TeamMatchXG[]>,
  decay: number = DEFAULT_DECAY,
  priorWeight: number = DEFAULT_PRIOR_WEIGHT,
): Record<number, { attack: number; defence: number }> {
  // Every match contributes one xgFor entry for one side and an identical
  // xgAgainst entry for the other, so the pooled average of xgFor equals the
  // pooled average of xgAgainst across all recorded matches - one league
  // average covers both directions.
  const allXg: number[] = [];
  for (const matches of Object.values(history)) {
    for (const match of matches) allXg.push(match.xgFor);
  }
  const leagueAverageXg = Math.max(mean(allXg), 0.15);

  const blended: Record<number, { attack: number; defence: number }> = {};
  for (const [key, teamPrior] of Object.entries(prior)) {
    const teamId = Number(key);
    const matches = history[teamId] ?? [];
    const n = matches.length;
    if (n === 0) {
      blended[teamId] = teamPrior;
      continue;
    }
    let weightSum = 0;
    let weightedFor = 0;
    let weightedAgainst = 0;
    for (let i = 0; i < n; i += 1) {
      const match = matches[n - 1 - i]; // i=0 is the most recent match played
      const weight = decay ** i;
      weightSum += weight;
      weightedFor += weight * match.xgFor;
      weightedAgainst += weight * match.xgAgainst;
    }
    const weightedXgFor = weightedFor / weightSum;
    const weightedXgAgainst = weightedAgainst / weightSum;
    const observedAttack = weightedXgFor / leagueAverageXg;
    // Inverted: fewer expected goals conceded should raise the defence
    // ratio, matching the "higher = stronger" convention used everywhere
    // else in this app.
    const observedDefence = leagueAverageXg / Math.max(weightedXgAgainst, 0.15);
    const effectiveMatches = weightSum;
    const blendedAttack = (teamPrior.attack * priorWeight + observedAttack * effectiveMatches)
      / (priorWeight + effectiveMatches);
    const blendedDefence = (teamPrior.defence * priorWeight + observedDefence * effectiveMatches)
      / (priorWeight + effectiveMatches);
    blended[teamId] = { attack: Math.max(blendedAttack, 0.05), defence: Math.max(blendedDefence, 0.05) };
  }
  return blended;
}

/**
 * Applies the in-season blend on top of the existing preseason/history prior
 * (§3's deriveTeamStrengths output). Attack and defence stay venue-agnostic,
 * matching the prior: a backtest confirmed splitting the observed signal by
 * home/away halves the sample per venue and made predictions less reliable,
 * not more, over the two seasons tested.
 */
export function applyInSeasonForm(
  priorStrengths: Record<number, TeamStrength>,
  history: Record<number, readonly TeamMatchXG[]>,
  decay: number = DEFAULT_DECAY,
  priorWeight: number = DEFAULT_PRIOR_WEIGHT,
): Record<number, TeamStrength> {
  const prior: Record<number, { attack: number; defence: number }> = {};
  for (const [key, strength] of Object.entries(priorStrengths)) {
    prior[Number(key)] = {
      attack: (strength.attackHome + strength.attackAway) / 2,
      defence: (strength.defenceHome + strength.defenceAway) / 2,
    };
  }
  const blended = blendInSeasonForm(prior, history, decay, priorWeight);

  const result: Record<number, TeamStrength> = {};
  for (const key of Object.keys(priorStrengths)) {
    const teamId = Number(key);
    const b = blended[teamId] ?? prior[teamId];
    result[teamId] = {
      teamId,
      attackHome: b.attack,
      attackAway: b.attack,
      defenceHome: b.defence,
      defenceAway: b.defence,
      overall: (b.attack + b.defence) / 2,
    };
  }
  return result;
}
