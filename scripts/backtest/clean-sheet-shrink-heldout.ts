/**
 * Tests a clean-sheet shrink toward 0.25 against the current rated production
 * path. Run once per season with BACKTEST_DATA_DIR and BACKTEST_CASE_OUT, then
 * pool the saved case files. All strengths and Elo inputs stop before the
 * gameweek being scored.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PlayerFixture, Position } from "@/types/player";
import type { PlayerMatchRate, ProjectionComponents, TeamStrength } from "@/types/projection";
import type { CleanSheetStrength } from "@/lib/projections/cleanSheetStrength";
import { calculateContinuousClubEloFdr } from "@/lib/clubElo";
import {
  deriveCleanSheetStrengths,
  type CleanSheetStrength as RatedStrength,
} from "@/lib/projections/cleanSheetStrength";
import {
  calculateFixtureAdjustment,
  CLEAN_SHEET_DISPERSION,
  LEAGUE_AVERAGE_GOALS_AGAINST,
  cleanSheetFromRates,
} from "@/lib/projections/fixtureAdjustment";
import { expectedFloorDivision } from "@/lib/projections/distributions";
import { projectPlayer } from "@/lib/projections/projectPlayer";
import { formBefore, loadSeason, playerAt, strengthsBefore, type Fixture } from "./season";
import { playerRates } from "./xp";

const FIRST_GAMEWEEK = 6;
const PROPOSED_WEIGHT = 0.85;
const SHRINK_BASE = 0.25;
const BOOTSTRAP_DRAWS = 4000;
const dataDir = process.env.BACKTEST_DATA_DIR
  ?? path.join(path.resolve(__dirname, "../.."), "data/generated");

interface EloRow {
  fixtureId: number;
  homeElo: number;
  awayElo: number;
}

interface RatingState {
  byTeam: Map<number, number>;
  matchesPlayed: Map<number, number>;
}

interface FixtureRead {
  fixture: PlayerFixture;
  adjustment: ReturnType<typeof calculateFixtureAdjustment>;
}

interface TeamCase {
  season: string;
  gameweek: number;
  actual: number;
  probability: number;
}

interface PlayerCase {
  season: string;
  gameweek: number;
  actual: number;
  baselineXp: number;
  probability: number;
  goalsAgainst: number;
  minutes: number;
  position: Position;
  baselineCleanSheets: number;
  baselineGoalsConceded: number;
  baselineSaves: number;
  savesRate: number;
}

interface Output {
  season: string;
  teamCases: TeamCase[];
  playerCases: PlayerCase[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function close(actual: number, expected: number, message: string): void {
  assert(Math.abs(actual - expected) <= 1e-9, message + ": " + actual + " != " + expected);
}

function inverseNegativeBinomial(probability: number): number {
  return CLEAN_SHEET_DISPERSION * (Math.pow(probability, -1 / CLEAN_SHEET_DISPERSION) - 1);
}

function shrunkProbability(probability: number, weight: number): number {
  return SHRINK_BASE + weight * (probability - SHRINK_BASE);
}

function readElo(): Map<number, EloRow> {
  const file = path.join(dataDir, "backtest-elo.json");
  if (!existsSync(file)) throw new Error("missing " + file + "; prepare walk-forward Elo first");
  const rows = JSON.parse(readFileSync(file, "utf8")) as EloRow[];
  return new Map(rows.map((row) => [row.fixtureId, row]));
}

/** Uses the latest rating recorded before an earlier gameweek; never reads the target GW. */
function ratingsBefore(
  season: ReturnType<typeof loadSeason>,
  gameweek: number,
  eloByFixture: ReadonlyMap<number, EloRow>,
): RatingState {
  const byTeam = new Map<number, number>();
  const matchesPlayed = new Map<number, number>();
  for (const fixture of season.fixtures) {
    if (fixture.gameweek >= gameweek) continue;
    const row = eloByFixture.get(fixture.fixtureId);
    if (!row) continue;
    byTeam.set(fixture.homeTeamId, row.homeElo);
    byTeam.set(fixture.awayTeamId, row.awayElo);
    matchesPlayed.set(fixture.homeTeamId, (matchesPlayed.get(fixture.homeTeamId) ?? 0) + 1);
    matchesPlayed.set(fixture.awayTeamId, (matchesPlayed.get(fixture.awayTeamId) ?? 0) + 1);
  }
  return { byTeam, matchesPlayed };
}

function ratedStrengths(
  strengths: Record<number, TeamStrength>,
  ratings: RatingState,
): Record<number, RatedStrength> {
  const ids = Object.keys(strengths).map(Number);
  for (const id of ids) assert(Number.isFinite(ratings.byTeam.get(id)), "no finite prior Elo for team " + id);
  return deriveCleanSheetStrengths(strengths, ratings.byTeam, ratings.matchesPlayed);
}

function fixtureRead(
  fixture: Fixture,
  isHome: boolean,
  strengths: Record<number, TeamStrength>,
  cleanStrengths: Record<number, CleanSheetStrength>,
  ratings: RatingState,
): FixtureRead {
  const ownId = isHome ? fixture.homeTeamId : fixture.awayTeamId;
  const opponentId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
  const ownElo = ratings.byTeam.get(ownId);
  const opponentElo = ratings.byTeam.get(opponentId);
  assert(ownElo !== undefined && opponentElo !== undefined, "missing pre-gameweek Elo for fixture " + fixture.fixtureId);
  const exactDifficulty = calculateContinuousClubEloFdr(ownElo, opponentElo, isHome);
  const playerFixture: PlayerFixture = {
    gameweek: fixture.gameweek,
    opponentTeamId: opponentId,
    opponentShortName: "OPP",
    isHome,
    difficulty: Math.round(exactDifficulty),
    exactDifficulty,
  };
  const ownTeam = strengths[ownId];
  const opponentTeam = strengths[opponentId];
  const ownCleanSheet = cleanStrengths[ownId];
  const opponentCleanSheet = cleanStrengths[opponentId];
  assert(ownTeam && opponentTeam && ownCleanSheet && opponentCleanSheet, "unrated fixture " + fixture.fixtureId);
  const adjustment = calculateFixtureAdjustment(playerFixture, {
    ownTeam,
    opponentTeam,
    ownCleanSheet,
    opponentCleanSheet,
  });
  const direct = cleanSheetFromRates(isHome, ownCleanSheet.defence, opponentCleanSheet.attack);
  close(adjustment.cleanSheetProbability, direct.cleanSheetProbability, "production clean-sheet probability");
  close(adjustment.expectedGoalsAgainst, direct.goalsAgainst, "production goals-against mean");
  return { fixture: playerFixture, adjustment };
}

function cleanStrengthsAtWeight(
  fixture: PlayerFixture,
  ownTeamId: number,
  opponentTeamId: number,
  cleanStrengths: Record<number, RatedStrength>,
  weight: number,
): Record<number, RatedStrength> {
  const own = cleanStrengths[ownTeamId];
  const opponent = cleanStrengths[opponentTeamId];
  const raw = cleanSheetFromRates(fixture.isHome, own.defence, opponent.attack);
  const targetProbability = shrunkProbability(raw.cleanSheetProbability, weight);
  const targetGoalsAgainst = inverseNegativeBinomial(targetProbability);
  const scale = targetGoalsAgainst / raw.goalsAgainst;
  const adjusted = {
    ...cleanStrengths,
    [ownTeamId]: { ...own, defence: own.defence / scale },
  };
  const check = cleanSheetFromRates(
    fixture.isHome,
    adjusted[ownTeamId].defence,
    adjusted[opponentTeamId].attack,
  );
  close(check.cleanSheetProbability, targetProbability, "shrink probability transform");
  close(check.goalsAgainst, targetGoalsAgainst, "shrink mean transform");
  return adjusted;
}

function projectTotal(
  player: ReturnType<typeof playerAt> & {},
  fixture: PlayerFixture,
  gameweek: number,
  strengths: Record<number, TeamStrength>,
  cleanStrengths: Record<number, RatedStrength>,
  form: readonly PlayerMatchRate[],
  minutes: number,
): ProjectionComponents {
  const projected = projectPlayer(
    { ...player, fixtures: [fixture] },
    {
      currentGameweek: gameweek,
      horizon: 1,
      expectedMinutes: minutes,
      teamStrengths: strengths,
      cleanSheetStrengths: cleanStrengths,
      playerForm: { [player.id]: form },
    },
  );
  const components = projected.fixtures[0]?.components;
  assert(components, "projectPlayer returned no fixture components");
  return components;
}

function collectSeason(): Output {
  const season = loadSeason();
  const label = path.basename(dataDir);
  const eloByFixture = readElo();
  const teamCases: TeamCase[] = [];
  const playerCases: PlayerCase[] = [];

  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(season, gameweek);
    const ratings = ratingsBefore(season, gameweek, eloByFixture);
    const cleanStrengths = ratedStrengths(strengths, ratings);
    const reads = new Map<string, FixtureRead>();
    const fixtures = season.fixturesByGameweek.get(gameweek) ?? [];
    for (const fixture of fixtures) {
      for (const isHome of [true, false]) {
        const read = fixtureRead(fixture, isHome, strengths, cleanStrengths, ratings);
        reads.set(fixture.fixtureId + ":" + Number(isHome), read);
        const conceded = isHome ? fixture.awayGoals : fixture.homeGoals;
        teamCases.push({
          season: label,
          gameweek,
          actual: conceded === 0 ? 1 : 0,
          probability: read.adjustment.cleanSheetProbability,
        });
      }
    }

    const fixtureById = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));
    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = fixtureById.get(row.fixtureId);
      if (!fixture) continue;
      const read = reads.get(row.fixtureId + ":" + Number(row.wasHome));
      if (!read) continue;
      const player = playerAt(season, row.historicalPlayerId, gameweek, fixture, row.wasHome);
      if (!player) continue;
      const ownTeamId = row.wasHome ? fixture.homeTeamId : fixture.awayTeamId;
      const playerForFixture = { ...player, teamId: ownTeamId };
      const form = formBefore(season, row.historicalPlayerId, gameweek);
      const baseline = projectTotal(
        playerForFixture, read.fixture, gameweek, strengths, cleanStrengths, form, row.minutes,
      );
      const opponentId = row.wasHome ? fixture.awayTeamId : fixture.homeTeamId;
      const shrunkStrengths = cleanStrengthsAtWeight(
        read.fixture, ownTeamId, opponentId, cleanStrengths, PROPOSED_WEIGHT,
      );
      const proposed = projectTotal(
        playerForFixture, read.fixture, gameweek, strengths, shrunkStrengths, form, row.minutes,
      );
      const rates = player.position === "GK"
        ? playerRates(playerForFixture, form, gameweek, {}, strengths)
        : undefined;
      const playerCase: PlayerCase = {
        season: label,
        gameweek,
        actual: row.totalPoints,
        baselineXp: baseline.total,
        probability: read.adjustment.cleanSheetProbability,
        goalsAgainst: read.adjustment.expectedGoalsAgainst,
        minutes: row.minutes,
        position: player.position,
        baselineCleanSheets: baseline.cleanSheets,
        baselineGoalsConceded: baseline.goalsConceded,
        baselineSaves: baseline.saves,
        savesRate: rates?.saves ?? 0,
      };
      close(xpAtWeight(playerCase, PROPOSED_WEIGHT), proposed.total, "production xP shrink decomposition");
      playerCases.push(playerCase);
    }
  }
  return { season: label, teamCases, playerCases };
}

function xpAtWeight(row: PlayerCase, weight: number): number {
  const probability = shrunkProbability(row.probability, weight);
  const goalsAgainst = weight === 1
    ? row.goalsAgainst
    : inverseNegativeBinomial(probability);
  const minutesShare = Math.min(90, Math.max(0, row.minutes)) / 90;
  let total = row.baselineXp;
  if (row.minutes >= 60 && row.probability > 0) {
    total += row.baselineCleanSheets * (probability / row.probability - 1);
  }
  if (row.position === "GK" || row.position === "DEF") {
    total -= expectedFloorDivision(goalsAgainst * minutesShare, 2)
      + row.baselineGoalsConceded;
  }
  if (row.position === "GK") {
    const proposedSaves = expectedFloorDivision(
      row.savesRate * minutesShare
        * Math.min(1.4, Math.max(0.7, goalsAgainst / LEAGUE_AVERAGE_GOALS_AGAINST)),
      3,
    );
    total += proposedSaves - row.baselineSaves;
  }
  return total;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function brier(cases: readonly TeamCase[], weight: number): number {
  return mean(cases.map((row) => (shrunkProbability(row.probability, weight) - row.actual) ** 2));
}

function logloss(cases: readonly TeamCase[], weight: number): number {
  return -mean(cases.map((row) => {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, shrunkProbability(row.probability, weight)));
    return row.actual ? Math.log(p) : Math.log(1 - p);
  }));
}

function xpRmse(cases: readonly PlayerCase[], weight: number): number {
  return Math.sqrt(mean(cases.map((row) => (xpAtWeight(row, weight) - row.actual) ** 2)));
}

function meanPrediction(cases: readonly TeamCase[], weight: number): number {
  return mean(cases.map((row) => shrunkProbability(row.probability, weight)));
}

function fitWeight(cases: readonly TeamCase[]): number {
  const numerator = cases.reduce(
    (sum, row) => sum + (row.probability - SHRINK_BASE) * (row.actual - SHRINK_BASE),
    0,
  );
  const denominator = cases.reduce(
    (sum, row) => sum + (row.probability - SHRINK_BASE) ** 2,
    0,
  );
  assert(denominator > 0, "training probabilities have no spread");
  return Math.min(1, Math.max(0, numerator / denominator));
}

function pairedLossInterval<T extends { season: string; gameweek: number }>(
  cases: readonly T[],
  weight: number,
  loss: (row: T, weight: number) => number,
  rootMeanSquare: boolean,
  seed: number,
): [number, number] {
  const bySeason = new Map<string, Map<number, { count: number; baseline: number; arm: number }>>();
  for (const row of cases) {
    const weeks = bySeason.get(row.season) ?? new Map<number, { count: number; baseline: number; arm: number }>();
    const cluster = weeks.get(row.gameweek) ?? { count: 0, baseline: 0, arm: 0 };
    cluster.count += 1;
    cluster.baseline += loss(row, 1);
    cluster.arm += loss(row, weight);
    weeks.set(row.gameweek, cluster);
    bySeason.set(row.season, weeks);
  }
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const deltas: number[] = [];
  for (let draw = 0; draw < BOOTSTRAP_DRAWS; draw += 1) {
    let count = 0;
    let baseline = 0;
    let arm = 0;
    for (const weeks of bySeason.values()) {
      const clusters = [...weeks.values()];
      for (let i = 0; i < clusters.length; i += 1) {
        const cluster = clusters[Math.floor(random() * clusters.length)];
        count += cluster.count;
        baseline += cluster.baseline;
        arm += cluster.arm;
      }
    }
    deltas.push(rootMeanSquare
      ? Math.sqrt(arm / count) - Math.sqrt(baseline / count)
      : arm / count - baseline / count);
  }
  deltas.sort((a, b) => a - b);
  return [
    deltas[Math.floor(BOOTSTRAP_DRAWS * 0.025)],
    deltas[Math.floor(BOOTSTRAP_DRAWS * 0.975)],
  ];
}

function signed(value: number): string {
  return (value >= 0 ? "+" : "") + value.toFixed(5);
}

function reportBrier(label: string, cases: readonly TeamCase[], weight: number, seed: number): void {
  const delta = brier(cases, weight) - brier(cases, 1);
  const [lo, hi] = pairedLossInterval(
    cases,
    weight,
    (row, candidate) => (shrunkProbability(row.probability, candidate) - row.actual) ** 2,
    false,
    seed,
  );
  console.log(
    label.padEnd(25) + cases.length.toString().padStart(5)
    + "  " + brier(cases, 1).toFixed(5)
    + "  " + brier(cases, weight).toFixed(5)
    + "  " + signed(delta)
    + "  [" + signed(lo) + ", " + signed(hi) + "]"
    + "  mean p " + meanPrediction(cases, 1).toFixed(3)
    + " -> " + meanPrediction(cases, weight).toFixed(3)
    + "  observed " + mean(cases.map((row) => row.actual)).toFixed(3)
    + "  logloss " + logloss(cases, 1).toFixed(4)
    + " -> " + logloss(cases, weight).toFixed(4),
  );
}

function reportXp(label: string, cases: readonly PlayerCase[], weight: number, seed: number): void {
  const delta = xpRmse(cases, weight) - xpRmse(cases, 1);
  const [lo, hi] = pairedLossInterval(
    cases,
    weight,
    (row, candidate) => (xpAtWeight(row, candidate) - row.actual) ** 2,
    true,
    seed,
  );
  console.log(
    label.padEnd(25) + cases.length.toString().padStart(6)
    + "  " + xpRmse(cases, 1).toFixed(5)
    + "  " + xpRmse(cases, weight).toFixed(5)
    + "  " + signed(delta)
    + "  [" + signed(lo) + ", " + signed(hi) + "]",
  );
}

function calibrationBins(cases: readonly TeamCase[], weight: number): void {
  const edges = [0, 0.2, 0.3, 0.4, 0.5, 1.000001];
  console.log("\nheld-out fixed-width calibration bins: baseline mean-p / observed -> shrink mean-p / observed");
  for (let i = 0; i < edges.length - 1; i += 1) {
    const bin = cases.filter((row) => row.probability >= edges[i] && row.probability < edges[i + 1]);
    if (!bin.length) continue;
    console.log(
      "[" + edges[i].toFixed(1) + ", " + Math.min(1, edges[i + 1]).toFixed(1) + ")"
      + " n=" + bin.length
      + "  " + meanPrediction(bin, 1).toFixed(3)
      + " / " + mean(bin.map((row) => row.actual)).toFixed(3)
      + " -> " + meanPrediction(bin, weight).toFixed(3)
      + " / " + mean(bin.map((row) => row.actual)).toFixed(3),
    );
  }
}

function pool(files: readonly string[]): void {
  const outputs = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as Output);
  const teamCases = outputs.flatMap((output) => output.teamCases);
  const playerCases = outputs.flatMap((output) => output.playerCases);
  const training = teamCases.filter((row) => row.season === "2024-25" && row.gameweek >= 6 && row.gameweek <= 19);
  assert(training.length > 0, "missing 2024/25 GW6-19 training cases");
  const fittedWeight = fitWeight(training);
  const heldOutPlayers = playerCases.filter((row) =>
    (row.season === "2024-25" && row.gameweek >= 20)
    || (row.season === "2025-26" && row.gameweek >= FIRST_GAMEWEEK));

  console.log("current shipped rated path from projectPlayer()/deriveCleanSheetStrengths()");
  console.log("shrink: p' = 0.25 + weight * (p - 0.25), with the negative-binomial mean re-derived");
  console.log("paired 95% CIs resample GW clusters within each season; delta is arm minus shipped.");
  console.log("\nall-season exploratory, GW6-38 (22/23 xG incomplete; 22/23-23/24 Elo burn-in):");
  console.log("season / pool".padEnd(25) + " n   base    .85     delta       95% CI                  mean p -> p' / actual");
  outputs.forEach((output, index) => reportBrier(
    output.season,
    output.teamCases,
    PROPOSED_WEIGHT,
    20261008 + index,
  ));
  reportBrier("pooled exploratory", teamCases, PROPOSED_WEIGHT, 20261020);

  console.log("\ntraining: 2024/25 GW6-19, " + training.length + " team-fixtures");
  console.log("Brier baseline " + brier(training, 1).toFixed(5)
    + "; fitted weight " + fittedWeight.toFixed(4)
    + "; fitted Brier " + brier(training, fittedWeight).toFixed(5));

  console.log("\nheld-out clean sheets: 2024/25 GW20-38 and 2025/26 GW6-38");
  const heldOut = outputs.flatMap((output) => output.teamCases).filter((row) =>
    (row.season === "2024-25" && row.gameweek >= 20)
    || (row.season === "2025-26" && row.gameweek >= FIRST_GAMEWEEK));
  for (const season of ["2024-25", "2025-26"]) {
    const rows = heldOut.filter((row) => row.season === season);
    reportBrier(season + " .85", rows, PROPOSED_WEIGHT, 20261030 + Number(season.slice(0, 4)));
    reportBrier(season + " fitted", rows, fittedWeight, 20261130 + Number(season.slice(0, 4)));
  }
  reportBrier("held-out pooled .85", heldOut, PROPOSED_WEIGHT, 20261201);
  reportBrier("held-out pooled fit", heldOut, fittedWeight, 20261202);
  calibrationBins(heldOut, PROPOSED_WEIGHT);

  console.log("\nheld-out player xP, actual minutes, full production projection; paired GW-cluster RMSE delta:");
  console.log("season / pool".padEnd(25) + " rows  base RMSE  arm RMSE  delta       95% CI");
  for (const season of ["2024-25", "2025-26"]) {
    const rows = heldOutPlayers.filter((row) => row.season === season);
    reportXp(season + " .85", rows, PROPOSED_WEIGHT, 20261300 + Number(season.slice(0, 4)));
    reportXp(season + " fitted", rows, fittedWeight, 20261400 + Number(season.slice(0, 4)));
  }
  reportXp("held-out pooled .85", heldOutPlayers, PROPOSED_WEIGHT, 20261501);
  reportXp("held-out pooled fit", heldOutPlayers, fittedWeight, 20261502);
}

function main(): void {
  const poolIndex = process.argv.indexOf("--pool");
  if (poolIndex >= 0) {
    pool(process.argv.slice(poolIndex + 1));
    return;
  }
  const result = collectSeason();
  const outputPath = process.env.BACKTEST_CASE_OUT;
  assert(outputPath, "set BACKTEST_CASE_OUT to an output/tier-c path");
  writeFileSync(outputPath, JSON.stringify(result));
  console.log(result.season + ": " + result.teamCases.length + " team-fixtures, "
    + result.playerCases.length + " played player-fixtures -> " + outputPath);
}

main();
