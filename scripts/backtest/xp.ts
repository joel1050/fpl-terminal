/**
 * Section 8 with the section 7 adjustment injected, so an arm can change the
 * fixture model without touching the scoring rules. Every scoring constant and
 * every distribution helper is imported from the real modules; only the plumbing
 * lives here. validate.ts asserts this reproduces projectPlayer() on real rows.
 */
import type { Player, PlayerFixture, Position } from "@/types/player";
import type { PlayerMatchRate, ProjectionComponents, TeamStrength } from "@/types/projection";
import { expectedFloorDivision, thresholdProbability } from "@/lib/projections/distributions";
import { regressPer90 } from "@/lib/projections/regression";
import {
  blendPlayerRateByMinutes,
  PLAYER_FORM_DECAY,
  PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
  PLAYER_FORM_PRIOR_WEIGHT_RARE_EVENTS,
  PLAYER_FORM_WINSOR_RATIO,
} from "@/lib/projections/playerForm";
import { priceTieredAttackingPrior } from "@/lib/projections/projectPlayer";
import { adjust, type Variant } from "./variants";

const GOAL_POINTS: Record<Position, number> = { GK: 10, DEF: 6, MID: 5, FWD: 4 };
const PRIOR_DEFENSIVE_CONTRIBUTION: Record<Position, number> = { GK: 0, DEF: 7.7, MID: 8.6, FWD: 4.7 };
const PRIOR_SAVES: Record<Position, number> = { GK: 2.8, DEF: 0, MID: 0, FWD: 0 };
const PRIOR_BONUS: Record<Position, number> = { GK: 0.22, DEF: 0.22, MID: 0.32, FWD: 0.59 };
const RATE_CEILING = { goalInvolvement: 3, saves: 10, defensiveContribution: 30, bonus: 3, yellowCards: 0.8, redCards: 0.1 } as const;
const CLEAN_SHEET_POINTS: Record<Position, number> = { GK: 4, DEF: 4, MID: 1, FWD: 0 };
const DEFENSIVE_CONTRIBUTION_THRESHOLD: Record<Position, number> = { GK: 0, DEF: 10, MID: 12, FWD: 12 };
const DEFENSIVE_CONTRIBUTION_POINTS = 2;
const SAVES_PER_POINT = 3;
const GOAL_CONVERSION: Record<Position, number> = { GK: 1, DEF: 0.7, MID: 0.981, FWD: 0.988 };
const ASSIST_CONVERSION: Record<Position, number> = { GK: 1, DEF: 1.272, MID: 1.207, FWD: 2.114 };
const YELLOW_CARD_POINTS = 1;
const RED_CARD_POINTS = 3;
const PRIOR_YELLOW_CARDS: Record<Position, number> = { GK: 0.072, DEF: 0.182, MID: 0.188, FWD: 0.149 };
const PRIOR_RED_CARDS: Record<Position, number> = { GK: 0.001, DEF: 0.008, MID: 0.005, FWD: 0.002 };
const GOALS_CONCEDED_PER_DEDUCTION = 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type RateField = "expectedGoals" | "expectedAssists" | "goals" | "assists" | "bonus" | "saves" | "defensiveContribution" | "yellowCards" | "redCards";

function historicalRate(player: Player, field: RateField) {
  const history = player.historical;
  if (!history || history.minutes <= 0) return undefined;
  const value = (history as unknown as Record<string, number | undefined>)[field];
  if (value === undefined) return undefined;
  return { rate: (value / history.minutes) * 90, minutes: history.minutes };
}

function currentRate(player: Player, field: RateField) {
  const value = (player.current as unknown as Partial<Record<RateField, number>>)[field];
  if (value === undefined || player.current.minutes <= 0) return undefined;
  return { rate: (value / player.current.minutes) * 90, minutes: player.current.minutes };
}

/** Mirrors currentSeasonWeight in lib/projections/projectPlayer.ts. */
function currentSeasonWeight(
  form: readonly PlayerMatchRate[] | undefined, currentGameweek: number,
  priorWeightMatches: number, currentWeightDivisor: number, currentWeightCap: number,
): number {
  if (!form || form.length === 0) return clamp(currentGameweek / currentWeightDivisor, 0, currentWeightCap);
  return form.length / (form.length + priorWeightMatches);
}

function regressedPlayerRate(
  player: Player, primary: RateField, fallback: "goals" | "assists" | undefined,
  prior: number, currentGameweek: number, ceiling: number = RATE_CEILING.goalInvolvement,
  currentWeightDivisor = 10, currentWeightCap = 0.6,
  form?: readonly PlayerMatchRate[],
  priorWeightMatches: number = PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
): number {
  const historical = historicalRate(player, primary) ?? (fallback ? historicalRate(player, fallback) : undefined);
  const current = currentRate(player, primary) ?? (fallback ? currentRate(player, fallback) : undefined);
  let rate = historical?.rate ?? prior;
  let sample = historical?.minutes ?? 0;
  if (current) {
    const currentWeight = currentSeasonWeight(
      form, currentGameweek, priorWeightMatches, currentWeightDivisor, currentWeightCap,
    );
    // Production caps the current-season rate at a multiple of the anchor
    // before blending. A handful of extreme divergences otherwise dominate a
    // sum of squares and revert hardest - the largest single gain the form
    // sweep measured anywhere.
    const baselineAnchor = rate > 0 ? rate : prior;
    const cap = baselineAnchor > 0 && PLAYER_FORM_WINSOR_RATIO > 0
      ? baselineAnchor * PLAYER_FORM_WINSOR_RATIO
      : undefined;
    const winsorizedCurrentRate = cap !== undefined ? Math.min(current.rate, cap) : current.rate;
    rate = rate * (1 - currentWeight) + winsorizedCurrentRate * currentWeight;
    sample += current.minutes * currentWeight;
  }
  return clamp(regressPer90(rate, sample, prior, 900), 0, ceiling);
}

function regressedFormRate(
  player: Player, primary: "expectedGoals" | "expectedAssists", fallback: "goals" | "assists",
  prior: number, form: readonly PlayerMatchRate[] | undefined, currentGameweek: number,
  ceiling: number = RATE_CEILING.goalInvolvement,
  shrinkMinutes = 0, poolRate?: number,
  formDecay: number = PLAYER_FORM_DECAY,
  formPriorWeight: number = PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
  currentWeightDivisor = 10, currentWeightCap = 0.6,
  ownTeam?: TeamStrength, strengths?: Record<number, TeamStrength>,
): number {
  const historical = historicalRate(player, primary) ?? historicalRate(player, fallback);
  // A player's own prior-period rate is used raw today. It is an estimate, so
  // shrinking it toward the pool by its own sample size removes the survivorship
  // tilt without touching a player who has a genuinely large sample.
  // Production regresses the anchor toward the position/price prior by its own
  // sample size before anything else (projectPlayer's `historicalAnchor`), so
  // that is the default here too. The arm knobs stay: an override shrinks
  // toward `poolRate` over `shrinkMinutes` instead.
  const anchorTarget = poolRate ?? prior;
  const anchorMinutes = shrinkMinutes > 0 ? shrinkMinutes : 900;
  const basePrior = historical
    ? regressPer90(historical.rate, historical.minutes, anchorTarget, anchorMinutes)
    : prior;
  if (form && form.length > 0) {
    const field = primary === "expectedGoals" ? "xg" : "xa";
    // Production caps a defender's per-match xG at 0.35 per 90 before blending
    // (projectPlayer's DEF winsorisation), so a penalty or a set-piece header
    // does not carry a centre-back's rate for the rest of the season.
    const samples = form.map((m) => {
      let value = m[field];
      if (player.position === "DEF" && primary === "expectedGoals" && m.minutes > 0) {
        const ratePer90 = (value / m.minutes) * 90;
        if (ratePer90 > 0.35) value = (0.35 / 90) * m.minutes;
      }
      return { value, minutes: m.minutes };
    });
    return clamp(blendPlayerRateByMinutes(samples, basePrior, formDecay, formPriorWeight), 0, ceiling);
  }
  // No form to blend. Production normalizes each *input* rate by the team's
  // attack and only then regresses the result toward the prior. Dividing the
  // regressed output instead - as this did - also divides the prior term, which
  // is not on the team's scale, so the two disagreed by the prior's share of
  // the blend on every row without form.
  const current = currentRate(player, primary) ?? currentRate(player, fallback);
  const normalizedOwnTeam = ownTeam && strengths?.[ownTeam.teamId] ? ownTeam : undefined;
  const ownAttack = normalizedOwnTeam
    ? (normalizedOwnTeam.attackHome + normalizedOwnTeam.attackAway) / 2
    : 1;
  let rate = historical && ownAttack > 0 ? historical.rate / ownAttack : prior;
  let sample = historical?.minutes ?? 0;
  if (current) {
    const currentWeight = clamp(currentGameweek / currentWeightDivisor, 0, currentWeightCap);
    const normalizedCurrent = ownAttack > 0 ? current.rate / ownAttack : current.rate;
    rate = rate * (1 - currentWeight) + normalizedCurrent * currentWeight;
    sample += current.minutes * currentWeight;
  }
  return clamp(regressPer90(rate, sample, prior, 900), 0, ceiling);
}

/**
 * Production reads the price-tiered prior for every player, whether or not a
 * historical rate exists (`projectPlayer`'s `attackingPrior`). This used to
 * swap in a flat position prior once a player had any history, which is 2.8x
 * the tiered value for a mid-priced midfielder. It only ever showed on a corpus
 * carrying real previous-season xG, so the gate on the legacy corpus never saw
 * it - which is exactly why the gate has to be run on a prepared season too.
 */
function attackingPrior(player: Player, primary: "expectedGoals" | "expectedAssists") {
  const tiered = priceTieredAttackingPrior(player.position, player.priceTenths);
  return primary === "expectedGoals" ? tiered.xg : tiered.xa;
}

export interface RateOverrides {
  priorXg?: Record<Position, number>;
  priorXa?: Record<Position, number>;
  /** Shrink the player's own anchor toward the pool rate, in minutes of prior weight. */
  anchorShrinkMinutes?: number;
  /** Recency decay per match back in blendPlayerRate. Defaults to the shipped 0.95. */
  formDecay?: number;
  /** The anchor's weight in "matches worth". Defaults to the shipped 10. */
  formPriorWeight?: number;
  /** currentWeight = clamp(gameweek / divisor, 0, cap). Defaults to the shipped 10 / 0.6. */
  currentWeightDivisor?: number;
  currentWeightCap?: number;
  /** The anchor's weight for cards. Defaults to the shipped 40. */
  rareEventPriorWeight?: number;
  /** The anchor's weight for saves, in matches. Defaults to the shipped 6. */
  savesPriorWeight?: number;
}

export function playerRates(
  player: Player,
  form: readonly PlayerMatchRate[] | undefined,
  currentGameweek: number,
  overrides: RateOverrides = {},
  strengths?: Record<number, TeamStrength>,
) {
  const ownTeam = strengths ? strengths[player.teamId] : undefined;
  const priorXg = overrides.priorXg?.[player.position];
  const priorXa = overrides.priorXa?.[player.position];
  const shrink = overrides.anchorShrinkMinutes ?? 0;
  const fd = overrides.formDecay ?? PLAYER_FORM_DECAY;
  const fw = overrides.formPriorWeight ?? PLAYER_FORM_PRIOR_WEIGHT_MATCHES;
  const cd = overrides.currentWeightDivisor ?? 10;
  const cc = overrides.currentWeightCap ?? 0.6;
  const rw = overrides.rareEventPriorWeight ?? PLAYER_FORM_PRIOR_WEIGHT_RARE_EVENTS;
  return {
    xg: regressedFormRate(player, "expectedGoals", "goals", priorXg ?? attackingPrior(player, "expectedGoals"), form, currentGameweek, RATE_CEILING.goalInvolvement, shrink, priorXg, fd, fw, cd, cc, ownTeam, strengths),
    xa: regressedFormRate(player, "expectedAssists", "assists", priorXa ?? attackingPrior(player, "expectedAssists"), form, currentGameweek, RATE_CEILING.goalInvolvement, shrink, priorXa, fd, fw, cd, cc, ownTeam, strengths),
    // The saves blend weight is its own arm: production gives the current
    // season n/(n+6), the constant `form-weight.ts` selected on overall xP,
    // which is dominated by outfield attacking returns. Defaulting to that
    // constant keeps validate.ts's parity gate intact.
    saves: regressedPlayerRate(player, "saves", undefined, PRIOR_SAVES[player.position], currentGameweek, RATE_CEILING.saves, cd, cc, form, overrides.savesPriorWeight ?? PLAYER_FORM_PRIOR_WEIGHT_MATCHES),
    defensiveContribution: regressedPlayerRate(player, "defensiveContribution", undefined, PRIOR_DEFENSIVE_CONTRIBUTION[player.position], currentGameweek, RATE_CEILING.defensiveContribution, cd, cc, form),
    bonus: regressedPlayerRate(player, "bonus", undefined, PRIOR_BONUS[player.position], currentGameweek, RATE_CEILING.bonus, cd, cc, form),
    yellowCards: regressedPlayerRate(player, "yellowCards", undefined, PRIOR_YELLOW_CARDS[player.position], currentGameweek, RATE_CEILING.yellowCards, cd, cc, form, rw),
    redCards: regressedPlayerRate(player, "redCards", undefined, PRIOR_RED_CARDS[player.position], currentGameweek, RATE_CEILING.redCards, cd, cc, form, rw),
  };
}

export type Rates = ReturnType<typeof playerRates>;

/** Expected points for one fixture at a known minutes figure. */
export interface DefenceExperiments {
  /** Negative-binomial dispersion for the defensive-contribution threshold. */
  dispersion?: number;
  /** Whether defensive contributions rise against a stronger attack. */
  defConEnvironment?: "FLAT" | "HALF_PRESSURE" | "PRESSURE";
  /** Which side of the fixture a player's bonus follows. */
  bonusEnvironment?: "FLAT" | "ATTACK" | "DEFENCE" | "BOTH";
}

export function expectedPoints(
  player: Player,
  fixture: PlayerFixture,
  minutes: number,
  rates: Rates,
  strengths: Record<number, TeamStrength>,
  variant: Variant,
  /** Experiment: let bonus follow the fixture, as BPS actually does. */
  bonusFollowsFixture = true,
  /** Experiment: deduct for yellow and red cards. */
  cards = true,
  /** Experiment: scale xA to the rate FPL actually awards assists. */
  assistConversion: Record<Position, number> = ASSIST_CONVERSION,
  /** Experiment: scale xG to the rate goals are actually scored. */
  goalConversion: Record<Position, number> = GOAL_CONVERSION,
  /** Experiments aimed at the two defender terms that carry no fixture signal. */
  defence: DefenceExperiments = {},
): ProjectionComponents {
  const {
    // distributions.ts documents 8 as an assumption, not a fitted value: the
    // ingest keeps season totals only, so there is nothing to fit it against.
    // A higher number is closer to a Poisson, a lower one more spread out.
    dispersion = 8,
    // A defender making clearances and blocks does more of it against a strong
    // attack, but the term is currently identical in every fixture.
    defConEnvironment = "FLAT",
    // Where a defender's bonus comes from. Shipped behaviour scales it by the
    // attacking multiplier, but a defender's BPS is mostly clean sheets and
    // defensive actions.
    bonusEnvironment = bonusFollowsFixture ? "ATTACK" : "FLAT",
  } = defence;
  const a = adjust(fixture, {
    position: player.position,
    ownTeam: strengths[player.teamId],
    opponentTeam: strengths[fixture.opponentTeamId],
  }, variant);

  const c: ProjectionComponents = {
    appearance: 0, goals: 0, assists: 0, cleanSheets: 0, goalsConceded: 0,
    saves: 0, defensiveContribution: 0, bonus: 0, cards: 0, penalties: 0, total: 0,
  };
  const minutesShare = clamp(minutes, 0, 90) / 90;
  if (minutesShare <= 0) return c;
  const playedSixty = minutes >= 60;

  c.appearance += playedSixty ? 2 : 1;
  // Mirrors production: goalkeeper goals are killed outright (0 goals in the
  // walk-forward corpus), assists are kept.
  if (player.position !== "GK") {
    c.goals += rates.xg * goalConversion[player.position] * minutesShare * a.attackMultiplier * GOAL_POINTS[player.position];
  }
  c.assists += rates.xa * assistConversion[player.position] * minutesShare * a.attackMultiplier * 3;
  if (playedSixty) c.cleanSheets += a.cleanSheetProbability * CLEAN_SHEET_POINTS[player.position];
  if (player.position === "GK" || player.position === "DEF") {
    c.goalsConceded -= expectedFloorDivision(a.expectedGoalsAgainst * minutesShare, GOALS_CONCEDED_PER_DEDUCTION);
  }
  if (player.position === "GK") {
    c.saves += expectedFloorDivision(rates.saves * minutesShare * a.savesEnvironment, SAVES_PER_POINT);
  }
  // How much harder than average this fixture is defensively. 0.256 is the
  // league clean-sheet rate over 2025/26, so an average fixture scores 1.
  const defencePressure = clamp(0.256 / clamp(a.cleanSheetProbability, 0.02, 0.9), 0.55, 1.6);
  const defenceEase = clamp(clamp(a.cleanSheetProbability, 0.02, 0.9) / 0.256, 0.55, 1.6);
  const threshold = DEFENSIVE_CONTRIBUTION_THRESHOLD[player.position];
  if (threshold > 0) {
    const environment = defConEnvironment === "PRESSURE" ? defencePressure
      : defConEnvironment === "HALF_PRESSURE" ? 1 + (defencePressure - 1) / 2
      : 1;
    c.defensiveContribution += DEFENSIVE_CONTRIBUTION_POINTS
      * thresholdProbability(rates.defensiveContribution * minutesShare * environment, threshold, dispersion);
  }
  const defensive = player.position === "GK" || player.position === "DEF";
  const bonusMultiplier = bonusEnvironment === "FLAT" ? 1
    : bonusEnvironment === "ATTACK" ? a.attackMultiplier
    // A defender's bonus follows the clean sheet; everyone else keeps the
    // attacking multiplier, which is where their BPS comes from.
    : defensive && bonusEnvironment === "DEFENCE" ? defenceEase
    : defensive && bonusEnvironment === "BOTH" ? Math.sqrt(a.attackMultiplier * defenceEase)
    : a.attackMultiplier;
  c.bonus += rates.bonus * minutesShare * bonusMultiplier;
  if (cards) {
    c.cards -= YELLOW_CARD_POINTS * (1 - Math.exp(-rates.yellowCards * minutesShare))
      + RED_CARD_POINTS * (1 - Math.exp(-rates.redCards * minutesShare));
  }
  c.total = Object.entries(c).filter(([k]) => k !== "total").reduce((s, [, v]) => s + v, 0);
  return c;
}
