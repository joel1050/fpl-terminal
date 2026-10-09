/**
 * Walk-forward test of the production, venue-agnostic Elo FDR base.
 *
 * Arms use continuous `exactDifficulty` for projections and rounded `difficulty`
 * only for display/fallback. The historic Elo stream is result-derived rather
 * than ClubElo: comparisons test the divisor applied to that common proxy.
 *
 * 2023/24 is the calibration season; 2024/25 and 2025/26 are untouched holdout
 * seasons. 2022/23 is Elo burn-in and is excluded from model comparison.
 *
 *   BACKTEST_MULTI_DATA_DIR=/tmp/fpl-backtest-seasons npx tsx scripts/backtest/elo-fdr.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { calculateClubEloFdr, calculateContinuousClubEloFdr } from "@/lib/clubElo";
import { calculateFixtureAdjustment } from "@/lib/projections/fixtureAdjustment";
import type { PlayerFixture } from "@/types/player";
import type { TeamStrength } from "@/types/projection";
import { loadSeason, strengthsBefore, formBefore, playerAt } from "./season";
import { expectedPoints, playerRates } from "./xp";
import { BASELINE, adjust } from "./variants";
import type { GameweekStartElo } from "./elo-history";

const SEASONS = ["2022-23", "2023-24", "2024-25", "2025-26"] as const;
const BURN_IN = new Set(["2022-23"]);
const CALIBRATION_SEASON = "2023-24";
const HOLDOUT_SEASONS = ["2024-25", "2025-26"] as const;
const FIRST_GAMEWEEK = 6;
const BOOTSTRAP = 10_000;
const SEED = 0xe10fd;
const ARMS = ["GAP(150)", "GAP(200)", "GAP(300)", "NONE"] as const;
type ArmName = typeof ARMS[number];
type Divisor = 150 | 200 | 300;

interface DifficultyContext {
  ownElo: number;
  opponentElo: number;
  isHome: boolean;
}

interface ScoreRow {
  gameweek: number;
  season: string;
  actual: number;
  prediction: Record<ArmName, number>;
}

interface SeasonRows {
  team: ScoreRow[];
  player: ScoreRow[];
  gameweeks: number[];
  parityChecks: number;
}

const seasonsRoot = process.env.BACKTEST_MULTI_DATA_DIR
  ?? path.join("/tmp", "fpl-backtest-seasons");
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-10;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const rmse = (rows: ScoreRow[], arm: ArmName) => Math.sqrt(mean(rows.map((row) => (row.prediction[arm] - row.actual) ** 2)));
const format = (value: number) => value.toFixed(5);

function continuousDifficulty(context: DifficultyContext, divisor?: Divisor): number {
  if (!divisor) return 3;
  return clamp(3 + (context.opponentElo - context.ownElo) / divisor, 1, 5);
}

function armFixture(source: PlayerFixture, context: DifficultyContext, arm: ArmName): PlayerFixture {
  const exactDifficulty = continuousDifficulty(
    context,
    arm === "NONE" ? undefined : Number(arm.slice(4, -1)) as Divisor,
  );
  const difficulty = Math.round(exactDifficulty);
  if (arm === "GAP(300)") {
    assert.equal(exactDifficulty, calculateContinuousClubEloFdr(context.ownElo, context.opponentElo, context.isHome));
    assert.equal(difficulty, calculateClubEloFdr(context.ownElo, context.opponentElo, context.isHome));
  }
  return {
    ...source,
    difficulty,
    exactDifficulty,
  };
}

function assertAdjustmentParity(
  fixture: PlayerFixture,
  ownTeam: TeamStrength,
  opponentTeam: TeamStrength,
): void {
  const options = { ownTeam, opponentTeam };
  const harness = adjust(fixture, options, BASELINE);
  const production = calculateFixtureAdjustment(fixture, options);
  assert.ok(close(harness.attackMultiplier, production.attackMultiplier), "attack multiplier differs from production");
  assert.ok(close(harness.cleanSheetProbability, production.cleanSheetProbability), "clean sheet differs from production");
  assert.ok(close(harness.expectedGoalsAgainst, production.expectedGoalsAgainst), "goals against differs from production");
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function clusteredInterval(
  clusters: ScoreRow[][],
  arm: ArmName,
  reference: ArmName,
  seed: number,
): [number, number] {
  const random = seededRandom(seed);
  const draws = new Array<number>(BOOTSTRAP);
  for (let sample = 0; sample < BOOTSTRAP; sample += 1) {
    let squaredArm = 0;
    let squaredReference = 0;
    let count = 0;
    for (let index = 0; index < clusters.length; index += 1) {
      const rows = clusters[Math.floor(random() * clusters.length)];
      for (const row of rows) {
        squaredArm += (row.prediction[arm] - row.actual) ** 2;
        squaredReference += (row.prediction[reference] - row.actual) ** 2;
        count += 1;
      }
    }
    draws[sample] = Math.sqrt(squaredArm / count) - Math.sqrt(squaredReference / count);
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * (BOOTSTRAP - 1))], draws[Math.floor(0.975 * (BOOTSTRAP - 1))]];
}

function clusterRows(rows: ScoreRow[]): ScoreRow[][] {
  const grouped = new Map<number, ScoreRow[]>();
  for (const row of rows) (grouped.get(row.gameweek) ?? grouped.set(row.gameweek, []).get(row.gameweek)!).push(row);
  return [...grouped.values()];
}

function addSeasonClusters(rows: ScoreRow[]): ScoreRow[][] {
  const grouped = new Map<string, ScoreRow[]>();
  for (const row of rows) {
    const key = `${row.season}:${row.gameweek}`;
    (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(row);
  }
  return [...grouped.values()];
}

function gap(row: ScoreRow[], arm: ArmName, reference: ArmName): number {
  return rmse(row, arm) - rmse(row, reference);
}

function printRows(label: string, rows: ScoreRow[], kind: "team xG" | "player xP", clusters: ScoreRow[][], seed: number): void {
  console.log(`\n${label}: ${kind}; n=${rows.length}, gameweeks=${clusters.length}`);
  console.log("arm       RMSE     delta vs GAP(150)  paired GW-cluster 95% CI");
  ARMS.forEach((arm, index) => {
    const delta = gap(rows, arm, "GAP(150)");
    const [low, high] = arm === "GAP(150)" ? [0, 0] : clusteredInterval(clusters, arm, "GAP(150)", seed + index);
    console.log(`${arm.padEnd(10)} ${format(rmse(rows, arm)).padEnd(9)} ${format(delta).padEnd(18)} [${format(low)}, ${format(high)}]`);
  });
}

function analyzeSeason(seasonName: string): SeasonRows {
  const directory = path.join(seasonsRoot, seasonName);
  const eloPath = path.join(directory, "gameweek-start-elo.json");
  if (!existsSync(eloPath)) throw new Error(`${seasonName}: missing ${eloPath}`);
  const weekStarts = JSON.parse(readFileSync(eloPath, "utf8")) as GameweekStartElo[];
  const eloByGameweek = new Map(weekStarts.map((row) => [
    row.gameweek,
    new Map(row.teams.map((team) => [team.teamId, team.elo])),
  ]));
  const season = loadSeason(directory);
  const teamRows: ScoreRow[] = [];
  const playerRows: ScoreRow[] = [];
  const gameweeks: number[] = [];
  let parityChecks = 0;

  for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(season, gameweek);
    const weekElo = eloByGameweek.get(gameweek);
    const fixtures = season.fixturesByGameweek.get(gameweek) ?? [];
    if (fixtures.length > 0) gameweeks.push(gameweek);
    const fixtureById = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));

    for (const fixture of fixtures) {
      assert.ok(weekElo, `${seasonName} GW${gameweek}: missing week-start Elo snapshot`);
      for (const isHome of [true, false]) {
        const ownTeamId = isHome ? fixture.homeTeamId : fixture.awayTeamId;
        const opponentTeamId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
        const ownTeam = strengths[ownTeamId];
        const opponentTeam = strengths[opponentTeamId];
        if (!ownTeam || !opponentTeam) continue;
        const ownElo = weekElo.get(ownTeamId);
        const opponentElo = weekElo.get(opponentTeamId);
        if (ownElo === undefined || opponentElo === undefined) {
          throw new Error(`${seasonName} GW${gameweek}: missing a club's Elo rating`);
        }
        const context: DifficultyContext = {
          ownElo,
          opponentElo,
          isHome,
        };
        const source: PlayerFixture = {
          fixtureId: fixture.fixtureId,
          gameweek,
          opponentTeamId,
          opponentShortName: "OPP",
          isHome,
          difficulty: 3,
        };
        const prediction = {} as Record<ArmName, number>;
        for (const arm of ARMS) {
          const projectedFixture = armFixture(source, context, arm);
          // Check the continuous exactDifficulty route and the integer fallback
          // against the production helper for every side of every fixture.
          assertAdjustmentParity(projectedFixture, ownTeam, opponentTeam);
          assertAdjustmentParity({ ...projectedFixture, exactDifficulty: undefined }, ownTeam, opponentTeam);
          parityChecks += 2;
          prediction[arm] = adjust(projectedFixture, { ownTeam, opponentTeam }, BASELINE).attackMultiplier;
        }
        const actualXg = (isHome ? fixture.homeXg : fixture.awayXg) / season.leagueAverageXg;
        teamRows.push({ gameweek, season: seasonName, actual: actualXg, prediction });
      }
    }

    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      if (row.minutes <= 0) continue;
      const fixture = fixtureById.get(row.fixtureId);
      if (!fixture || !weekElo) continue;
      const player = playerAt(season, row.historicalPlayerId, gameweek, fixture, row.wasHome);
      if (!player) continue;
      const form = formBefore(season, row.historicalPlayerId, gameweek);
      const rates = playerRates(player, form, gameweek, undefined, strengths);
      const ownTeamId = row.wasHome ? fixture.homeTeamId : fixture.awayTeamId;
      const opponentTeamId = row.wasHome ? fixture.awayTeamId : fixture.homeTeamId;
      const ownElo = weekElo.get(ownTeamId);
      const opponentElo = weekElo.get(opponentTeamId);
      if (ownElo === undefined || opponentElo === undefined) {
        throw new Error(`${seasonName} GW${gameweek}: missing a played player's Elo rating`);
      }
      const context: DifficultyContext = {
        ownElo,
        opponentElo,
        isHome: row.wasHome,
      };
      const prediction = {} as Record<ArmName, number>;
      for (const arm of ARMS) {
        const projectedFixture = armFixture(player.fixtures[0], context, arm);
        prediction[arm] = expectedPoints(
          player,
          projectedFixture,
          row.minutes,
          rates,
          strengths,
          BASELINE,
        ).total;
      }
      playerRows.push({ gameweek, season: seasonName, actual: row.totalPoints, prediction });
    }
  }

  return { team: teamRows, player: playerRows, gameweeks, parityChecks };
}

function printSummary(): void {
  const bySeason = new Map<string, SeasonRows>();
  for (const season of SEASONS) {
    if (BURN_IN.has(season)) continue;
    bySeason.set(season, analyzeSeason(season));
  }

  const calibration = bySeason.get(CALIBRATION_SEASON)!;
  const selected = [...ARMS].sort((a, b) => rmse(calibration.team, a) - rmse(calibration.team, b))[0];
  console.log(`Calibration season: ${CALIBRATION_SEASON} (GW${FIRST_GAMEWEEK}-38); selected by lowest team xG RMSE: ${selected}`);
  console.log("Evaluation seasons: 2024/25 and 2025/26; 2022/23 burn-in and 2023/24 calibration are excluded.");
  console.log(`Historical rating source: result-derived Elo proxy, not archived ClubElo ratings. Bootstrap: ${BOOTSTRAP} paired gameweek-cluster draws, seed 0x${SEED.toString(16)}.`);

  for (const season of [CALIBRATION_SEASON, ...HOLDOUT_SEASONS]) {
    const result = bySeason.get(season)!;
    const label = season === CALIBRATION_SEASON ? `${season} calibration` : `${season} holdout`;
    console.log(`\n${label}: ${result.gameweeks.length} gameweeks, ${result.team.length} team fixtures, ${result.player.length} played player-fixtures; production parity checks=${result.parityChecks}`);
    printRows(label, result.team, "team xG", clusterRows(result.team), SEED + season.length * 37);
    printRows(label, result.player, "player xP", clusterRows(result.player), SEED + season.length * 101);
  }

  const heldoutTeam = HOLDOUT_SEASONS.flatMap((season) => bySeason.get(season)!.team);
  const heldoutPlayer = HOLDOUT_SEASONS.flatMap((season) => bySeason.get(season)!.player);
  printRows("Pooled 2024/25–2025/26 holdout", heldoutTeam, "team xG", addSeasonClusters(heldoutTeam), SEED + 7001);
  printRows("Pooled 2024/25–2025/26 holdout", heldoutPlayer, "player xP", addSeasonClusters(heldoutPlayer), SEED + 9001);

  const heldoutGap = gap(heldoutTeam, selected, "GAP(150)");
  const [heldoutLow, heldoutHigh] = clusteredInterval(addSeasonClusters(heldoutTeam), selected, "GAP(150)", SEED + 11003);
  console.log(`\nSelected arm ${selected} heldout team-xG gap vs former production GAP(150): ${format(heldoutGap)} [${format(heldoutLow)}, ${format(heldoutHigh)}]`);
  console.log("Negative values favor the arm; only a heldout interval wholly below zero counts as evidence of improvement.");
}

printSummary();
