export interface PlayerFixtureOutcome {
  gameweek: number;
  fixtureId: number;
  totalPoints: number;
  minutes: number;
}

export interface PlayerGameweekOutcome {
  gameweek: number;
  points: number;
  minutes: number;
  fixtureCount: number;
}

export interface RecentBaselinePredictions {
  rollingPrediction?: number;
  minutesPrediction?: number;
  priorRecordedGameweeks: number;
  priorFixtureCount: number;
  priorActualMinutes: number;
}

export interface ErrorMetrics {
  n: number;
  rmse: number;
  mae: number;
  meanBias: number;
}

export const RECENT_WINDOW_GAMEWEEKS = 5;
export const MIN_PRIOR_GAMEWEEKS = 3;
export const MIN_PRIOR_MINUTES = 180;

export function errorMetrics(predictions: readonly number[], actuals: readonly number[]): ErrorMetrics {
  if (predictions.length === 0 || predictions.length !== actuals.length) {
    throw new Error("Predictions and actuals must have the same non-zero row count.");
  }
  const errors = predictions.map((prediction, index) => {
    const actual = actuals[index];
    if (!Number.isFinite(prediction) || !Number.isFinite(actual)) throw new Error("Predictions and actuals must be finite.");
    return prediction - actual;
  });
  return {
    n: errors.length,
    rmse: Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length),
    mae: errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length,
    meanBias: errors.reduce((sum, error) => sum + error, 0) / errors.length,
  };
}

/** Sum player-fixture outcomes into player-GWs; a zero-minute row remains a recorded zero. */
export function aggregatePlayerGameweeks(
  rows: readonly PlayerFixtureOutcome[],
): PlayerGameweekOutcome[] {
  const byGameweek = new Map<number, PlayerGameweekOutcome>();
  for (const row of rows) {
    if (!Number.isInteger(row.gameweek) || row.gameweek < 1) throw new Error("Gameweek must be a positive integer.");
    if (!Number.isInteger(row.fixtureId) || row.fixtureId < 0) throw new Error("Fixture id must be a non-negative integer.");
    if (!Number.isFinite(row.totalPoints)) throw new Error("Points must be finite.");
    if (!Number.isFinite(row.minutes) || row.minutes < 0) throw new Error("Minutes must be finite and non-negative.");
    const current = byGameweek.get(row.gameweek) ?? {
      gameweek: row.gameweek,
      points: 0,
      minutes: 0,
      fixtureCount: 0,
    };
    current.points += row.totalPoints;
    current.minutes += row.minutes;
    current.fixtureCount += 1;
    byGameweek.set(row.gameweek, current);
  }
  return [...byGameweek.values()].sort((a, b) => a.gameweek - b.gameweek);
}

/** Baselines use only the latest five recorded player-GWs strictly before targetGameweek. */
export function recentBaselinePredictions(
  outcomes: readonly PlayerFixtureOutcome[],
  targetGameweek: number,
  targetFixtureCount: number,
  expectedMinutesPerFixture: number,
): RecentBaselinePredictions {
  if (!Number.isInteger(targetGameweek) || targetGameweek < 1) throw new Error("Target Gameweek must be a positive integer.");
  if (!Number.isInteger(targetFixtureCount) || targetFixtureCount < 1) throw new Error("Target fixture count must be a positive integer.");
  if (!Number.isFinite(expectedMinutesPerFixture) || expectedMinutesPerFixture < 0) {
    throw new Error("Expected minutes must be finite and non-negative.");
  }

  const priorOutcomes = outcomes.filter((row) => row.gameweek < targetGameweek);
  const recent = aggregatePlayerGameweeks(priorOutcomes)
    .slice(-RECENT_WINDOW_GAMEWEEKS);
  const priorRecordedGameweeks = recent.length;
  const priorFixtureCount = recent.reduce((sum, row) => sum + row.fixtureCount, 0);
  const priorPoints = recent.reduce((sum, row) => sum + row.points, 0);
  const priorActualMinutes = recent.reduce((sum, row) => sum + row.minutes, 0);
  const result: RecentBaselinePredictions = {
    priorRecordedGameweeks,
    priorFixtureCount,
    priorActualMinutes,
  };

  if (priorRecordedGameweeks >= MIN_PRIOR_GAMEWEEKS && priorFixtureCount > 0) {
    result.rollingPrediction = (priorPoints / priorFixtureCount) * targetFixtureCount;
  }
  if (priorActualMinutes >= MIN_PRIOR_MINUTES) {
    result.minutesPrediction = (priorPoints / priorActualMinutes)
      * expectedMinutesPerFixture * targetFixtureCount;
  }
  return result;
}
