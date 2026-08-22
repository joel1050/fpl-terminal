import type {
  FixtureProjection,
  Player,
  PlayerFixture,
  PlayerProjection,
  ProjectionFactor,
  ProjectionConfidence,
  Position,
} from "@/types/player";
import type { ProjectionComponents, ProjectionOptions, TeamStrength } from "@/types/projection";
import { calculateFixtureAdjustment } from "./fixtureAdjustment";
import { estimateExpectedMinutes, type ExpectedMinutesOptions } from "./expectedMinutes";
import { projectionConfidence, calculateRiskScore, valuePerMillion } from "./metrics";
import { regressPer90 } from "./regression";

export type ProjectPlayerOptions = Partial<ProjectionOptions> & {
  expectedMinutesOptions?: ExpectedMinutesOptions;
};

const PRIOR_XG: Record<Position, number> = { GK: 0.01, DEF: 0.08, MID: 0.25, FWD: 0.45 };
const PRIOR_XA: Record<Position, number> = { GK: 0.02, DEF: 0.08, MID: 0.2, FWD: 0.15 };
const UNKNOWN_DEFENDER_XG_PRIOR = 0.02;
const UNKNOWN_DEFENDER_XA_PRIOR = 0.02;
const GOAL_POINTS: Record<Position, number> = { GK: 10, DEF: 6, MID: 5, FWD: 4 };
const CLEAN_SHEET_POINTS: Record<Position, number> = { GK: 4, DEF: 4, MID: 1, FWD: 0 };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function historicalRate(
  player: Player,
  field: "expectedGoals" | "expectedAssists" | "goals" | "assists" | "bonus" | "saves" | "defensiveContribution",
): { rate: number; minutes: number } | undefined {
  const history = player.historical;
  if (!history || history.minutes <= 0) return undefined;
  const value = history[field];
  if (value === undefined) return undefined;
  return { rate: (value / history.minutes) * 90, minutes: history.minutes };
}

function currentRate(
  player: Player,
  field: "expectedGoals" | "expectedAssists" | "goals" | "assists" | "bonus" | "saves" | "defensiveContribution",
): { rate: number; minutes: number } | undefined {
  const value = (player.current as unknown as Partial<Record<typeof field, number>>)[field];
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
  primary: "expectedGoals" | "expectedAssists" | "goals" | "assists" | "bonus" | "saves" | "defensiveContribution",
  fallback: "goals" | "assists" | undefined,
  prior: number,
  currentGameweek: number,
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
  return clamp(regressPer90(rate, sample, prior, 900), 0, 3);
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
    position: player.position,
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
    saves: 0,
    defensiveContribution: 0,
    bonus: 0,
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
    components.goals += weight * rates.xg * minutesShare * adjustment.attackMultiplier * GOAL_POINTS[player.position];
    components.assists += weight * rates.xa * minutesShare * adjustment.attackMultiplier * 3;
    if (playedSixty) {
      components.cleanSheets += weight * adjustment.cleanSheetProbability * CLEAN_SHEET_POINTS[player.position];
    }
    components.saves += player.position === "GK"
      ? weight * (rates.saves * minutesShare * adjustment.attackMultiplier) / 3
      : 0;
    const threshold = player.position === "DEF" ? 10 : 12;
    components.defensiveContribution += player.position === "GK"
      ? 0
      : weight * (rates.defensiveContribution * minutesShare * 2) / threshold;
    components.bonus += weight * rates.bonus * minutesShare * 0.3;
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
  const rates = {
    xg: regressedPlayerRate(player, "expectedGoals", "goals", attackingPrior(player, options, "expectedGoals", "goals"), currentGameweek),
    xa: regressedPlayerRate(player, "expectedAssists", "assists", attackingPrior(player, options, "expectedAssists", "assists"), currentGameweek),
    saves: regressedPlayerRate(player, "saves", undefined, player.position === "GK" ? 2.8 : 0, currentGameweek),
    defensiveContribution: regressedPlayerRate(player, "defensiveContribution", undefined, player.position === "DEF" ? 4 : 3, currentGameweek),
    bonus: regressedPlayerRate(player, "bonus", undefined, 0.12, currentGameweek),
  };
  const projectionHorizon = Math.max(5, horizon);
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
