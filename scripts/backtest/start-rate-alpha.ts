/**
 * How fast should a start rate react to this season's team sheets?
 *
 * START_RATE_ALPHA sets the speed of the recursion in lib/availability/startRate.ts:
 *
 *     p0 = previousSeasonStartRate
 *     pn = (1 - alpha) * p(n-1) + alpha * startedThisMatch
 *
 * 0.60 was chosen for its intended feel rather than fitted, so this measures it
 * against the one season in the repository. An anchor block of early gameweeks
 * plays the part of the previous season, as season.ts's other sweeps do, and
 * every prediction at gameweek t sees only gameweeks strictly before t.
 *
 * Scored with Brier and log loss, both proper: a model is rewarded for being
 * confident only when it is right. Two baselines bracket the sweep - the
 * anchor's static start rate (alpha = 0, no updating at all) and the
 * season-to-date mean (every match weighted equally, the house idiom).
 *
 * A start is 60 minutes played, matching the production loader and the
 * historical seed. A gameweek where a player's team did not play is no
 * observation rather than a benching, so blanks are skipped on both sides.
 *
 * The seed here is starts over matches in the anchor block, which is not quite
 * `historicalSignal`'s `starts / max(matches, starts, ceil(minutes / 90))` -
 * for a rotation player production's divisor is the larger one, so its seed
 * sits lower. The recursion washes the seed out within a few matches and the
 * alpha ordering below is stable across both splits, so the comparison holds;
 * read the ordering rather than the absolute Brier numbers.
 *
 *   npx tsx scripts/backtest/start-rate-alpha.ts
 */
import { loadSeason, type Season } from "./season";
import { blendStartRate, MINUTES_FOR_START, START_RATE_ALPHA, type StartObservation } from "@/lib/availability/startRate";

const ALPHAS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;
const ANCHORS = [8, 12] as const;
/** Below this the sample is a squad player's noise, not a role. */
const MIN_ANCHOR_MATCHES = 3;

interface Observation {
  seed: number;
  history: StartObservation[];
  /** Season-to-date start rate, the equal-weight comparison. */
  runningMean: number;
  actual: number;
}

function collect(season: Season, anchorThrough: number): Observation[] {
  const observations: Observation[] = [];
  for (const rows of season.rowsByPlayer.values()) {
    const sorted = [...rows].sort((a, b) => a.gameweek - b.gameweek);
    const anchor = sorted.filter((row) => row.gameweek <= anchorThrough);
    if (anchor.length < MIN_ANCHOR_MATCHES) continue;
    const seed = anchor.filter((row) => row.minutes >= MINUTES_FOR_START).length / anchor.length;

    const history: StartObservation[] = [];
    let startsSoFar = 0;
    for (const row of sorted) {
      if (row.gameweek > anchorThrough) {
        observations.push({
          seed,
          history: [...history],
          runningMean: history.length === 0
            ? seed
            : (anchor.filter((item) => item.minutes >= MINUTES_FOR_START).length + startsSoFar)
              / (anchor.length + history.length),
          actual: row.minutes >= MINUTES_FOR_START ? 1 : 0,
        });
      }
      const started = row.minutes >= MINUTES_FOR_START;
      history.push({ started, appeared: row.minutes > 0 });
      if (row.gameweek > anchorThrough && started) startsSoFar += 1;
    }
  }
  return observations;
}

const brier = (predictions: readonly number[], actuals: readonly number[]): number =>
  predictions.reduce((sum, p, i) => sum + (p - actuals[i]) ** 2, 0) / predictions.length;

const logLoss = (predictions: readonly number[], actuals: readonly number[]): number =>
  -predictions.reduce((sum, raw, i) => {
    const p = Math.min(Math.max(raw, 1e-6), 1 - 1e-6);
    return sum + (actuals[i] === 1 ? Math.log(p) : Math.log(1 - p));
  }, 0) / predictions.length;

function report(anchorThrough: number, observations: readonly Observation[]): void {
  const actuals = observations.map((item) => item.actual);
  console.log(`\nAnchor: gameweeks 1-${anchorThrough}  |  ${observations.length} predictions across ${new Set(observations.map((o) => o.seed)).size} distinct seeds`);
  console.log("  alpha          Brier    log loss");

  const line = (label: string, predictions: number[]) => {
    const flag = label === `${START_RATE_ALPHA}` ? "  <- shipped" : "";
    console.log(`  ${label.padEnd(13)}${brier(predictions, actuals).toFixed(4)}      ${logLoss(predictions, actuals).toFixed(4)}${flag}`);
  };

  line("anchor-only", observations.map((item) => item.seed));
  line("equal-weight", observations.map((item) => item.runningMean));
  for (const alpha of ALPHAS) {
    line(`${alpha}`, observations.map((item) => blendStartRate(item.seed, item.history, alpha)));
  }
}

function main(): void {
  const season = loadSeason();
  console.log("Start-rate alpha sweep, 2025/26, walk-forward.");
  console.log("Lower is better on both metrics. A start is 60+ minutes.");
  for (const anchor of ANCHORS) report(anchor, collect(season, anchor));
  console.log("\nThe anchor here is 8-12 matches; production's is a full 38-match season,");
  console.log("so it is a firmer seed than anything measured above. Read the ordering of");
  console.log("the alphas, not the absolute numbers.");
}

main();
