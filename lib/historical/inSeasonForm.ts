import type { TeamStrength } from "@/types/projection";

export interface TeamMatchXG {
  xgFor: number;
  xgAgainst: number;
  opponentTeamId?: number;
  wasHome?: boolean;
}

/**
 * Decay 0.90 controls recency inside the current-season xG estimate. The
 * estimate's share then grows independently as n / (n + 12), where n is the
 * team's number of matches this season. This deliberately lets current form
 * keep gaining influence instead of capping it at the decay window's effective
 * sample size.
 */
export const DEFAULT_DECAY = 0.9;
export const DEFAULT_PRIOR_WEIGHT = 12;

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 1;
}

function adjustedMatchXG(
  match: TeamMatchXG,
  prior: Record<number, { attack: number; defence: number }>,
): { xgFor: number; xgAgainst: number } {
  if (match.opponentTeamId === undefined || !prior[match.opponentTeamId]) {
    return { xgFor: match.xgFor, xgAgainst: match.xgAgainst };
  }
  const oppPrior = prior[match.opponentTeamId];
  const oppDef = Math.max(oppPrior.defence, 0.2);
  const oppAtt = Math.max(oppPrior.attack, 0.2);
  return {
    xgFor: match.xgFor * oppDef,
    xgAgainst: match.xgAgainst / oppAtt,
  };
}

/**
 * Blends each team's prior attack/defence ratio with a recency-weighted
 * average of its own observed xG for/against. Matches are schedule-adjusted
 * by the opponent's prior strength when known, so soft/hard schedules do not
 * distort the team's form estimate.
 *
 * Weight decays geometrically per match (most recent match played = weight 1,
 * one match before that = decay, two before = decay^2, ...), so the blend
 * tracks a team's current process without a hard "last N matches" cliff.
 * `priorWeight` is the preseason prior's influence in "matches worth" of
 * evidence, while every current-season match increases the observed side's share.
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
    for (const match of matches) {
      allXg.push(adjustedMatchXG(match, prior).xgFor);
    }
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
      const adj = adjustedMatchXG(match, prior);
      weightedFor += weight * adj.xgFor;
      weightedAgainst += weight * adj.xgAgainst;
    }
    const weightedXgFor = weightedFor / weightSum;
    const weightedXgAgainst = weightedAgainst / weightSum;
    const observedAttack = weightedXgFor / leagueAverageXg;
    // Inverted: fewer expected goals conceded should raise the defence
    // ratio, matching the "higher = stronger" convention used everywhere
    // else in this app.
    const observedDefence = leagueAverageXg / Math.max(weightedXgAgainst, 0.15);
    const currentShare = n / (n + priorWeight);
    const blendedAttack = teamPrior.attack * (1 - currentShare) + observedAttack * currentShare;
    const blendedDefence = teamPrior.defence * (1 - currentShare) + observedDefence * currentShare;
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
