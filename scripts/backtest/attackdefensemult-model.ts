/** Pure math for the ClubElo attack/defence multiplier experiment. */

export type DifficultyCurve = readonly [number, number, number, number, number];
export type CurveDirection = "decreasing" | "increasing";
export type RawEloRestriction = "full" | "gap-only" | "elo-only";

export const BASELINE_ATTACK_CURVE: DifficultyCurve = [1.14, 1.07, 1, 0.92, 0.84];
export const FLAT_CONCEDED_CURVE: DifficultyCurve = [1, 1, 1, 1, 1];
export const DEFAULT_REGULARIZATION_GRID = [0.01, 0.1, 1] as const;
export const CLUB_ELO_REFERENCE_SCALE = 100;
export const ATTACK_RATIO_BOUNDS = [0.7, 1.35] as const;
export const ATTACK_MULTIPLIER_BOUNDS = [0.55, 1.6] as const;
export const DEFAULT_CLEAN_SHEET_DISPERSION = 12;
export const CLEAN_SHEET_PROBABILITY_BOUNDS = [0.02, 0.9] as const;
export const DEFAULT_LEAGUE_MEAN_XG = 1.408;
export const HOME_ATTACKING_FACTOR = 1.102;
export const AWAY_ATTACKING_FACTOR = 0.898;

export interface ClubEloPoint {
  date: string;
  elo: number;
}

function dayNumber(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid ISO date: ${date}`);
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
  return value / 86_400_000;
}

/** Latest rating strictly before cutoff; chart events on cutoff day are post-match. */
export function latestStrictlyPriorElo(
  points: readonly ClubEloPoint[],
  cutoffDate: string,
): { date: string; elo: number; daysLag: number } | undefined {
  const cutoff = dayNumber(cutoffDate);
  let previousDate = "";
  let selected: ClubEloPoint | undefined;
  for (const point of points) {
    dayNumber(point.date);
    if (point.date <= previousDate) throw new Error("ClubElo points must have unique, increasing dates.");
    if (!Number.isFinite(point.elo) || point.elo < 700 || point.elo > 2500) throw new Error(`Invalid ClubElo value on ${point.date}.`);
    previousDate = point.date;
    if (point.date < cutoffDate) selected = point;
  }
  return selected ? { ...selected, daysLag: cutoff - dayNumber(selected.date) } : undefined;
}

/** Poisson quasi-deviance for nonnegative real xG, with the y=0 limit handled exactly. */
export function poissonQuasiDeviance(observed: number, mean: number): number {
  if (!Number.isFinite(observed) || observed < 0) throw new Error("Observed xG must be finite and nonnegative.");
  if (!Number.isFinite(mean) || mean <= 0) throw new Error("Predicted xG mean must be finite and positive.");
  return 2 * (observed === 0 ? mean : observed * Math.log(observed / mean) - observed + mean);
}

export function validateDifficultyCurve(curve: DifficultyCurve, direction: CurveDirection): void {
  if (!Array.isArray(curve) || curve.length !== 5 || curve.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("A difficulty curve must contain five finite positive knot values.");
  }
  if (curve[2] !== 1) throw new Error("A difficulty curve must be anchored at difficulty 3 with value 1.");
  for (let index = 1; index < curve.length; index += 1) {
    if (direction === "decreasing" ? curve[index] > curve[index - 1] : curve[index] < curve[index - 1]) {
      throw new Error(`Difficulty curve must be monotone ${direction}.`);
    }
  }
}

export function evaluateDifficultyCurve(curve: DifficultyCurve, difficulty: number): number {
  if (!Array.isArray(curve) || curve.length !== 5 || curve.some((value) => !Number.isFinite(value) || value <= 0)
    || curve[2] !== 1) {
    throw new Error("A difficulty curve must contain five finite positive knots and be anchored at difficulty 3.");
  }
  const decreasing = curve.every((value, index) => index === 0 || value <= curve[index - 1]);
  const increasing = curve.every((value, index) => index === 0 || value >= curve[index - 1]);
  if (!decreasing && !increasing) throw new Error("Difficulty curve must be monotone.");
  if (!Number.isFinite(difficulty)) throw new Error("Difficulty must be finite.");
  const x = clamp(difficulty, 1, 5) - 1;
  const lower = Math.min(3, Math.floor(x));
  const fraction = x - lower;
  return curve[lower] * (1 - fraction) + curve[lower + 1] * fraction;
}

export interface AttackDefenseModelInputs {
  difficulty: number;
  ownElo: number;
  opponentElo: number;
  /** Production-clamped own attack / opponent defence ratio. */
  attackRatio: number;
  /** Elo-levelled opponent attack / own defence ratio. */
  ratedConcedingRatio: number;
  isHome: boolean;
  leagueMeanXg?: number;
}

export interface AttackDefenseFitRow extends AttackDefenseModelInputs {
  leagueMeanXg: number;
  season: string;
  gameweek: number;
  fixtureId: string | number;
  observedAttackXg: number;
  observedConcededXg: number;
}

export interface CurveModelParameters {
  attackCurve: DifficultyCurve;
  attackRatioExponent: number;
  concededCurve: DifficultyCurve;
  concededRatioExponent: number;
}

export interface RawEloEquationParameters {
  /** Coefficients on own and opponent Elo after centering/scaling. */
  ownEloCoefficient: number;
  opponentEloCoefficient: number;
  ratioExponent: number;
}

export interface RawEloModelParameters {
  restriction: RawEloRestriction;
  attack: RawEloEquationParameters;
  conceded: RawEloEquationParameters;
}

export type AttackDefenseModel =
  | {
    family: "baseline";
    parameters: CurveModelParameters;
    regularizationId: "none";
    regularization: 0;
    fitReferenceElo: null;
  }
  | {
    family: "curve";
    parameters: CurveModelParameters;
    regularizationId: string;
    regularization: number;
    fitReferenceElo: null;
  }
  | {
    family: "rawElo";
    parameters: RawEloModelParameters;
    regularizationId: string;
    regularization: number;
    fitReferenceElo: number;
  };

export const BASELINE_ATTACK_DEFENSE_MODEL: AttackDefenseModel = {
  family: "baseline",
  parameters: {
    attackCurve: BASELINE_ATTACK_CURVE,
    attackRatioExponent: 1,
    concededCurve: FLAT_CONCEDED_CURVE,
    concededRatioExponent: 1,
  },
  regularizationId: "none",
  regularization: 0,
  fitReferenceElo: null,
};

export interface AttackDefenseEvaluation {
  attackMultiplier: number;
  attackMultiplierRaw: number;
  expectedGoalsAgainst: number;
  cleanSheetProbability: number;
}

function finitePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive.`);
}

function validateInputs(input: AttackDefenseModelInputs): void {
  if (!Number.isFinite(input.difficulty)) throw new Error("Difficulty must be finite.");
  if (!Number.isFinite(input.ownElo) || !Number.isFinite(input.opponentElo)) throw new Error("Finite own and opponent Elo ratings are required.");
  if (typeof input.isHome !== "boolean") throw new Error("Fixture venue must be home or away.");
  for (const [name, value] of Object.entries({
    leagueMeanXg: input.leagueMeanXg ?? DEFAULT_LEAGUE_MEAN_XG,
    attackRatio: input.attackRatio,
    ratedConcedingRatio: input.ratedConcedingRatio,
  })) finitePositive(name, value);
  if (input.attackRatio < ATTACK_RATIO_BOUNDS[0] || input.attackRatio > ATTACK_RATIO_BOUNDS[1]) {
    throw new Error("Attack ratio must already be clamped to the production bounds [0.70, 1.35].");
  }
}

function validateRawEquation(value: RawEloEquationParameters): void {
  if (!Number.isFinite(value.ownEloCoefficient) || value.ownEloCoefficient < 0 || value.ownEloCoefficient > RAW_ELO_COEFFICIENT_BOUNDS[1]
    || !Number.isFinite(value.opponentEloCoefficient) || value.opponentEloCoefficient < 0 || value.opponentEloCoefficient > RAW_ELO_COEFFICIENT_BOUNDS[1]
    || !Number.isFinite(value.ratioExponent) || value.ratioExponent < 0 || value.ratioExponent > RATIO_EXPONENT_BOUNDS[1]) {
    throw new Error("Raw Elo coefficients and ratio exponents are outside their fit bounds.");
  }
}

export function negativeBinomialCleanSheetProbability(mean: number, dispersion = DEFAULT_CLEAN_SHEET_DISPERSION): number {
  finitePositive("Goals-conceded mean", mean);
  finitePositive("Negative-binomial dispersion", dispersion);
  const probability = Math.pow(dispersion / (dispersion + mean), dispersion);
  return clamp(probability, CLEAN_SHEET_PROBABILITY_BOUNDS[0], CLEAN_SHEET_PROBABILITY_BOUNDS[1]);
}

/** Evaluates baseline, fitted-curve, or raw-Elo formulas with production clamps and NB clean sheets. */
export function evaluateAttackDefenseModel(
  model: AttackDefenseModel,
  input: AttackDefenseModelInputs,
  dispersion = DEFAULT_CLEAN_SHEET_DISPERSION,
): AttackDefenseEvaluation {
  validateInputs(input);
  const leagueMeanXg = input.leagueMeanXg ?? DEFAULT_LEAGUE_MEAN_XG;
  const attackVenue = input.isHome ? HOME_ATTACKING_FACTOR : AWAY_ATTACKING_FACTOR;
  const opponentVenue = input.isHome ? AWAY_ATTACKING_FACTOR : HOME_ATTACKING_FACTOR;
  let attackMultiplierRaw: number;
  let attackMultiplier: number;
  let expectedGoalsAgainst: number;
  if (model.family === "rawElo") {
    const { attack, conceded, restriction } = model.parameters;
    validateRawEquation(attack);
    validateRawEquation(conceded);
    if (restriction === "gap-only"
      && (attack.ownEloCoefficient !== attack.opponentEloCoefficient
        || conceded.ownEloCoefficient !== conceded.opponentEloCoefficient)) {
      throw new Error("Gap-only raw Elo coefficients must be tied.");
    }
    if (restriction === "elo-only" && (attack.ratioExponent !== 0 || conceded.ratioExponent !== 0)) {
      throw new Error("Elo-only raw Elo models must omit the team-strength ratio.");
    }
    const own = (input.ownElo - model.fitReferenceElo) / CLUB_ELO_REFERENCE_SCALE;
    const opponent = (input.opponentElo - model.fitReferenceElo) / CLUB_ELO_REFERENCE_SCALE;
    const attackLog = attack.ownEloCoefficient * own - attack.opponentEloCoefficient * opponent
      + attack.ratioExponent * Math.log(input.attackRatio) + Math.log(attackVenue);
    const concededLog = conceded.opponentEloCoefficient * opponent - conceded.ownEloCoefficient * own
      + conceded.ratioExponent * Math.log(input.ratedConcedingRatio) + Math.log(opponentVenue);
    attackMultiplierRaw = Math.exp(attackLog);
    attackMultiplier = clamp(attackMultiplierRaw, ATTACK_MULTIPLIER_BOUNDS[0], ATTACK_MULTIPLIER_BOUNDS[1]);
    expectedGoalsAgainst = leagueMeanXg * Math.exp(concededLog);
  } else {
    validateDifficultyCurve(model.parameters.attackCurve, "decreasing");
    validateDifficultyCurve(model.parameters.concededCurve, "increasing");
    if ([...model.parameters.attackCurve, ...model.parameters.concededCurve].some((value) => value < CURVE_MULTIPLIER_BOUNDS[0] || value > CURVE_MULTIPLIER_BOUNDS[1])) {
      throw new Error("Difficulty curve knots are outside their fit bounds.");
    }
    if (!Number.isFinite(model.parameters.attackRatioExponent) || model.parameters.attackRatioExponent < RATIO_EXPONENT_BOUNDS[0]
      || model.parameters.attackRatioExponent > RATIO_EXPONENT_BOUNDS[1]
      || !Number.isFinite(model.parameters.concededRatioExponent) || model.parameters.concededRatioExponent < RATIO_EXPONENT_BOUNDS[0]
      || model.parameters.concededRatioExponent > RATIO_EXPONENT_BOUNDS[1]) {
      throw new Error("Curve ratio exponents are outside their fit bounds.");
    }
    const attackRaw = evaluateDifficultyCurve(model.parameters.attackCurve, input.difficulty)
      * attackVenue * Math.pow(input.attackRatio, model.parameters.attackRatioExponent);
    const concededRaw = evaluateDifficultyCurve(model.parameters.concededCurve, input.difficulty)
      * opponentVenue * Math.pow(input.ratedConcedingRatio, model.parameters.concededRatioExponent);
    attackMultiplierRaw = attackRaw;
    attackMultiplier = clamp(attackMultiplierRaw, ATTACK_MULTIPLIER_BOUNDS[0], ATTACK_MULTIPLIER_BOUNDS[1]);
    expectedGoalsAgainst = leagueMeanXg * concededRaw;
  }
  return {
    attackMultiplier,
    attackMultiplierRaw,
    expectedGoalsAgainst,
    cleanSheetProbability: negativeBinomialCleanSheetProbability(expectedGoalsAgainst, dispersion),
  };
}

export interface FitOptions {
  regularizationGrid?: readonly number[];
  maxIterations?: number;
  gradientTolerance?: number;
}

export interface EquationFitSummary {
  meanDeviance: number;
  objective: number;
  iterations: number;
  converged: boolean;
}

export interface CurveModelFit {
  model: Extract<AttackDefenseModel, { family: "curve" }>;
  attack: EquationFitSummary;
  conceded: EquationFitSummary;
}

export interface RawEloModelFit {
  model: Extract<AttackDefenseModel, { family: "rawElo" }>;
  attack: EquationFitSummary;
  conceded: EquationFitSummary;
}

const DEFAULT_MAX_ITERATIONS = 2000;
const DEFAULT_GRADIENT_TOLERANCE = 1e-7;
export const CURVE_MULTIPLIER_BOUNDS = [0.55, 1.6] as const;
export const RATIO_EXPONENT_BOUNDS = [0, 2] as const;
export const RAW_ELO_COEFFICIENT_BOUNDS = [0, 0.5] as const;

function validateRegularizationGrid(grid: readonly number[]): void {
  if (!grid.length || grid.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Regularization grid must contain finite nonnegative values.");
  }
  if (new Set(grid).size !== grid.length) throw new Error("Regularization grid values must be unique.");
}

function validateFitOptions(options: FitOptions): void {
  if (options.maxIterations !== undefined && (!Number.isInteger(options.maxIterations) || options.maxIterations < 1)) {
    throw new Error("Fit iteration limit must be a positive integer.");
  }
  if (options.gradientTolerance !== undefined && (!Number.isFinite(options.gradientTolerance) || options.gradientTolerance <= 0)) {
    throw new Error("Fit gradient tolerance must be finite and positive.");
  }
}

function validateTrainingRows(rows: readonly AttackDefenseFitRow[]): void {
  if (!rows.length) throw new Error("Cannot fit an empty attack/defence dataset.");
  for (const row of rows) {
    validateInputs(row);
    if (!row.season || !Number.isInteger(row.gameweek) || row.gameweek < 1) throw new Error("Fit rows need a season and positive integer gameweek.");
    if (!Number.isFinite(row.observedAttackXg) || row.observedAttackXg < 0
      || !Number.isFinite(row.observedConcededXg) || row.observedConcededXg < 0) {
      throw new Error("Observed attack/conceded xG must be finite and nonnegative.");
    }
  }
}

interface ObjectiveValue {
  value: number;
  gradient: number[];
  meanDeviance: number;
}

interface OptimizedVector {
  values: number[];
  objective: number;
  meanDeviance: number;
  iterations: number;
  converged: boolean;
}

type Projection = (values: number[]) => number[];
type Objective = (values: readonly number[]) => ObjectiveValue;

function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

/** Deterministic projected gradient descent with Armijo backtracking. */
function minimize(
  initial: readonly number[],
  objective: Objective,
  project: Projection,
  options: Required<Pick<FitOptions, "maxIterations" | "gradientTolerance">>,
): OptimizedVector {
  let values = project([...initial]);
  let current = objective(values);
  let step = 1;
  let converged = false;
  let iterations = 0;
  for (; iterations < options.maxIterations; iterations += 1) {
    if (Math.max(...current.gradient.map(Math.abs)) <= options.gradientTolerance) {
      converged = true;
      break;
    }
    let accepted = false;
    for (let backtrack = 0; backtrack < 40; backtrack += 1) {
      const next = project(values.map((value, index) => value - step * current.gradient[index]));
      const delta = next.map((value, index) => value - values[index]);
      const directional = dot(current.gradient, delta);
      if (Math.max(...delta.map(Math.abs)) <= options.gradientTolerance) {
        converged = true;
        accepted = false;
        break;
      }
      const candidate = objective(next);
      if (directional < 0 && candidate.value <= current.value + 1e-4 * directional + 1e-14) {
        values = next;
        current = candidate;
        step = Math.min(step * 1.5, 4);
        accepted = true;
        break;
      }
      step *= 0.5;
    }
    if (converged || !accepted) break;
  }
  return { values, objective: current.value, meanDeviance: current.meanDeviance, iterations, converged };
}

function curveBasis(difficulty: number): number[] {
  if (!Number.isFinite(difficulty)) throw new Error("Difficulty must be finite.");
  const x = clamp(difficulty, 1, 5) - 1;
  const lower = Math.min(3, Math.floor(x));
  const fraction = x - lower;
  const basis = [0, 0, 0, 0, 0];
  basis[lower] = 1 - fraction;
  basis[lower + 1] = fraction;
  return basis;
}

function curveFromFree(values: readonly number[]): DifficultyCurve {
  return [values[0], values[1], 1, values[2], values[3]];
}

function projectCurve(values: number[], direction: CurveDirection, exponentIndex = 4): number[] {
  const [minimum, maximum] = CURVE_MULTIPLIER_BOUNDS;
  const curve = values.slice(0, 4).map((value) => clamp(value, minimum, maximum));
  if (direction === "decreasing") {
    if (curve[0] < curve[1]) curve[0] = curve[1] = clamp((curve[0] + curve[1]) / 2, 1, maximum);
    curve[0] = Math.max(1, curve[0]);
    curve[1] = clamp(curve[1], 1, curve[0]);
    if (curve[2] < curve[3]) curve[2] = curve[3] = clamp((curve[2] + curve[3]) / 2, minimum, 1);
    curve[2] = clamp(curve[2], minimum, 1);
    curve[3] = clamp(curve[3], minimum, curve[2]);
  } else {
    if (curve[0] > curve[1]) curve[0] = curve[1] = clamp((curve[0] + curve[1]) / 2, minimum, 1);
    curve[0] = clamp(curve[0], minimum, 1);
    curve[1] = clamp(curve[1], curve[0], 1);
    if (curve[2] > curve[3]) curve[2] = curve[3] = clamp((curve[2] + curve[3]) / 2, 1, maximum);
    curve[2] = Math.max(1, curve[2]);
    curve[3] = clamp(curve[3], curve[2], maximum);
  }
  values.splice(0, 4, ...curve);
  values[exponentIndex] = clamp(values[exponentIndex], RATIO_EXPONENT_BOUNDS[0], RATIO_EXPONENT_BOUNDS[1]);
  return values;
}

function curveObjective(rows: readonly AttackDefenseFitRow[], kind: "attack" | "conceded", regularization: number): Objective {
  const targetCurve = kind === "attack" ? BASELINE_ATTACK_CURVE : FLAT_CONCEDED_CURVE;
  const targetExponent = 1;
  return (values) => {
    const curve = curveFromFree(values);
    const exponent = values[4];
    let deviance = 0;
    const gradient = [0, 0, 0, 0, 0];
    for (const row of rows) {
      const basis = curveBasis(row.difficulty);
      const curveValue = curve.reduce((sum, value, index) => sum + value * basis[index], 0);
      const ratio = kind === "attack" ? row.attackRatio : row.ratedConcedingRatio;
      const venue = kind === "attack"
        ? row.isHome ? HOME_ATTACKING_FACTOR : AWAY_ATTACKING_FACTOR
        : row.isHome ? AWAY_ATTACKING_FACTOR : HOME_ATTACKING_FACTOR;
      const logRatio = Math.log(ratio);
      const rawMultiplier = curveValue * venue * Math.exp(exponent * logRatio);
      const finalMultiplier = kind === "attack"
        ? clamp(rawMultiplier, ATTACK_MULTIPLIER_BOUNDS[0], ATTACK_MULTIPLIER_BOUNDS[1])
        : rawMultiplier;
      const mean = row.leagueMeanXg * finalMultiplier;
      const observed = kind === "attack" ? row.observedAttackXg : row.observedConcededXg;
      deviance += poissonQuasiDeviance(observed, mean);
      if (kind === "attack" && rawMultiplier !== finalMultiplier) continue;
      const logMeanGradient = 2 * (mean - observed) / rows.length;
      for (const knotIndex of [0, 1, 3, 4]) {
        const parameterIndex = knotIndex < 2 ? knotIndex : knotIndex - 1;
        gradient[parameterIndex] += logMeanGradient * basis[knotIndex] / curveValue;
      }
      gradient[4] += logMeanGradient * logRatio;
    }
    const meanDeviance = deviance / rows.length;
    const penaltyIndices = [0, 1, 2, 3, 4];
    let penalty = 0;
    for (const index of penaltyIndices) {
      const knotIndex = index < 2 ? index : index === 2 ? 3 : index === 3 ? 4 : -1;
      const target = index === 4 ? targetExponent : targetCurve[knotIndex];
      const delta = values[index] - target;
      penalty += delta * delta;
      gradient[index] += 2 * regularization * delta;
    }
    return { value: meanDeviance + regularization * penalty, gradient, meanDeviance };
  };
}

function curveStart(kind: "attack" | "conceded"): number[] {
  const curve = kind === "attack" ? BASELINE_ATTACK_CURVE : FLAT_CONCEDED_CURVE;
  return [curve[0], curve[1], curve[3], curve[4], 1];
}

function curveFit(rows: readonly AttackDefenseFitRow[], kind: "attack" | "conceded", regularization: number, options: FitOptions): {
  curve: DifficultyCurve;
  exponent: number;
  summary: EquationFitSummary;
} {
  const optimized = minimize(
    curveStart(kind),
    curveObjective(rows, kind, regularization),
    (values) => projectCurve(values, kind === "attack" ? "decreasing" : "increasing"),
    { maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS, gradientTolerance: options.gradientTolerance ?? DEFAULT_GRADIENT_TOLERANCE },
  );
  const curve = curveFromFree(optimized.values);
  validateDifficultyCurve(curve, kind === "attack" ? "decreasing" : "increasing");
  return {
    curve,
    exponent: optimized.values[4],
    summary: { meanDeviance: optimized.meanDeviance, objective: optimized.objective, iterations: optimized.iterations, converged: optimized.converged },
  };
}

function lambdaId(value: number): string {
  return `lambda=${value}`;
}

/** Fits separate anchored monotone curves and ratio exponents for each fixed regularization value. */
export function fitDifficultyCurveGrid(
  rows: readonly AttackDefenseFitRow[],
  options: FitOptions = {},
): CurveModelFit[] {
  validateFitOptions(options);
  validateTrainingRows(rows);
  const grid = options.regularizationGrid ?? DEFAULT_REGULARIZATION_GRID;
  validateRegularizationGrid(grid);
  return grid.map((regularization) => {
    const attack = curveFit(rows, "attack", regularization, options);
    const conceded = curveFit(rows, "conceded", regularization, options);
    return {
      model: {
        family: "curve",
        parameters: {
          attackCurve: attack.curve,
          attackRatioExponent: attack.exponent,
          concededCurve: conceded.curve,
          concededRatioExponent: conceded.exponent,
        },
        regularizationId: lambdaId(regularization),
        regularization,
        fitReferenceElo: null,
      },
      attack: attack.summary,
      conceded: conceded.summary,
    };
  });
}

function rawEloStart(restriction: RawEloRestriction): number[] {
  if (restriction === "full") return [0, 0, 1];
  if (restriction === "gap-only") return [0, 1];
  return [0, 0];
}

function rawEloProjection(values: number[], restriction: RawEloRestriction): number[] {
  for (let index = 0; index < values.length; index += 1) {
    const bound = index === values.length - 1 && restriction !== "elo-only"
      ? RATIO_EXPONENT_BOUNDS
      : RAW_ELO_COEFFICIENT_BOUNDS;
    values[index] = clamp(values[index], bound[0], bound[1]);
  }
  return values;
}

function rawEloEquationObjective(
  rows: readonly AttackDefenseFitRow[],
  kind: "attack" | "conceded",
  restriction: RawEloRestriction,
  referenceElo: number,
  regularization: number,
): Objective {
  return (values) => {
    let deviance = 0;
    const gradient = values.map(() => 0);
    const ratioIndex = restriction === "full" ? 2 : restriction === "gap-only" ? 1 : -1;
    for (const row of rows) {
      const own = (row.ownElo! - referenceElo) / CLUB_ELO_REFERENCE_SCALE;
      const opponent = (row.opponentElo! - referenceElo) / CLUB_ELO_REFERENCE_SCALE;
      const ratio = kind === "attack" ? row.attackRatio : row.ratedConcedingRatio;
      const logRatio = Math.log(ratio);
      const venue = kind === "attack"
        ? row.isHome ? HOME_ATTACKING_FACTOR : AWAY_ATTACKING_FACTOR
        : row.isHome ? AWAY_ATTACKING_FACTOR : HOME_ATTACKING_FACTOR;
      let eta: number;
      const derivatives = values.map(() => 0);
      if (restriction === "gap-only") {
        const gap = kind === "attack" ? own - opponent : opponent - own;
        eta = values[0] * gap + values[1] * logRatio + Math.log(venue);
        derivatives[0] = gap;
        derivatives[1] = logRatio;
      } else {
        const ownSign = kind === "attack" ? 1 : -1;
        const opponentSign = kind === "attack" ? -1 : 1;
        const ownCoef = values[0];
        const opponentCoef = values[1];
        const ratioExponent = restriction === "elo-only" ? 0 : values[2];
        eta = ownSign * ownCoef * own + opponentSign * opponentCoef * opponent + ratioExponent * logRatio + Math.log(venue);
        derivatives[0] = ownSign * own;
        derivatives[1] = opponentSign * opponent;
        if (ratioIndex >= 0) derivatives[ratioIndex] = logRatio;
      }
      const rawMultiplier = Math.exp(eta);
      const finalMultiplier = kind === "attack"
        ? clamp(rawMultiplier, ATTACK_MULTIPLIER_BOUNDS[0], ATTACK_MULTIPLIER_BOUNDS[1])
        : rawMultiplier;
      const mean = row.leagueMeanXg * finalMultiplier;
      const observed = kind === "attack" ? row.observedAttackXg : row.observedConcededXg;
      deviance += poissonQuasiDeviance(observed, mean);
      if (kind === "attack" && rawMultiplier !== finalMultiplier) continue;
      const factor = 2 * (mean - observed) / rows.length;
      for (let index = 0; index < derivatives.length; index += 1) gradient[index] += factor * derivatives[index];
    }
    const meanDeviance = deviance / rows.length;
    const eloCount = restriction === "gap-only" ? 1 : 2;
    let penalty = 0;
    for (let index = 0; index < eloCount; index += 1) {
      penalty += values[index] ** 2;
      gradient[index] += 2 * regularization * values[index];
    }
    return { value: meanDeviance + regularization * penalty, gradient, meanDeviance };
  };
}

function rawEloEquationFit(
  rows: readonly AttackDefenseFitRow[], kind: "attack" | "conceded", restriction: RawEloRestriction,
  referenceElo: number, regularization: number, options: FitOptions,
): { parameters: RawEloEquationParameters; summary: EquationFitSummary } {
  const optimized = minimize(
    rawEloStart(restriction),
    rawEloEquationObjective(rows, kind, restriction, referenceElo, regularization),
    (values) => rawEloProjection(values, restriction),
    { maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS, gradientTolerance: options.gradientTolerance ?? DEFAULT_GRADIENT_TOLERANCE },
  );
  const [ownEloCoefficient, opponentEloCoefficient, ratioExponent] = restriction === "gap-only"
    ? [optimized.values[0], optimized.values[0], optimized.values[1]]
    : [optimized.values[0], optimized.values[1], restriction === "elo-only" ? 0 : optimized.values[2]];
  return {
    parameters: { ownEloCoefficient, opponentEloCoefficient, ratioExponent },
    summary: { meanDeviance: optimized.meanDeviance, objective: optimized.objective, iterations: optimized.iterations, converged: optimized.converged },
  };
}

/** Mean Elo across the supplied fitting rows; call with fit data only. */
export function clubEloReferenceFromFitRows(rows: readonly AttackDefenseFitRow[]): number {
  validateTrainingRows(rows);
  return rows.reduce((sum, row) => sum + row.ownElo! + row.opponentElo!, 0) / (2 * rows.length);
}

/** Fits full, tied-gap, and no-ratio raw-Elo restrictions for each regularization value. */
export function fitRawEloModelGrid(
  rows: readonly AttackDefenseFitRow[],
  referenceElo: number,
  options: FitOptions & { restrictions?: readonly RawEloRestriction[] } = {},
): RawEloModelFit[] {
  validateFitOptions(options);
  validateTrainingRows(rows);
  if (!Number.isFinite(referenceElo)) throw new Error("Raw Elo reference must be finite.");
  const grid = options.regularizationGrid ?? DEFAULT_REGULARIZATION_GRID;
  validateRegularizationGrid(grid);
  const restrictions = options.restrictions ?? ["full", "gap-only", "elo-only"];
  if (!restrictions.length || restrictions.some((value) => !["full", "gap-only", "elo-only"].includes(value))
    || new Set(restrictions).size !== restrictions.length) throw new Error("Raw Elo restrictions must be nonempty, valid, and unique.");
  return restrictions.flatMap((restriction) => grid.map((regularization) => {
    const attack = rawEloEquationFit(rows, "attack", restriction, referenceElo, regularization, options);
    const conceded = rawEloEquationFit(rows, "conceded", restriction, referenceElo, regularization, options);
    return {
      model: {
        family: "rawElo" as const,
        parameters: { restriction, attack: attack.parameters, conceded: conceded.parameters },
        regularizationId: `${restriction}:${lambdaId(regularization)}`,
        regularization,
        fitReferenceElo: referenceElo,
      },
      attack: attack.summary,
      conceded: conceded.summary,
    };
  }));
}

export type PairedMetricKind = "rmse" | "mae" | "bias" | "brier";

export interface PairedMetricRow {
  season: string;
  gameweek: number;
  actual: number;
  baseline: number;
  candidate: number;
}

export interface PairedClusterBootstrapOptions {
  draws?: number;
  seed?: number;
}

export interface PairedClusterBootstrapResult {
  metric: PairedMetricKind;
  baseline: number;
  candidate: number;
  difference: number;
  relativeDifference: number | null;
  interval95: readonly [number, number];
  relativeInterval95: readonly [number, number] | null;
  rows: number;
  clusters: number;
  draws: number;
  seed: number;
}

interface ClusterLosses {
  count: number;
  baseline: number;
  candidate: number;
}

function metricLoss(metric: PairedMetricKind, actual: number, prediction: number): number {
  const error = prediction - actual;
  if (metric === "bias") return error;
  if (metric === "mae") return Math.abs(error);
  return error * error;
}

function metricFromLoss(metric: PairedMetricKind, sum: number, count: number): number {
  const mean = sum / count;
  return metric === "rmse" ? Math.sqrt(mean) : mean;
}

function quantile(values: readonly number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[Math.min(lower + 1, sorted.length - 1)] * fraction;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

/** Paired percentile intervals by stratified season-gameweek cluster resampling. */
export function pairedGameweekClusterBootstrap(
  rows: readonly PairedMetricRow[],
  metric: PairedMetricKind,
  options: PairedClusterBootstrapOptions = {},
): PairedClusterBootstrapResult {
  if (!rows.length) throw new Error("Cannot bootstrap an empty paired metric dataset.");
  const draws = options.draws ?? 5000;
  const seed = options.seed ?? 20_261_009;
  if (!Number.isInteger(draws) || draws < 1 || !Number.isInteger(seed)) throw new Error("Bootstrap draws and seed must be integers; draws must be positive.");
  const grouped = new Map<string, { season: string; gameweek: number; losses: ClusterLosses }>();
  for (const row of rows) {
    if (!row.season || !Number.isInteger(row.gameweek) || row.gameweek < 1
      || !Number.isFinite(row.actual) || !Number.isFinite(row.baseline) || !Number.isFinite(row.candidate)) {
      throw new Error("Paired metric rows need season, gameweek, and finite values.");
    }
    if (metric === "brier" && (row.actual < 0 || row.actual > 1 || row.baseline < 0 || row.baseline > 1 || row.candidate < 0 || row.candidate > 1)) {
      throw new Error("Brier rows require outcomes and probabilities in [0, 1].");
    }
    const key = `${row.season}|${row.gameweek}`;
    const cluster = grouped.get(key) ?? { season: row.season, gameweek: row.gameweek, losses: { count: 0, baseline: 0, candidate: 0 } };
    cluster.losses.count += 1;
    cluster.losses.baseline += metricLoss(metric, row.actual, row.baseline);
    cluster.losses.candidate += metricLoss(metric, row.actual, row.candidate);
    grouped.set(key, cluster);
  }
  const bySeason = new Map<string, ClusterLosses[]>();
  for (const cluster of [...grouped.values()].sort((left, right) => left.season.localeCompare(right.season) || left.gameweek - right.gameweek)) {
    const list = bySeason.get(cluster.season) ?? [];
    list.push(cluster.losses);
    bySeason.set(cluster.season, list);
  }
  let totalCount = 0;
  let baselineLoss = 0;
  let candidateLoss = 0;
  for (const cluster of grouped.values()) {
    totalCount += cluster.losses.count;
    baselineLoss += cluster.losses.baseline;
    candidateLoss += cluster.losses.candidate;
  }
  const baseline = metricFromLoss(metric, baselineLoss, totalCount);
  const candidate = metricFromLoss(metric, candidateLoss, totalCount);
  const random = seededRandom(seed);
  const differences = new Array<number>(draws);
  const relativeDifferences = new Array<number>(draws);
  for (let draw = 0; draw < draws; draw += 1) {
    let count = 0;
    let baselineSum = 0;
    let candidateSum = 0;
    for (const clusters of bySeason.values()) {
      for (let sample = 0; sample < clusters.length; sample += 1) {
        const cluster = clusters[Math.floor(random() * clusters.length)];
        count += cluster.count;
        baselineSum += cluster.baseline;
        candidateSum += cluster.candidate;
      }
    }
    const baseMetric = metricFromLoss(metric, baselineSum, count);
    const candidateMetric = metricFromLoss(metric, candidateSum, count);
    differences[draw] = candidateMetric - baseMetric;
    relativeDifferences[draw] = baseMetric === 0 ? Number.NaN : (candidateMetric - baseMetric) / baseMetric;
  }
  const finiteRelative = relativeDifferences.filter(Number.isFinite);
  const difference = candidate - baseline;
  return {
    metric,
    baseline,
    candidate,
    difference,
    relativeDifference: baseline === 0 ? null : difference / baseline,
    interval95: [quantile(differences, 0.025), quantile(differences, 0.975)],
    relativeInterval95: finiteRelative.length === relativeDifferences.length
      ? [quantile(finiteRelative, 0.025), quantile(finiteRelative, 0.975)]
      : null,
    rows: totalCount,
    clusters: grouped.size,
    draws,
    seed,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
