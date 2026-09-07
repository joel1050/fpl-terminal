/**
 * Walk-forward comparison of opponent-strength schedule adjustment.
 *
 * Arms, all evaluated before the target gameweek:
 *   none          in-season raw-xG update with no opponent adjustment (control)
 *   static        production applyInSeasonForm; past matches use opponent priors
 *   chronological past matches in each completed GW use that GW's pre-GW ratings
 *   retrospective past matches are rescored with the current static rating table
 *   joint         recency-weighted Poisson attack/defence fit on prior fixtures only
 *
 * The script uses actual minutes and projectPlayer() for xP so it measures the
 * fixture/team-strength signal rather than the separate minutes model. The latest
 * season is a confirmation split: shipped coefficients were already calibrated
 * against it. Run the prepared corpus first when the multi-season directory is
 * absent:
 *   npx tsx scripts/backtest/prepare-seasons.ts
 *
 * The root invocation runs every prepared target season and writes
 * scripts/backtest/results/opponent-adjustment.json. A child invocation is used
 * internally so season.ts can keep its existing BACKTEST_DATA_DIR contract.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectPlayer } from "@/lib/projections/projectPlayer";
import { applyInSeasonForm, type TeamMatchXG } from "@/lib/historical/inSeasonForm";
import { calculateFixtureAdjustment } from "@/lib/projections/fixtureAdjustment";
import type { Player, Position } from "@/types/player";
import type { PlayerMatchRate, TeamStrength } from "@/types/projection";
import {
  formBefore,
  loadSeason,
  playerAt,
  strengthsBefore,
  type Fixture,
  type MatchRow,
  type Season,
} from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE } from "./variants";

const FIRST_GAMEWEEK = 6;
const LAST_GAMEWEEK = 38;
const FORM_DECAY = 0.9;
const PRIOR_WEIGHT = 12;
const BOOTSTRAP_DRAWS = 4_000;
const JOINT_MAX_ITERATIONS = 800;
const JOINT_REGULARIZATION = PRIOR_WEIGHT;
const HOME_XG_FACTOR = 1.102;
const AWAY_XG_FACTOR = 0.898;

const ARM_NAMES = ["none", "static", "chronological", "retrospective", "joint"] as const;
type ArmName = (typeof ARM_NAMES)[number];

const SLICE_BOUNDS = {
  early: [FIRST_GAMEWEEK, 12],
  mid: [13, 25],
  late: [26, LAST_GAMEWEEK],
} as const;
type SliceName = keyof typeof SLICE_BOUNDS;
const SLICE_NAMES = Object.keys(SLICE_BOUNDS) as SliceName[];

const mean = (values: readonly number[]): number => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;
const rmse = (values: readonly number[]): number => Math.sqrt(mean(values.map((value) => value * value)));
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

function stableSeed(value: string): number {
  let seed = 2166136261;
  for (const character of value) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
}

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function fixtureMap(season: Season): Map<number, Fixture> {
  return new Map(season.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
}

function fixturesBefore(season: Season, gameweek: number): Fixture[] {
  return season.fixtures
    .filter((fixture) => fixture.gameweek < gameweek)
    .sort((a, b) => a.gameweek - b.gameweek || a.fixtureId - b.fixtureId);
}

function historyWithOpponentIds(season: Season, gameweek: number): Record<number, TeamMatchXG[]> {
  const history: Record<number, TeamMatchXG[]> = {};
  const add = (
    teamId: number,
    xgFor: number,
    xgAgainst: number,
    opponentTeamId: number,
    wasHome: boolean,
  ) => {
    (history[teamId] ??= []).push({ xgFor, xgAgainst, opponentTeamId, wasHome });
  };
  for (const fixture of fixturesBefore(season, gameweek)) {
    add(fixture.homeTeamId, fixture.homeXg, fixture.awayXg, fixture.awayTeamId, true);
    add(fixture.awayTeamId, fixture.awayXg, fixture.homeXg, fixture.homeTeamId, false);
  }
  return history;
}

/** The production static-opponent path, retained as a direct parity reference. */
function staticStrengthsFromProduction(season: Season, gameweek: number): Record<number, TeamStrength> {
  return applyInSeasonForm(season.priorStrengths, historyWithOpponentIds(season, gameweek));
}

/** In-season control: update on raw xG while leaving opponent adjustment out. */
function rawInSeasonStrengthsBefore(season: Season, gameweek: number): Record<number, TeamStrength> {
  const history: Record<number, TeamMatchXG[]> = {};
  for (const fixture of fixturesBefore(season, gameweek)) {
    (history[fixture.homeTeamId] ??= []).push({ xgFor: fixture.homeXg, xgAgainst: fixture.awayXg });
    (history[fixture.awayTeamId] ??= []).push({ xgFor: fixture.awayXg, xgAgainst: fixture.homeXg });
  }
  return applyInSeasonForm(season.priorStrengths, history);
}

function copyStrengths(strengths: Record<number, TeamStrength>): Record<number, TeamStrength> {
  return Object.fromEntries(Object.entries(strengths).map(([key, strength]) => [key, { ...strength }])) as Record<number, TeamStrength>;
}

function averageAttack(strength: TeamStrength): number {
  return (strength.attackHome + strength.attackAway) / 2;
}

function averageDefence(strength: TeamStrength): number {
  return (strength.defenceHome + strength.defenceAway) / 2;
}

/**
 * Applies the shipped decay/share blend to history that has already been
 * schedule-adjusted. Keeping the transformed history free of opponent IDs is
 * deliberate: applyInSeasonForm would otherwise adjust it a second time.
 */
function blendAdjustedHistory(
  priors: Record<number, TeamStrength>,
  history: Record<number, readonly TeamMatchXG[]>,
): Record<number, TeamStrength> {
  const allXg = Object.values(history).flatMap((matches) => matches.map((match) => match.xgFor));
  const leagueAverage = Math.max(mean(allXg) || 1, 0.15);
  const result: Record<number, TeamStrength> = {};

  for (const [key, prior] of Object.entries(priors)) {
    const teamId = Number(key);
    const matches = history[teamId] ?? [];
    if (matches.length === 0) {
      result[teamId] = { ...prior };
      continue;
    }
    let weightSum = 0;
    let weightedFor = 0;
    let weightedAgainst = 0;
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[matches.length - index - 1];
      const weight = FORM_DECAY ** index;
      weightSum += weight;
      weightedFor += weight * match.xgFor;
      weightedAgainst += weight * match.xgAgainst;
    }
    const observedAttack = (weightedFor / weightSum) / leagueAverage;
    const observedDefence = leagueAverage / Math.max(weightedAgainst / weightSum, 0.15);
    const share = matches.length / (matches.length + PRIOR_WEIGHT);
    const attack = averageAttack(prior) * (1 - share) + observedAttack * share;
    const defence = averageDefence(prior) * (1 - share) + observedDefence * share;
    result[teamId] = {
      teamId,
      attackHome: Math.max(attack, 0.05),
      attackAway: Math.max(attack, 0.05),
      defenceHome: Math.max(defence, 0.05),
      defenceAway: Math.max(defence, 0.05),
      overall: (attack + defence) / 2,
    };
  }
  return result;
}

function addScheduleAdjustedFixture(
  history: Record<number, TeamMatchXG[]>,
  fixture: Fixture,
  strengths: Record<number, TeamStrength>,
): void {
  const homeOpponent = strengths[fixture.awayTeamId];
  const awayOpponent = strengths[fixture.homeTeamId];
  const homeOppDefence = homeOpponent ? Math.max(homeOpponent.defenceAway, 0.2) : 1;
  const awayOppDefence = awayOpponent ? Math.max(awayOpponent.defenceHome, 0.2) : 1;
  const homeOppAttack = homeOpponent ? Math.max(homeOpponent.attackAway, 0.2) : 1;
  const awayOppAttack = awayOpponent ? Math.max(awayOpponent.attackHome, 0.2) : 1;
  (history[fixture.homeTeamId] ??= []).push({
    xgFor: fixture.homeXg * homeOppDefence,
    xgAgainst: fixture.awayXg / homeOppAttack,
  });
  (history[fixture.awayTeamId] ??= []).push({
    xgFor: fixture.awayXg * awayOppDefence,
    xgAgainst: fixture.homeXg / awayOppAttack,
  });
}

/**
 * Uses each opponent's rating as it stood before the fixture was observed.
 * The target gameweek is never processed, and a previous game's result is
 * added only after its pre-match rating has been used.
 */
function chronologicalStrengthsBefore(season: Season, gameweek: number): Record<number, TeamStrength> {
  const history: Record<number, TeamMatchXG[]> = {};
  let current = copyStrengths(season.priorStrengths);
  const prior = fixturesBefore(season, gameweek);
  const previousGameweeks = [...new Set(prior.map((fixture) => fixture.gameweek))].sort((a, b) => a - b);
  for (const previousGameweek of previousGameweeks) {
    // All fixtures in one completed GW use the same pre-GW opponent ratings;
    // their results become available together for the next GW.
    for (const fixture of prior) {
      if (fixture.gameweek !== previousGameweek) continue;
      addScheduleAdjustedFixture(history, fixture, current);
    }
    current = blendAdjustedHistory(season.priorStrengths, history);
  }
  return current;
}

/**
 * Re-scores every past observation with the current production strength table.
 * "Current" means current at the target cutoff, so this uses later past
 * matches relative to an observation but never a target or future gameweek.
 */
function retrospectiveStrengthsBefore(season: Season, gameweek: number): Record<number, TeamStrength> {
  const current = staticStrengthsFromProduction(season, gameweek);
  const history: Record<number, TeamMatchXG[]> = {};
  for (const fixture of fixturesBefore(season, gameweek)) addScheduleAdjustedFixture(history, fixture, current);
  return blendAdjustedHistory(season.priorStrengths, history);
}

interface JointFitDiagnostics {
  iterations: number;
  converged: boolean;
  gradientNorm: number;
  objective: number;
  initialObjective: number;
  lineSearchBacktracks: number;
  effectiveMatchesPerTeam: number;
  regularizationMatches: number;
}

interface JointFitResult {
  strengths: Record<number, TeamStrength>;
  diagnostics: JointFitDiagnostics;
}

function fitJointStrengths(season: Season, gameweek: number): JointFitResult {
  const fixtures = fixturesBefore(season, gameweek);
  const teamIds = Object.keys(season.priorStrengths).map(Number).sort((a, b) => a - b);
  const index = new Map(teamIds.map((teamId, position) => [teamId, position]));
  if (fixtures.length === 0 || teamIds.length === 0) {
    return {
      strengths: copyStrengths(season.priorStrengths),
      diagnostics: {
        iterations: 0, converged: true, gradientNorm: 0, objective: 0,
        initialObjective: 0, lineSearchBacktracks: 0,
        effectiveMatchesPerTeam: 0, regularizationMatches: JOINT_REGULARIZATION,
      },
    };
  }

  // Each team's decayed likelihood is rescaled to total n observations. This
  // keeps the fixed 12-match penalty comparable with n/(n+12) in production.
  const teamCounts = new Array<number>(teamIds.length).fill(0);
  for (const fixture of fixtures) {
    const homePosition = index.get(fixture.homeTeamId);
    const awayPosition = index.get(fixture.awayTeamId);
    if (homePosition !== undefined) teamCounts[homePosition] += 1;
    if (awayPosition !== undefined) teamCounts[awayPosition] += 1;
  }
  const teamWeightSums = new Array<number>(teamIds.length).fill(0);
  const seenMatches = new Array<number>(teamIds.length).fill(0);
  const sideWeights = fixtures.map((fixture) => {
    const homePosition = index.get(fixture.homeTeamId);
    const awayPosition = index.get(fixture.awayTeamId);
    const homeRawWeight = homePosition === undefined
      ? 1
      : FORM_DECAY ** (teamCounts[homePosition] - seenMatches[homePosition] - 1);
    const awayRawWeight = awayPosition === undefined
      ? 1
      : FORM_DECAY ** (teamCounts[awayPosition] - seenMatches[awayPosition] - 1);
    if (homePosition !== undefined) {
      teamWeightSums[homePosition] += homeRawWeight;
      seenMatches[homePosition] += 1;
    }
    if (awayPosition !== undefined) {
      teamWeightSums[awayPosition] += awayRawWeight;
      seenMatches[awayPosition] += 1;
    }
    return { home: homeRawWeight, away: awayRawWeight };
  });
  const teamScales = teamWeightSums.map((sum, position) =>
    sum > 0 ? teamCounts[position] / sum : 1);
  const effectiveMatchesPerTeam = mean(teamCounts);

  const priorAttack = teamIds.map((teamId) => Math.log(Math.max(averageAttack(season.priorStrengths[teamId]), 0.05)));
  const priorDefence = teamIds.map((teamId) => Math.log(Math.max(averageDefence(season.priorStrengths[teamId]), 0.05)));
  const centre = (values: number[]): number[] => {
    const offset = mean(values);
    return values.map((value) => value - offset);
  };
  const priorA = centre(priorAttack);
  const priorD = centre(priorDefence);
  let attack = [...priorA];
  let defence = [...priorD];

  // Keep the intercept identical to the other arms' pre-cutoff xG scale. The
  // fit only supplies attack/defence ratios that are then passed through the
  // production fixture adjustment and its clamps.
  const leagueMeanXg = trainingMeanXg(season, gameweek);

  const evaluate = (a: readonly number[], d: readonly number[]) => {
    const gradientA = new Array<number>(teamIds.length).fill(0);
    const gradientD = new Array<number>(teamIds.length).fill(0);
    let objective = 0;
    let totalWeight = 0;
    fixtures.forEach((fixture, fixtureIndex) => {
      const homePosition = index.get(fixture.homeTeamId);
      const awayPosition = index.get(fixture.awayTeamId);
      if (homePosition === undefined || awayPosition === undefined) return;
      const homeWeight = sideWeights[fixtureIndex].home * teamScales[homePosition];
      const awayWeight = sideWeights[fixtureIndex].away * teamScales[awayPosition];
      const homeLogLambda = Math.log(leagueMeanXg * HOME_XG_FACTOR) + a[homePosition] - d[awayPosition];
      const awayLogLambda = Math.log(leagueMeanXg * AWAY_XG_FACTOR) + a[awayPosition] - d[homePosition];
      const homeLambda = Math.exp(clamp(homeLogLambda, -8, 4));
      const awayLambda = Math.exp(clamp(awayLogLambda, -8, 4));
      const homeResidual = homeLambda - Math.max(fixture.homeXg, 0);
      const awayResidual = awayLambda - Math.max(fixture.awayXg, 0);
      objective += homeWeight * (homeLambda - fixture.homeXg * homeLogLambda);
      objective += awayWeight * (awayLambda - fixture.awayXg * awayLogLambda);
      gradientA[homePosition] += homeWeight * homeResidual;
      gradientD[awayPosition] -= homeWeight * homeResidual;
      gradientA[awayPosition] += awayWeight * awayResidual;
      gradientD[homePosition] -= awayWeight * awayResidual;
      totalWeight += homeWeight + awayWeight;
    });
    for (let position = 0; position < teamIds.length; position += 1) {
      objective += 0.5 * JOINT_REGULARIZATION * ((a[position] - priorA[position]) ** 2 + (d[position] - priorD[position]) ** 2);
      gradientA[position] += JOINT_REGULARIZATION * (a[position] - priorA[position]);
      gradientD[position] += JOINT_REGULARIZATION * (d[position] - priorD[position]);
    }
    const gradientAMean = mean(gradientA);
    const gradientDMean = mean(gradientD);
    for (let position = 0; position < teamIds.length; position += 1) {
      gradientA[position] -= gradientAMean;
      gradientD[position] -= gradientDMean;
    }
    const normalizer = Math.max(totalWeight + JOINT_REGULARIZATION * teamIds.length, 1);
    const gradientNorm = Math.sqrt(
      gradientA.reduce((sum, value) => sum + value * value, 0)
      + gradientD.reduce((sum, value) => sum + value * value, 0),
    ) / normalizer;
    return { objective, gradientA, gradientD, gradientNorm };
  };

  let current = evaluate(attack, defence);
  const initialObjective = current.objective;
  let converged = false;
  let lineSearchBacktracks = 0;
  let iterations = 0;
  for (iterations = 1; iterations <= JOINT_MAX_ITERATIONS; iterations += 1) {
    if (current.gradientNorm < 1e-7) {
      converged = true;
      break;
    }
    const normalizer = Math.max(
      2 * fixtures.length + JOINT_REGULARIZATION * teamIds.length,
      1,
    );
    let step = 0.75;
    let accepted = false;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const candidateAttack = centre(attack.map((value, position) => value - step * current.gradientA[position] / normalizer));
      const candidateDefence = centre(defence.map((value, position) => value - step * current.gradientD[position] / normalizer));
      const candidate = evaluate(candidateAttack, candidateDefence);
      if (candidate.objective <= current.objective + 1e-12) {
        attack = candidateAttack;
        defence = candidateDefence;
        current = candidate;
        accepted = true;
        break;
      }
      step *= 0.5;
      lineSearchBacktracks += 1;
    }
    if (!accepted) break;
    if (current.gradientNorm < 1e-7 || Math.abs(initialObjective - current.objective) < 1e-10) {
      converged = true;
      break;
    }
  }

  const strengths: Record<number, TeamStrength> = {};
  teamIds.forEach((teamId, position) => {
    const fittedAttack = Math.exp(attack[position]);
    const fittedDefence = Math.exp(defence[position]);
    strengths[teamId] = {
      teamId,
      attackHome: fittedAttack,
      attackAway: fittedAttack,
      defenceHome: fittedDefence,
      defenceAway: fittedDefence,
      overall: (fittedAttack + fittedDefence) / 2,
    };
  });
  return {
    strengths,
    diagnostics: {
      iterations: Math.min(iterations, JOINT_MAX_ITERATIONS),
      converged,
      gradientNorm: current.gradientNorm,
      objective: current.objective,
      initialObjective,
      lineSearchBacktracks,
      effectiveMatchesPerTeam,
      regularizationMatches: JOINT_REGULARIZATION,
    },
  };
}

interface StrengthBundle {
  byArm: Record<ArmName, Record<number, TeamStrength>>;
  joint: JointFitDiagnostics;
}

function strengthsForGameweek(season: Season, gameweek: number): StrengthBundle {
  const staticStrengths = staticStrengthsFromProduction(season, gameweek);
  const chronological = chronologicalStrengthsBefore(season, gameweek);
  const retrospective = retrospectiveStrengthsBefore(season, gameweek);
  const joint = fitJointStrengths(season, gameweek);
  return {
    byArm: {
      none: rawInSeasonStrengthsBefore(season, gameweek),
      static: staticStrengths,
      chronological,
      retrospective,
      joint: joint.strengths,
    },
    joint: joint.diagnostics,
  };
}

function trainingMeanXg(season: Season, gameweek: number): number {
  const prior = fixturesBefore(season, gameweek);
  if (prior.length === 0) return 1.4;
  return Math.max(mean(prior.flatMap((fixture) => [fixture.homeXg, fixture.awayXg])), 0.15);
}

function adjustmentFor(
  fixture: Fixture,
  gameweek: number,
  isHome: boolean,
  strengths: Record<number, TeamStrength>,
) {
  const ownTeamId = isHome ? fixture.homeTeamId : fixture.awayTeamId;
  const opponentTeamId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
  return calculateFixtureAdjustment(
    {
      gameweek,
      opponentTeamId,
      opponentShortName: "OPP",
      isHome,
      difficulty: (isHome ? fixture.homeDifficulty : fixture.awayDifficulty) ?? 3,
    },
    {
      ownTeam: strengths[ownTeamId],
      opponentTeam: strengths[opponentTeamId],
    },
  );
}

interface PlayerCase {
  gameweek: number;
  fixtureId: number;
  position: Position;
  actual: number;
  predictions: Record<ArmName, number>;
}

interface TeamCase {
  gameweek: number;
  fixtureId: number;
  actualXg: number;
  actualCleanSheet: number;
  predictions: Record<ArmName, { xg: number; cleanSheet: number }>;
}

/** Exercise production's schedule-adjusted player-form path, not its fallback. */
function contextualFormBefore(season: Season, playerId: number, gameweek: number): PlayerMatchRate[] {
  return (season.rowsByPlayer.get(playerId) ?? [])
    .filter((row) => row.gameweek < gameweek && row.minutes > 0)
    .map((row) => ({
      xg: row.expectedGoals ?? 0,
      xa: row.expectedAssists ?? 0,
      minutes: row.minutes,
      opponentTeamId: row.opponentTeamId,
      wasHome: row.wasHome,
    }));
}

function playerForFixtureRow(season: Season, row: MatchRow, fixture: Fixture, gameweek: number): Player | undefined {
  const source = playerAt(season, row.historicalPlayerId, gameweek, fixture, row.wasHome);
  if (!source) return undefined;
  // season.teamOf is a useful aggregate fallback but is wrong for a player who
  // changed clubs; the fixture side is the only identity valid for this row.
  const fixtureTeamId = row.wasHome ? fixture.homeTeamId : fixture.awayTeamId;
  return {
    ...source,
    teamId: fixtureTeamId,
  };
}

function runCases(season: Season): {
  playerCases: PlayerCase[];
  teamCases: TeamCase[];
  strengthsByGameweek: Map<number, StrengthBundle>;
  teamIdentityMismatches: number;
} {
  const byFixture = fixtureMap(season);
  const playerCases: PlayerCase[] = [];
  const teamCases: TeamCase[] = [];
  const strengthsByGameweek = new Map<number, StrengthBundle>();
  let teamIdentityMismatches = 0;

  for (let gameweek = FIRST_GAMEWEEK; gameweek <= LAST_GAMEWEEK; gameweek += 1) {
    const fixtures = season.fixturesByGameweek.get(gameweek) ?? [];
    if (fixtures.length === 0 || fixturesBefore(season, gameweek).length === 0) continue;
    const bundle = strengthsForGameweek(season, gameweek);
    strengthsByGameweek.set(gameweek, bundle);
    const leagueMean = trainingMeanXg(season, gameweek);

    for (const fixture of fixtures) {
      const teamPredictions = {} as Record<ArmName, { xg: number; cleanSheet: number }>;
      for (const arm of ARM_NAMES) {
        const homeAdjustment = adjustmentFor(fixture, gameweek, true, bundle.byArm[arm]);
        teamPredictions[arm] = {
          xg: leagueMean * homeAdjustment.attackMultiplier,
          cleanSheet: homeAdjustment.cleanSheetProbability,
        };
      }
      const awayPredictions = {} as Record<ArmName, { xg: number; cleanSheet: number }>;
      for (const arm of ARM_NAMES) {
        const awayAdjustment = adjustmentFor(fixture, gameweek, false, bundle.byArm[arm]);
        awayPredictions[arm] = {
          xg: leagueMean * awayAdjustment.attackMultiplier,
          cleanSheet: awayAdjustment.cleanSheetProbability,
        };
      }
      teamCases.push({
        gameweek,
        fixtureId: fixture.fixtureId,
        actualXg: fixture.homeXg,
        actualCleanSheet: fixture.awayGoals === 0 ? 1 : 0,
        predictions: teamPredictions,
      });
      teamCases.push({
        gameweek,
        fixtureId: fixture.fixtureId,
        actualXg: fixture.awayXg,
        actualCleanSheet: fixture.homeGoals === 0 ? 1 : 0,
        predictions: awayPredictions,
      });
    }

    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = byFixture.get(row.fixtureId);
      if (!fixture) continue;
      const source = season.players.get(row.historicalPlayerId);
      const player = playerForFixtureRow(season, row, fixture, gameweek);
      if (!source || !player) continue;
      const fixtureTeamId = row.wasHome ? fixture.homeTeamId : fixture.awayTeamId;
      if (season.teamOf.get(row.historicalPlayerId) !== fixtureTeamId) teamIdentityMismatches += 1;
      const form = contextualFormBefore(season, row.historicalPlayerId, gameweek);
      const predictions = {} as Record<ArmName, number>;
      for (const arm of ARM_NAMES) {
        const projection = projectPlayer(player, {
          currentGameweek: gameweek,
          horizon: 1,
          teamStrengths: bundle.byArm[arm],
          playerForm: { [player.id]: form },
          expectedMinutes: row.minutes,
        });
        const prediction = projection.fixtures[0]?.expectedPoints;
        if (prediction === undefined || !Number.isFinite(prediction)) continue;
        predictions[arm] = prediction;
      }
      if (ARM_NAMES.every((arm) => predictions[arm] !== undefined)) {
        playerCases.push({
          gameweek,
          fixtureId: row.fixtureId,
          position: source.position,
          actual: row.totalPoints,
          predictions,
        });
      }
    }
  }
  return { playerCases, teamCases, strengthsByGameweek, teamIdentityMismatches };
}

interface NumericMetric {
  n: number;
  rmse: number;
  bias: number;
  /** Present for clean-sheet rows; unlike rmse, this is the requested Brier score. */
  brier?: number;
}

function playerMetric(rows: readonly PlayerCase[], arm: ArmName, filter?: (row: PlayerCase) => boolean): NumericMetric {
  const selected = filter ? rows.filter(filter) : rows;
  const errors = selected.map((row) => row.predictions[arm] - row.actual);
  return { n: selected.length, rmse: rmse(errors), bias: mean(errors) };
}

function teamMetric(
  rows: readonly TeamCase[],
  arm: ArmName,
  field: "xg" | "cleanSheet",
  filter?: (row: TeamCase) => boolean,
): NumericMetric {
  const selected = filter ? rows.filter(filter) : rows;
  const errors = selected.map((row) => row.predictions[arm][field] - (field === "xg" ? row.actualXg : row.actualCleanSheet));
  const brier = mean(errors.map((error) => error * error));
  return {
    n: selected.length,
    rmse: Math.sqrt(brier),
    bias: mean(errors),
    ...(field === "cleanSheet" ? { brier } : {}),
  };
}

interface ClusterSummary {
  key: string;
  season: string;
  gameweek: number;
  playerN: number;
  playerSse: Record<ArmName, number>;
  teamN: number;
  teamXgSse: Record<ArmName, number>;
  teamCsSse: Record<ArmName, number>;
}

function clusterSummaries(seasonLabel: string, playerRows: readonly PlayerCase[], teamRows: readonly TeamCase[]): ClusterSummary[] {
  const gameweeks = new Set([...playerRows.map((row) => row.gameweek), ...teamRows.map((row) => row.gameweek)]);
  return [...gameweeks].sort((a, b) => a - b).map((gameweek) => {
    const players = playerRows.filter((row) => row.gameweek === gameweek);
    const teams = teamRows.filter((row) => row.gameweek === gameweek);
    const playerSse = {} as Record<ArmName, number>;
    const teamXgSse = {} as Record<ArmName, number>;
    const teamCsSse = {} as Record<ArmName, number>;
    for (const arm of ARM_NAMES) {
      playerSse[arm] = players.reduce((sum, row) => sum + (row.predictions[arm] - row.actual) ** 2, 0);
      teamXgSse[arm] = teams.reduce((sum, row) => sum + (row.predictions[arm].xg - row.actualXg) ** 2, 0);
      teamCsSse[arm] = teams.reduce((sum, row) => sum + (row.predictions[arm].cleanSheet - row.actualCleanSheet) ** 2, 0);
    }
    return {
      key: `${seasonLabel}:gw${gameweek}`,
      season: seasonLabel,
      gameweek,
      playerN: players.length,
      playerSse,
      teamN: teams.length,
      teamXgSse,
      teamCsSse,
    };
  });
}

interface PairedInterval {
  point: number;
  ci95: [number, number];
  winRate: number;
}

type ClusterField = "playerSse" | "teamXgSse" | "teamCsSse";

function clusteredPairedInterval(
  clusters: readonly ClusterSummary[],
  arm: ArmName,
  field: ClusterField,
  baseline: ArmName,
  seedKey: string,
): PairedInterval {
  const eligible = clusters.filter((cluster) => (cluster[field] as Record<ArmName, number>)[arm] !== undefined);
  const countField = field === "playerSse" ? "playerN" : "teamN";
  const score = (sample: readonly ClusterSummary[], selectedArm: ArmName): number => {
    const sum = sample.reduce((total, cluster) => total + (cluster[field] as Record<ArmName, number>)[selectedArm], 0);
    const count = sample.reduce((total, cluster) => total + cluster[countField], 0);
    return count > 0
      ? field === "teamCsSse" ? sum / count : Math.sqrt(sum / count)
      : 0;
  };
  const point = score(eligible, arm) - score(eligible, baseline);
  const random = randomGenerator(stableSeed(seedKey));
  const draws: number[] = [];
  for (let draw = 0; draw < BOOTSTRAP_DRAWS; draw += 1) {
    const sample: ClusterSummary[] = [];
    for (let index = 0; index < eligible.length; index += 1) {
      sample.push(eligible[Math.floor(random() * eligible.length)]);
    }
    draws.push(score(sample, arm) - score(sample, baseline));
  }
  draws.sort((a, b) => a - b);
  const lower = draws[Math.floor(BOOTSTRAP_DRAWS * 0.025)] ?? point;
  const upper = draws[Math.floor(BOOTSTRAP_DRAWS * 0.975)] ?? point;
  return {
    point,
    ci95: [lower, upper],
    winRate: draws.filter((value) => value < 0).length / Math.max(draws.length, 1),
  };
}

interface ArmSummary {
  xP: NumericMetric;
  xPByPosition: Record<Position, NumericMetric>;
  teamXg: NumericMetric;
  cleanSheet: NumericMetric;
  pairedToStatic: {
    xP: PairedInterval;
    teamXg: PairedInterval;
    cleanSheet: PairedInterval;
  };
  slices: Record<SliceName, {
    xP: NumericMetric;
    teamXg: NumericMetric;
    cleanSheet: NumericMetric;
  }>;
}

function inSlice(gameweek: number, slice: SliceName): boolean {
  const [minimum, maximum] = SLICE_BOUNDS[slice];
  return gameweek >= minimum && gameweek <= maximum;
}

function summarizeArms(seasonLabel: string, playerRows: readonly PlayerCase[], teamRows: readonly TeamCase[]): Record<ArmName, ArmSummary> {
  const clusters = clusterSummaries(seasonLabel, playerRows, teamRows);
  const positions: Position[] = ["GK", "DEF", "MID", "FWD"];
  const result = {} as Record<ArmName, ArmSummary>;
  for (const arm of ARM_NAMES) {
    const xPByPosition = {} as Record<Position, NumericMetric>;
    for (const position of positions) xPByPosition[position] = playerMetric(playerRows, arm, (row) => row.position === position);
    const slices = {} as Record<SliceName, { xP: NumericMetric; teamXg: NumericMetric; cleanSheet: NumericMetric }>;
    for (const slice of SLICE_NAMES) {
      slices[slice] = {
        xP: playerMetric(playerRows, arm, (row) => inSlice(row.gameweek, slice)),
        teamXg: teamMetric(teamRows, arm, "xg", (row) => inSlice(row.gameweek, slice)),
        cleanSheet: teamMetric(teamRows, arm, "cleanSheet", (row) => inSlice(row.gameweek, slice)),
      };
    }
    result[arm] = {
      xP: playerMetric(playerRows, arm),
      xPByPosition,
      teamXg: teamMetric(teamRows, arm, "xg"),
      cleanSheet: teamMetric(teamRows, arm, "cleanSheet"),
      pairedToStatic: {
        xP: clusteredPairedInterval(clusters, arm, "playerSse", "static", `${seasonLabel}:xp:${arm}`),
        teamXg: clusteredPairedInterval(clusters, arm, "teamXgSse", "static", `${seasonLabel}:xg:${arm}`),
        cleanSheet: clusteredPairedInterval(clusters, arm, "teamCsSse", "static", `${seasonLabel}:cs:${arm}`),
      },
      slices,
    };
  }
  return result;
}

function cloneWithFutureMutation(season: Season, cutoff: number): Season {
  const fixtures = season.fixtures.map((fixture) => fixture.gameweek >= cutoff
    ? {
        ...fixture,
        homeXg: fixture.homeXg + 7.123,
        awayXg: fixture.awayXg + 11.456,
        homeGoals: fixture.homeGoals + 3,
        awayGoals: fixture.awayGoals + 2,
      }
    : fixture);
  const mutateRow = (row: MatchRow): MatchRow => row.gameweek >= cutoff
    ? {
        ...row,
        expectedGoals: row.expectedGoals + 0.731,
        expectedAssists: row.expectedAssists + 0.419,
        totalPoints: row.totalPoints + 5,
      }
    : row;
  const rowsByGameweek = new Map([...season.rowsByGameweek].map(([gameweek, rows]) => [gameweek, rows.map(mutateRow)]));
  const rowsByPlayer = new Map<number, MatchRow[]>();
  for (const [playerId, rows] of season.rowsByPlayer) rowsByPlayer.set(playerId, rows.map(mutateRow));
  const fixturesByGameweek = new Map<number, Fixture[]>();
  for (const fixture of fixtures) {
    (fixturesByGameweek.get(fixture.gameweek) ?? fixturesByGameweek.set(fixture.gameweek, []).get(fixture.gameweek)!).push(fixture);
  }
  return { ...season, fixtures, fixturesByGameweek, rowsByGameweek, rowsByPlayer };
}

interface PrefixCheck {
  cutoffGameweek: number;
  changedFutureFixtures: number;
  changedFutureRows: number;
  predictionsCompared: number;
  maxStrengthGap: number;
  maxXpGap: number;
  passed: boolean;
}

function prefixInvarianceCheck(season: Season): PrefixCheck {
  const cutoff = 20;
  const mutated = cloneWithFutureMutation(season, cutoff);
  const originalFixtureMap = fixtureMap(season);
  const mutatedFixtureMap = fixtureMap(mutated);
  const changedFutureFixtures = season.fixtures.filter((fixture) => fixture.gameweek >= cutoff).length;
  const changedFutureRows = [...season.rowsByGameweek.entries()]
    .filter(([gameweek]) => gameweek >= cutoff)
    .reduce((sum, [, rows]) => sum + rows.length, 0);
  let maxStrengthGap = 0;
  let maxXpGap = 0;
  let predictionsCompared = 0;
  const gap = (left: number, right: number) => Math.abs(left - right);
  for (let gameweek = FIRST_GAMEWEEK; gameweek < cutoff; gameweek += 1) {
    const originalBundle = strengthsForGameweek(season, gameweek);
    const mutatedBundle = strengthsForGameweek(mutated, gameweek);
    for (const arm of ARM_NAMES) {
      const left = originalBundle.byArm[arm];
      const right = mutatedBundle.byArm[arm];
      for (const teamId of Object.keys(left).map(Number)) {
        maxStrengthGap = Math.max(
          maxStrengthGap,
          gap(left[teamId].attackHome, right[teamId].attackHome),
          gap(left[teamId].defenceHome, right[teamId].defenceHome),
        );
      }
    }
    const originalRows = season.rowsByGameweek.get(gameweek) ?? [];
    for (const row of originalRows) {
      if (row.minutes <= 0) continue;
      const fixture = originalFixtureMap.get(row.fixtureId);
      const mutatedFixture = mutatedFixtureMap.get(row.fixtureId);
      if (!fixture || !mutatedFixture) continue;
      const originalPlayer = playerForFixtureRow(season, row, fixture, gameweek);
      const mutatedPlayer = playerForFixtureRow(mutated, row, mutatedFixture, gameweek);
      if (!originalPlayer || !mutatedPlayer) continue;
      const form = contextualFormBefore(season, row.historicalPlayerId, gameweek);
      const mutatedForm = contextualFormBefore(mutated, row.historicalPlayerId, gameweek);
      for (const arm of ARM_NAMES) {
        const originalProjection = projectPlayer(originalPlayer, {
          currentGameweek: gameweek,
          horizon: 1,
          teamStrengths: originalBundle.byArm[arm],
          playerForm: { [originalPlayer.id]: form },
          expectedMinutes: row.minutes,
        });
        const mutatedProjection = projectPlayer(mutatedPlayer, {
          currentGameweek: gameweek,
          horizon: 1,
          teamStrengths: mutatedBundle.byArm[arm],
          playerForm: { [mutatedPlayer.id]: mutatedForm },
          expectedMinutes: row.minutes,
        });
        const left = originalProjection.fixtures[0]?.expectedPoints;
        const right = mutatedProjection.fixtures[0]?.expectedPoints;
        if (left !== undefined && right !== undefined) {
          maxXpGap = Math.max(maxXpGap, gap(left, right));
          predictionsCompared += 1;
        }
      }
    }
  }
  return {
    cutoffGameweek: cutoff,
    changedFutureFixtures,
    changedFutureRows,
    predictionsCompared,
    maxStrengthGap,
    maxXpGap,
    passed: changedFutureFixtures > 0 && changedFutureRows > 0 && maxStrengthGap < 1e-10 && maxXpGap < 1e-10,
  };
}

interface ParityCheck {
  rowsCompared: number;
  strengthsCompared: number;
  worstStrengthGap: number;
  worstTotalGap: number;
  worstComponentGap: number;
  passed: boolean;
}

function baselineParityCheck(season: Season): ParityCheck {
  let rowsCompared = 0;
  let strengthsCompared = 0;
  let worstStrengthGap = 0;
  let worstTotalGap = 0;
  let worstComponentGap = 0;
  const byFixture = fixtureMap(season);
  for (let gameweek = FIRST_GAMEWEEK; gameweek <= LAST_GAMEWEEK; gameweek += 1) {
    const direct = staticStrengthsFromProduction(season, gameweek);
    const wrapper = strengthsBefore(season, gameweek);
    for (const teamId of Object.keys(direct).map(Number)) {
      const left = direct[teamId];
      const right = wrapper[teamId];
      if (!right) continue;
      strengthsCompared += 1;
      worstStrengthGap = Math.max(
        worstStrengthGap,
        Math.abs(left.attackHome - right.attackHome),
        Math.abs(left.defenceHome - right.defenceHome),
      );
    }
    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = byFixture.get(row.fixtureId);
      if (!fixture) continue;
      const player = playerForFixtureRow(season, row, fixture, gameweek);
      if (!player) continue;
      const form = formBefore(season, row.historicalPlayerId, gameweek);
      const real = projectPlayer(player, {
        currentGameweek: gameweek,
        horizon: 1,
        teamStrengths: wrapper,
        playerForm: { [player.id]: form },
        expectedMinutes: row.minutes,
      });
      const components = real.fixtures[0]?.components;
      if (!components) continue;
      const mine = expectedPoints(
        player,
        player.fixtures[0],
        row.minutes,
        playerRates(player, form, gameweek, undefined, wrapper),
        wrapper,
        BASELINE,
      );
      rowsCompared += 1;
      worstTotalGap = Math.max(worstTotalGap, Math.abs(mine.total - components.total));
      for (const key of Object.keys(mine) as (keyof typeof mine)[]) {
        worstComponentGap = Math.max(worstComponentGap, Math.abs(mine[key] - components[key]));
      }
    }
  }
  return {
    rowsCompared,
    strengthsCompared,
    worstStrengthGap,
    worstTotalGap,
    worstComponentGap,
    passed: rowsCompared > 0 && strengthsCompared > 0
      && worstStrengthGap < 1e-10 && worstTotalGap < 1e-9 && worstComponentGap < 1e-9,
  };
}

interface SingleSeasonResult {
  season: string;
  role: "historical target" | "latest confirmation";
  hasPreparedPriors: boolean;
  gameweeks: { first: number; last: number; count: number };
  rows: { player: number; teamFixture: number };
  teamIdentityMismatches: number;
  baselineParity: ParityCheck;
  prefixInvariance: PrefixCheck;
  jointConvergence: {
    fits: number;
    converged: number;
    nonConverged: number;
    maxIterations: number;
    maxGradientNorm: number;
    meanBacktracks: number;
    effectiveMatchesPerTeam: number;
    regularizationMatches: number;
  };
  arms: Record<ArmName, ArmSummary>;
  clusters: ClusterSummary[];
}

function singleSeasonLabel(): string {
  return process.env.OPPONENT_ADJUSTMENT_SEASON
    ?? path.basename(process.env.BACKTEST_DATA_DIR ?? "season");
}

function runSingleSeason(): SingleSeasonResult {
  const season = loadSeason();
  if (!season.hasPreparedPriors) {
    throw new Error("opponent-adjustment requires prepared previous-season priors; run scripts/backtest/prepare-seasons.ts first");
  }
  const label = singleSeasonLabel();
  const cases = runCases(season);
  const gameweeks = [...cases.strengthsByGameweek.keys()].sort((a, b) => a - b);
  const diagnostics = [...cases.strengthsByGameweek.values()].map((bundle) => bundle.joint);
  const parity = baselineParityCheck(season);
  const prefix = prefixInvarianceCheck(season);
  const converged = diagnostics.filter((item) => item.converged).length;
  if (!parity.passed) {
    throw new Error(`baseline parity failed for ${label}: ${JSON.stringify(parity)}`);
  }
  if (!prefix.passed) {
    throw new Error(`prefix invariance failed for ${label}: ${JSON.stringify(prefix)}`);
  }
  if (converged !== diagnostics.length) {
    throw new Error(`joint fit did not converge for ${label}: ${JSON.stringify({ diagnostics, converged })}`);
  }
  return {
    season: label,
    role: label === "2025-26" ? "latest confirmation" : "historical target",
    hasPreparedPriors: season.hasPreparedPriors,
    gameweeks: { first: gameweeks[0] ?? 0, last: gameweeks.at(-1) ?? 0, count: gameweeks.length },
    rows: { player: cases.playerCases.length, teamFixture: cases.teamCases.length },
    teamIdentityMismatches: cases.teamIdentityMismatches,
    baselineParity: parity,
    prefixInvariance: prefix,
    jointConvergence: {
      fits: diagnostics.length,
      converged,
      nonConverged: diagnostics.length - converged,
      maxIterations: Math.max(...diagnostics.map((item) => item.iterations), 0),
      maxGradientNorm: Math.max(...diagnostics.map((item) => item.gradientNorm), 0),
      meanBacktracks: mean(diagnostics.map((item) => item.lineSearchBacktracks)),
      effectiveMatchesPerTeam: mean(diagnostics.map((item) => item.effectiveMatchesPerTeam)),
      regularizationMatches: JOINT_REGULARIZATION,
    },
    arms: summarizeArms(label, cases.playerCases, cases.teamCases),
    clusters: clusterSummaries(label, cases.playerCases, cases.teamCases),
  };
}

function aggregateClusters(results: readonly SingleSeasonResult[]): ClusterSummary[] {
  return results.flatMap((result) => result.clusters);
}

function aggregateMetric(clusters: readonly ClusterSummary[], arm: ArmName, field: ClusterField): NumericMetric {
  const countField = field === "playerSse" ? "playerN" : "teamN";
  const sum = clusters.reduce((total, cluster) => total + (cluster[field] as Record<ArmName, number>)[arm], 0);
  const n = clusters.reduce((total, cluster) => total + cluster[countField], 0);
  const score = n > 0 ? sum / n : 0;
  return {
    n,
    rmse: field === "teamCsSse" ? Math.sqrt(score) : score ** 0.5,
    bias: 0,
    ...(field === "teamCsSse" ? { brier: score } : {}),
  };
}

function weightedBias(metrics: readonly NumericMetric[]): number {
  const n = metrics.reduce((sum, metric) => sum + metric.n, 0);
  return n > 0 ? metrics.reduce((sum, metric) => sum + metric.n * metric.bias, 0) / n : 0;
}

interface AggregateResult {
  seasons: SingleSeasonResult[];
  pooled: {
    rows: { player: number; teamFixture: number };
    arms: Record<ArmName, ArmSummary>;
    pairedToStatic: Record<ArmName, { xP: PairedInterval; teamXg: PairedInterval; cleanSheet: PairedInterval }>;
    slices: Record<SliceName, Record<ArmName, { xP: NumericMetric; teamXg: NumericMetric; cleanSheet: NumericMetric }>>;
    rankingByXpRmse: ArmName[];
  };
  method: {
    control: string;
    baseline: string;
    chronological: string;
    retrospective: string;
    joint: string;
    constants: { decay: number; priorWeight: number; jointRegularization: number; bootstrapDraws: number };
    latestSeasonNote: string;
  };
}

function aggregateResults(results: SingleSeasonResult[]): AggregateResult {
  const clusters = aggregateClusters(results);
  const rows = {
    player: results.reduce((sum, result) => sum + result.rows.player, 0),
    teamFixture: results.reduce((sum, result) => sum + result.rows.teamFixture, 0),
  };
  const arms = {} as Record<ArmName, ArmSummary>;
  const pairedToStatic = {} as Record<ArmName, { xP: PairedInterval; teamXg: PairedInterval; cleanSheet: PairedInterval }>;
  for (const arm of ARM_NAMES) {
    const xP = { ...aggregateMetric(clusters, arm, "playerSse"), bias: weightedBias(results.map((result) => result.arms[arm].xP)) };
    const teamXg = { ...aggregateMetric(clusters, arm, "teamXgSse"), bias: weightedBias(results.map((result) => result.arms[arm].teamXg)) };
    const cleanSheet = { ...aggregateMetric(clusters, arm, "teamCsSse"), bias: weightedBias(results.map((result) => result.arms[arm].cleanSheet)) };
    const xPByPosition = {} as Record<Position, NumericMetric>;
    for (const position of ["GK", "DEF", "MID", "FWD"] as const) {
      const selected = results.flatMap((result) => {
        // Position-specific pooled errors are recomputed from the retained
        // season summaries' source rows only when they are already available;
        // aggregate summaries expose the per-season split below.
        return result.arms[arm].xPByPosition[position].n > 0
          ? [result.arms[arm].xPByPosition[position]]
          : [];
      });
      const count = selected.reduce((sum, metric) => sum + metric.n, 0);
      const squared = selected.reduce((sum, metric) => sum + metric.n * metric.rmse ** 2, 0);
      const bias = count > 0 ? selected.reduce((sum, metric) => sum + metric.n * metric.bias, 0) / count : 0;
      xPByPosition[position] = { n: count, rmse: count > 0 ? Math.sqrt(squared / count) : 0, bias };
    }
    const slices = {} as Record<SliceName, { xP: NumericMetric; teamXg: NumericMetric; cleanSheet: NumericMetric }>;
    for (const slice of SLICE_NAMES) {
      const sliceClusters = clusters.filter((cluster) => inSlice(cluster.gameweek, slice));
      slices[slice] = {
        xP: {
          ...aggregateMetric(sliceClusters, arm, "playerSse"),
          bias: weightedBias(results.map((result) => result.arms[arm].slices[slice].xP)),
        },
        teamXg: {
          ...aggregateMetric(sliceClusters, arm, "teamXgSse"),
          bias: weightedBias(results.map((result) => result.arms[arm].slices[slice].teamXg)),
        },
        cleanSheet: {
          ...aggregateMetric(sliceClusters, arm, "teamCsSse"),
          bias: weightedBias(results.map((result) => result.arms[arm].slices[slice].cleanSheet)),
        },
      };
    }
    arms[arm] = {
      xP,
      xPByPosition,
      teamXg,
      cleanSheet,
      pairedToStatic: {
        xP: clusteredPairedInterval(clusters, arm, "playerSse", "static", `pooled:xp:${arm}`),
        teamXg: clusteredPairedInterval(clusters, arm, "teamXgSse", "static", `pooled:xg:${arm}`),
        cleanSheet: clusteredPairedInterval(clusters, arm, "teamCsSse", "static", `pooled:cs:${arm}`),
      },
      slices,
    };
    pairedToStatic[arm] = arms[arm].pairedToStatic;
  }
  const rankingByXpRmse = [...ARM_NAMES].sort((a, b) => arms[a].xP.rmse - arms[b].xP.rmse);
  const pooledSlices = {} as Record<SliceName, Record<ArmName, { xP: NumericMetric; teamXg: NumericMetric; cleanSheet: NumericMetric }>>;
  for (const slice of SLICE_NAMES) {
    pooledSlices[slice] = {} as Record<ArmName, { xP: NumericMetric; teamXg: NumericMetric; cleanSheet: NumericMetric }>;
    for (const arm of ARM_NAMES) pooledSlices[slice][arm] = arms[arm].slices[slice];
  }
  return {
    seasons: results,
    pooled: { rows, arms, pairedToStatic, slices: pooledSlices, rankingByXpRmse },
    method: {
      baseline: "static: applyInSeasonForm(prior, past history carrying opponentTeamId and wasHome); opponent in each past observation is the preseason prior",
      control: "none: applyInSeasonForm(prior, raw past xG with no opponentTeamId), so current form updates while schedule adjustment is omitted",
      chronological: "for each completed past GW, schedule-adjust all of its fixtures with the opponent ratings available before that GW, then update once after the GW; target GW is never processed",
      retrospective: "at each target cutoff, take the static production strength table built from prior GWs, rescore every past fixture with that fixed current table, then blend against the unchanged preseason anchor",
      joint: "regularized Poisson pseudo-likelihood for observed home/away xG: lambda_home=mu*1.102*exp(attack_home-defence_away), lambda_away=mu*0.898*exp(attack_away-defence_home); attack/defence log-strengths are separately zero-centered, recency decay=.90 is normalized per team to effective n, and each is penalized toward its prior with 12 match weight; fit uses only fixtures before target GW",
      constants: { decay: FORM_DECAY, priorWeight: PRIOR_WEIGHT, jointRegularization: JOINT_REGULARIZATION, bootstrapDraws: BOOTSTRAP_DRAWS },
      latestSeasonNote: "2025-26 is reported as confirmation rather than pristine holdout because shipped production coefficients were already calibrated against that season; earlier prepared seasons are the cleaner target-season evidence.",
    },
  };
}

function printMetric(metric: NumericMetric): string {
  return `${metric.rmse.toFixed(5)} (n=${metric.n})`;
}

function printAggregate(report: AggregateResult): void {
  console.log(`opponent-adjustment: ${report.seasons.map((result) => result.season).join(", ")}`);
  console.log("pooled actual-minutes xP RMSE (lower is better)");
  for (const arm of report.pooled.rankingByXpRmse) {
    const result = report.pooled.arms[arm];
    const ci = result.pairedToStatic.xP;
    console.log(`  ${arm.padEnd(14)} ${printMetric(result.xP)}  d(static)=${ci.point.toFixed(5)} [${ci.ci95[0].toFixed(5)}, ${ci.ci95[1].toFixed(5)}]  bootstrap-win=${(ci.winRate * 100).toFixed(1)}%`);
  }
  console.log("pooled team diagnostics (RMSE; clean-sheet Brier)");
  for (const arm of ARM_NAMES) {
    const result = report.pooled.arms[arm];
    console.log(`  ${arm.padEnd(14)} xG ${printMetric(result.teamXg)}  CS ${(result.cleanSheet.brier ?? 0).toFixed(5)} (n=${result.cleanSheet.n})`);
  }
  console.log(`best pooled xP RMSE: ${report.pooled.rankingByXpRmse[0]}`);
  for (const result of report.seasons) {
    console.log(`${result.season}: player rows ${result.rows.player}, team-fixtures ${result.rows.teamFixture}, parity=${result.baselineParity.passed ? "PASS" : "FAIL"}, prefix=${result.prefixInvariance.passed ? "PASS" : "FAIL"}, joint convergence=${result.jointConvergence.converged}/${result.jointConvergence.fits}`);
  }
}

function parseSingleResult(output: string): SingleSeasonResult {
  const line = output.trim().split("\n").at(-1);
  if (!line) throw new Error("single-season child returned no JSON");
  return JSON.parse(line) as SingleSeasonResult;
}

function preparedSeasonDirectories(): { season: string; directory: string }[] {
  const roots = process.env.BACKTEST_MULTI_DATA_DIR
    ? [process.env.BACKTEST_MULTI_DATA_DIR]
    : [path.join("/tmp", "fpl-opponent-adjustment-data"), path.join("/tmp", "fpl-backtest-seasons")];
  const seasons = ["2023-24", "2024-25", "2025-26"];
  return seasons.flatMap((season) => {
    const directory = roots.map((root) => path.join(root, season)).find((candidate) =>
      existsSync(path.join(candidate, "historical-match-stats.json"))
      && existsSync(path.join(candidate, "preseason-team-strength.json"))
      && existsSync(path.join(candidate, "previous-player-anchors.json")));
    return directory ? [{ season, directory }] : [];
  });
}

function runAllSeasons(): void {
  const directories = preparedSeasonDirectories();
  if (directories.length < 2) {
    throw new Error("need at least two prepared seasons; run BACKTEST_MULTI_DATA_DIR=/tmp/fpl-backtest-seasons npx tsx scripts/backtest/prepare-seasons.ts");
  }
  const script = fileURLToPath(import.meta.url);
  const results: SingleSeasonResult[] = [];
  for (const item of directories) {
    const environment = {
      ...process.env,
      BACKTEST_DATA_DIR: item.directory,
      OPPONENT_ADJUSTMENT_SEASON: item.season,
      OPPONENT_ADJUSTMENT_SINGLE: "1",
    };
    const child = spawnSync("npx", ["tsx", script, "--single"], {
      cwd: path.resolve(path.dirname(script), "../.."),
      env: environment,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (child.status !== 0) {
      throw new Error(`season ${item.season} failed:\n${child.stderr || child.stdout}`);
    }
    results.push(parseSingleResult(child.stdout));
  }
  const report = aggregateResults(results);
  const outputDirectory = path.join(path.dirname(script), "results");
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, "opponent-adjustment.json");
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  printAggregate(report);
}

function main(): void {
  if (process.argv.includes("--single") || process.env.OPPONENT_ADJUSTMENT_SINGLE === "1") {
    process.stdout.write(`${JSON.stringify(runSingleSeason())}\n`);
    return;
  }
  runAllSeasons();
}

main();
