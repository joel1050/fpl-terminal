import type {
  FixtureProjection,
  Player,
  PlayerFixture,
  PlayerProjection,
  ProjectionFactor,
  ProjectionConfidence,
  Position,
} from "@/types/player";
import type { PlayerMatchRate, ProjectionComponents, ProjectionOptions, TeamStrength } from "@/types/projection";
import { calculateFixtureAdjustment, LEAGUE_AVERAGE_GOALS_AGAINST } from "./fixtureAdjustment";
import { expectedFloorDivision, thresholdProbability } from "./distributions";
import { estimateExpectedMinutes, type ExpectedMinutesOptions } from "./expectedMinutes";
import { projectionConfidence, calculateRiskScore, valuePerMillion } from "./metrics";
import { regressPer90 } from "./regression";
import { blendPlayerRate, PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES } from "./playerForm";

export type ProjectPlayerOptions = Partial<ProjectionOptions> & {
  expectedMinutesOptions?: ExpectedMinutesOptions;
  fixtureHorizon?: number;
};

const PRIOR_XG: Record<Position, number> = { GK: 0.01, DEF: 0.08, MID: 0.25, FWD: 0.45 };
const PRIOR_XA: Record<Position, number> = { GK: 0.02, DEF: 0.08, MID: 0.2, FWD: 0.15 };
const UNKNOWN_DEFENDER_XG_PRIOR = 0.02;
const UNKNOWN_DEFENDER_XA_PRIOR = 0.02;
const GOAL_POINTS: Record<Position, number> = { GK: 10, DEF: 6, MID: 5, FWD: 4 };
// Pool averages per 90 from 2025/26, used when a player has no usable sample.
const PRIOR_DEFENSIVE_CONTRIBUTION: Record<Position, number> = { GK: 0, DEF: 7.7, MID: 8.6, FWD: 4.7 };
const PRIOR_SAVES: Record<Position, number> = { GK: 2.8, DEF: 0, MID: 0, FWD: 0 };
const PRIOR_BONUS: Record<Position, number> = { GK: 0.22, DEF: 0.22, MID: 0.32, FWD: 0.59 };
// Ceilings on a per-90 rate, one per statistic. A shared ceiling of 3 silently
// capped defensive contributions and goalkeeper saves, which run far higher.
const RATE_CEILING = { goalInvolvement: 3, saves: 10, defensiveContribution: 30, bonus: 3, yellowCards: 0.8, redCards: 0.1 } as const;
const CLEAN_SHEET_POINTS: Record<Position, number> = { GK: 4, DEF: 4, MID: 1, FWD: 0 };
const DEFENSIVE_CONTRIBUTION_THRESHOLD: Record<Position, number> = { GK: 0, DEF: 10, MID: 12, FWD: 12 };
const DEFENSIVE_CONTRIBUTION_POINTS = 2;
const SAVES_PER_POINT = 3;
/**
 * xG and xA are not goals and assists, and the gap differs by position. Both
 * factors are the product of two measured things, cross-validated over 2025/26
 * (fitted on three quarters of the gameweeks, scored on the fourth, four times):
 *
 *   - whether the model states the expected count correctly, and
 *   - whether that count converts at the rate FPL pays out.
 *
 * Which effect dominates changes by position. A defender's xG rate is accurate
 * (1.022) but converts at only 0.698 - their chances are set-piece headers.
 * A midfielder converts fine (0.981) but the model overstates their xG by 20%
 * (0.835). On the assist side FPL is far more generous than xA: it pays 1.21
 * assists per xA for a midfielder and 2.11 for a forward, because it awards the
 * final pass whatever happens to the shot.
 *
 * These are deliberately the bias-neutral values, not the values that minimise
 * squared error. The least-squares slopes score better still (RMSE -0.0129
 * against -0.0074) but are shrinkage estimators: they drive bias to -0.146 and
 * systematically under-project the best players, who are the ones worth buying.
 * Using the raw season ratios instead is worse than doing nothing, because they
 * correct the conversion while ignoring the rate error.
 *
 * Re-derive with `npx tsx scripts/backtest/fit-conversions.ts`.
 */
const GOAL_CONVERSION: Record<Position, number> = { GK: 1, DEF: 0.7, MID: 0.981, FWD: 0.988 };
const ASSIST_CONVERSION: Record<Position, number> = { GK: 1, DEF: 1.272, MID: 1.207, FWD: 2.114 };
const YELLOW_CARD_POINTS = 1;
const RED_CARD_POINTS = 3;
/**
 * Card rates per 90, measured across every 2025/26 appearance rather than
 * assumed. Cards are differential, not a flat levy: a defender loses roughly
 * twice what a forward does (-0.165 against -0.088 points per appearance,
 * league-wide -0.135), so leaving them out flattered defenders and holding
 * midfielders against the forwards they compete with for a place.
 *
 * No forward was sent off in the sample, so their red prior is a floor rather
 * than the observed zero - a striker can still be dismissed.
 */
const PRIOR_YELLOW_CARDS: Record<Position, number> = { GK: 0.072, DEF: 0.182, MID: 0.188, FWD: 0.149 };
const PRIOR_RED_CARDS: Record<Position, number> = { GK: 0.001, DEF: 0.008, MID: 0.005, FWD: 0.002 };
const GOALS_CONCEDED_PER_DEDUCTION = 2;

type RateField =
  | "expectedGoals" | "expectedAssists" | "goals" | "assists"
  | "bonus" | "saves" | "defensiveContribution" | "yellowCards" | "redCards";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function historicalRate(
  player: Player,
  field: RateField,
): { rate: number; minutes: number } | undefined {
  const history = player.historical;
  if (!history || history.minutes <= 0) return undefined;
  const value = (history as unknown as Partial<Record<RateField, number>>)[field];
  if (value === undefined) return undefined;
  return { rate: (value / history.minutes) * 90, minutes: history.minutes };
}

function currentRate(
  player: Player,
  field: RateField,
): { rate: number; minutes: number } | undefined {
  const value = (player.current as unknown as Partial<Record<RateField, number>>)[field];
  if (value === undefined || player.current.minutes <= 0) return undefined;
  return { rate: (value / player.current.minutes) * 90, minutes: player.current.minutes };
}

function hasUsableHistoricalRate(
  player: Player,
  primary: "expectedGoals" | "expectedAssists",
  fallback: "goals" | "assists",
): boolean {
  return historicalRate(player, primary) !== undefined
    || historicalRate(player, fallback) !== undefined;
}

function regressedPlayerRate(
  player: Player,
  primary: RateField,
  fallback: "goals" | "assists" | undefined,
  prior: number,
  currentGameweek: number,
  ceiling: number = RATE_CEILING.goalInvolvement,
): number {
  const historical = historicalRate(player, primary) ?? (fallback ? historicalRate(player, fallback) : undefined);
  const current = currentRate(player, primary) ?? (fallback ? currentRate(player, fallback) : undefined);
  let rate = historical?.rate ?? prior;
  let sample = historical?.minutes ?? 0;
  if (current) {
    const currentWeight = clamp(currentGameweek / 10, 0, 0.6);
    rate = rate * (1 - currentWeight) + current.rate * currentWeight;
    sample += current.minutes * currentWeight;
  }
  return clamp(regressPer90(rate, sample, prior, 900), 0, ceiling);
}

/**
 * xG/xA-specific replacement for regressedPlayerRate's current-season half.
 * A player's own historical (or position-prior) rate still anchors the
 * blend, preserving personalization. When a per-gameweek match history is
 * available (form), the current-season contribution comes from a
 * recency-weighted match-by-match blend (blendPlayerRate) instead of a flat
 * season-to-date average - see playerForm.ts for why. Before any gameweek
 * has finished (or for any caller that hasn't wired up the in-season form
 * loader), this falls back to the same cumulative-current-season blend
 * regressedPlayerRate always used, so behaviour degrades gracefully rather
 * than silently discarding Player.current's live totals.
 */
function regressedFormRate(
  player: Player,
  primary: "expectedGoals" | "expectedAssists",
  fallback: "goals" | "assists",
  prior: number,
  form: readonly PlayerMatchRate[] | undefined,
  currentGameweek: number,
  ceiling: number = RATE_CEILING.goalInvolvement,
): number {
  const historical = historicalRate(player, primary) ?? historicalRate(player, fallback);
  const basePrior = historical?.rate ?? prior;

  if (form && form.length > 0) {
    const field = primary === "expectedGoals" ? "xg" : "xa";
    const matchRates = form.map((match) => (match.minutes > 0 ? (match[field] / match.minutes) * 90 : 0));
    return clamp(
      blendPlayerRate(matchRates, basePrior, PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES),
      0,
      ceiling,
    );
  }

  const current = currentRate(player, primary) ?? currentRate(player, fallback);
  let rate = basePrior;
  let sample = historical?.minutes ?? 0;
  if (current) {
    const currentWeight = clamp(currentGameweek / 10, 0, 0.6);
    rate = rate * (1 - currentWeight) + current.rate * currentWeight;
    sample += current.minutes * currentWeight;
  }
  return clamp(regressPer90(rate, sample, prior, 900), 0, ceiling);
}

function teamFor(
  player: Player,
  options: ProjectPlayerOptions,
): TeamStrength | undefined {
  return options.teamStrength ?? options.teamStrengths?.[player.teamId];
}

function attackingPrior(
  player: Player,
  options: ProjectPlayerOptions,
  primary: "expectedGoals" | "expectedAssists",
  fallback: "goals" | "assists",
): number {
  const override = primary === "expectedGoals" ? options.positionPrior?.[player.position] : undefined;
  if (override !== undefined) return override;
  if (player.position !== "DEF" || hasUsableHistoricalRate(player, primary, fallback)) {
    return primary === "expectedGoals" ? PRIOR_XG[player.position] : PRIOR_XA[player.position];
  }
  return primary === "expectedGoals" ? UNKNOWN_DEFENDER_XG_PRIOR : UNKNOWN_DEFENDER_XA_PRIOR;
}

function fixtureFor(
  player: Player,
  fixture: PlayerFixture,
  options: ProjectPlayerOptions,
): ReturnType<typeof calculateFixtureAdjustment> {
  return calculateFixtureAdjustment(fixture, {
    ownTeam: teamFor(player, options),
    opponentTeam: options.teamStrengths?.[fixture.opponentTeamId],
  });
}

function zeroComponents(): ProjectionComponents {
  return {
    appearance: 0,
    goals: 0,
    assists: 0,
    cleanSheets: 0,
    goalsConceded: 0,
    saves: 0,
    defensiveContribution: 0,
    bonus: 0,
    cards: 0,
    penalties: 0,
    total: 0,
  };
}

function addComponents(target: ProjectionComponents, source: ProjectionComponents): void {
  for (const key of Object.keys(target) as (keyof ProjectionComponents)[]) {
    target[key] += source[key];
  }
}

interface ProjectionScenario {
  probability: number;
  minutes: number;
}

/** Reconstructs the role durations used by the selection model so xP and minutes agree. */
function scenarios(player: Player, expectedMinutes: number, useSelection: boolean): ProjectionScenario[] {
  const selection = useSelection ? player.selection : undefined;
  if (!selection) return [{ probability: 1, minutes: expectedMinutes }];

  let startProbability = clamp(selection.startProbability, 0, 1);
  let cameoProbability = clamp(selection.cameoProbability, 0, 1);
  const totalProbability = startProbability + cameoProbability;
  if (totalProbability > 1) {
    startProbability /= totalProbability;
    cameoProbability /= totalProbability;
  }
  const cameoMinutes = clamp(selection.expectedCameoMinutes ?? 20, 1, 45);
  const startMinutes = clamp(selection.expectedStartMinutes ?? 80, 60, 90);
  return [
    { probability: startProbability, minutes: startMinutes },
    { probability: cameoProbability, minutes: cameoMinutes },
  ];
}

/** Sums fixture points per gameweek, preserving doubles as separate fixtures. */
export function aggregateFixturePointsByGameweek(
  fixtures: readonly FixtureProjection[],
): Map<number, number> {
  const totals = new Map<number, number>();
  for (const fixture of fixtures) {
    totals.set(
      fixture.gameweek,
      (totals.get(fixture.gameweek) ?? 0) + fixture.expectedPoints,
    );
  }
  return totals;
}

/** Returns zero for a requested gameweek with no fixture. */
export function fixturePointsForGameweek(
  fixtures: readonly FixtureProjection[],
  gameweek: number,
): number {
  return aggregateFixturePointsByGameweek(fixtures).get(gameweek) ?? 0;
}

function fixturePointsForGameweeks(
  totals: ReadonlyMap<number, number>,
  currentGameweek: number,
  count: number,
): number {
  return Array.from({ length: count }, (_, offset) => currentGameweek + offset)
    .reduce((sum, gameweek) => sum + (totals.get(gameweek) ?? 0), 0);
}

function fixtureComponents(
  player: Player,
  fixture: PlayerFixture,
  expectedMinutes: number,
  options: ProjectPlayerOptions,
  rates: {
    xg: number;
    xa: number;
    saves: number;
    defensiveContribution: number;
    bonus: number;
    yellowCards: number;
    redCards: number;
  },
  useSelection: boolean,
): ProjectionComponents {
  const adjustment = fixtureFor(player, fixture, options);
  const components = zeroComponents();
  for (const scenario of scenarios(player, expectedMinutes, useSelection)) {
    const minutesShare = clamp(scenario.minutes, 0, 90) / 90;
    if (scenario.probability <= 0 || minutesShare <= 0) continue;
    const weight = scenario.probability;
    const playedSixty = scenario.minutes >= 60;
    components.appearance += weight * (playedSixty ? 2 : 1);
    components.goals += weight * rates.xg * GOAL_CONVERSION[player.position] * minutesShare * adjustment.attackMultiplier * GOAL_POINTS[player.position];
    components.assists += weight * rates.xa * ASSIST_CONVERSION[player.position] * minutesShare * adjustment.attackMultiplier * 3;
    if (playedSixty) {
      components.cleanSheets += weight * adjustment.cleanSheetProbability * CLEAN_SHEET_POINTS[player.position];
    }
    if (player.position === "GK" || player.position === "DEF") {
      // A point goes for every second goal conceded while the player is on the
      // pitch, so this scales with minutes and applies to cameos too.
      components.goalsConceded -= weight * expectedFloorDivision(
        adjustment.expectedGoalsAgainst * minutesShare,
        GOALS_CONCEDED_PER_DEDUCTION,
      );
    }
    if (player.position === "GK") {
      // Save volume follows the opponent's threat, not the team's own attack.
      const savesEnvironment = clamp(
        adjustment.expectedGoalsAgainst / LEAGUE_AVERAGE_GOALS_AGAINST,
        0.7,
        1.4,
      );
      components.saves += weight * expectedFloorDivision(
        rates.saves * minutesShare * savesEnvironment,
        SAVES_PER_POINT,
      );
    }
    const threshold = DEFENSIVE_CONTRIBUTION_THRESHOLD[player.position];
    if (threshold > 0) {
      // The reward is a threshold, so its expectation is a probability rather
      // than a share of the threshold: 2 x P(count >= threshold).
      components.defensiveContribution += weight * DEFENSIVE_CONTRIBUTION_POINTS
        * thresholdProbability(rates.defensiveContribution * minutesShare, threshold);
    }
    // Bonus follows the fixture. BPS is driven by the same goals, assists and
    // clean sheets section 7 already adjusts, so a flat per-90 rate priced a
    // player identically at home to the worst defence and away to the best.
    // Backtested over 2025/26: RMSE -0.0033 for GK/DEF with the paired
    // confidence interval excluding zero, -0.0017 across all rows. It also
    // closes most of the gap in how far a forward's projection moves between
    // an easy and a hard fixture (0.73 -> 1.01 against an observed 1.07).
    components.bonus += weight * rates.bonus * minutesShare * adjustment.attackMultiplier;
    // A booking is something that either happens or does not, so this is a
    // probability rather than a rate times minutes: at a 0.18 yellow rate the
    // difference is small, but it keeps a full match from ever implying more
    // than one card. Yellows and reds are added separately; a red arriving via
    // a second yellow is rare enough (0.005 per 90 at its highest) that the
    // overlap is not worth modelling.
    const yellowChance = 1 - Math.exp(-rates.yellowCards * minutesShare);
    const redChance = 1 - Math.exp(-rates.redCards * minutesShare);
    components.cards -= weight * (YELLOW_CARD_POINTS * yellowChance + RED_CARD_POINTS * redChance);
  }
  components.total = Object.entries(components)
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + value, 0);
  return components;
}

function factors(
  player: Player,
  confidence: ProjectionConfidence,
  expectedMinutes: number,
  fixtures: readonly FixtureProjection[],
): ProjectionFactor[] {
  const averageDifficulty = fixtures.length === 0
    ? 3
    : fixtures.reduce((sum, item) => sum + (item.fixture.difficulty ?? 3), 0) / fixtures.length;
  return [
    {
      label: "Expected minutes",
      value: expectedMinutes,
      direction: expectedMinutes >= 75 ? "POSITIVE" : expectedMinutes < 55 ? "NEGATIVE" : "NEUTRAL",
    },
    {
      label: "Fixture difficulty",
      value: averageDifficulty,
      direction: averageDifficulty <= 2.5 ? "POSITIVE" : averageDifficulty >= 4 ? "NEGATIVE" : "NEUTRAL",
    },
    {
      label: "Projection confidence",
      value: confidence === "HIGH" ? 3 : confidence === "MEDIUM" ? 2 : 1,
      direction: confidence === "HIGH" ? "POSITIVE" : confidence === "LOW" ? "NEGATIVE" : "NEUTRAL",
    },
    {
      label: `${player.position} component model`,
      value: 1,
      direction: "NEUTRAL",
    },
  ];
}

/** Projects one player's upcoming fixtures using explicit scoring components. */
export function projectPlayer(
  player: Player,
  options: ProjectPlayerOptions = {},
): PlayerProjection {
  const currentGameweek = options.currentGameweek ?? 1;
  const horizon = options.horizon ?? 5;
  const expectedMinutes = options.expectedMinutes ?? estimateExpectedMinutes(player, {
    ...options.expectedMinutesOptions,
    currentGameweek,
  });
  const useSelection = options.expectedMinutes === undefined && options.expectedMinutesOptions?.override === undefined;
  const confidence = projectionConfidence(player);
  const form = options.playerForm?.[player.id];
  const rates = {
    xg: regressedFormRate(player, "expectedGoals", "goals", attackingPrior(player, options, "expectedGoals", "goals"), form, currentGameweek),
    xa: regressedFormRate(player, "expectedAssists", "assists", attackingPrior(player, options, "expectedAssists", "assists"), form, currentGameweek),
    saves: regressedPlayerRate(player, "saves", undefined, PRIOR_SAVES[player.position], currentGameweek, RATE_CEILING.saves),
    defensiveContribution: regressedPlayerRate(player, "defensiveContribution", undefined, PRIOR_DEFENSIVE_CONTRIBUTION[player.position], currentGameweek, RATE_CEILING.defensiveContribution),
    bonus: regressedPlayerRate(player, "bonus", undefined, PRIOR_BONUS[player.position], currentGameweek, RATE_CEILING.bonus),
    yellowCards: regressedPlayerRate(player, "yellowCards", undefined, PRIOR_YELLOW_CARDS[player.position], currentGameweek, RATE_CEILING.yellowCards),
    redCards: regressedPlayerRate(player, "redCards", undefined, PRIOR_RED_CARDS[player.position], currentGameweek, RATE_CEILING.redCards),
  };
  const projectionHorizon = Math.max(5, options.fixtureHorizon ?? horizon);
  const upcoming = player.fixtures
    .filter(
      (fixture) =>
        fixture.gameweek >= currentGameweek &&
        fixture.gameweek < currentGameweek + projectionHorizon,
    )
    .sort((a, b) => a.gameweek - b.gameweek || a.opponentTeamId - b.opponentTeamId);
  const fixtureProjections: FixtureProjection[] = upcoming.map((fixture) => {
    const components = fixtureComponents(player, fixture, expectedMinutes, options, rates, useSelection);
    return {
      gameweek: fixture.gameweek,
      expectedPoints: rounded(components.total),
      expectedMinutes,
      fixture,
      components,
    };
  });
  const allComponents = zeroComponents();
  fixtureProjections.forEach((fixture) => addComponents(allComponents, fixture.components!));
  allComponents.total = Object.entries(allComponents)
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + value, 0);
  const pointsByGameweek = aggregateFixturePointsByGameweek(fixtureProjections);
  const nextGW = fixturePointsForGameweek(fixtureProjections, currentGameweek);
  const next3 = fixturePointsForGameweeks(pointsByGameweek, currentGameweek, 3);
  const next5 = fixturePointsForGameweeks(pointsByGameweek, currentGameweek, 5);
  return {
    playerId: player.id,
    fixtures: fixtureProjections,
    nextGW: rounded(nextGW),
    next3: rounded(next3),
    next5: rounded(next5),
    expectedMinutes,
    valueNext5: rounded(valuePerMillion(next5, player.priceTenths)),
    riskScore: calculateRiskScore(player, expectedMinutes, confidence),
    confidence,
    factors: factors(player, confidence, expectedMinutes, fixtureProjections),
    components: allComponents,
  };
}

export function projectPlayers(
  players: readonly Player[],
  options: ProjectPlayerOptions = {},
): PlayerProjection[] {
  return players.map((player) => projectPlayer(player, options));
}

export const calculatePlayerProjection = projectPlayer;
