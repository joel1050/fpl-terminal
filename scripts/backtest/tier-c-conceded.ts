/**
 * Tier C: compare the shipped clean-sheet / goals-conceded distribution mix
 * with internally consistent Poisson and negative-binomial arms.
 *
 * Run once per prepared season because season.ts reads BACKTEST_DATA_DIR at
 * import. 2023/24 selects phi on clean-sheet Brier; later seasons are held out.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PlayerFixture, Position } from "@/types/player";
import type { TeamStrength } from "@/types/projection";
import {
  CLEAN_SHEET_DISPERSION,
  LEAGUE_AVERAGE_GOALS_AGAINST,
} from "@/lib/projections/fixtureAdjustment";
import { deriveCleanSheetStrengths, type CleanSheetStrength } from "@/lib/projections/cleanSheetStrength";
import { projectPlayer } from "@/lib/projections/projectPlayer";
import { expectedFloorDivision } from "@/lib/projections/distributions";
import { loadSeason, formBefore, playerAt, strengthsBefore } from "./season";
import { BASELINE, adjust, type Variant } from "./variants";
import { expectedNegativeBinomialFloorDivision, expectedPoints, playerRates } from "./xp";

const FIRST_GAMEWEEK = 6;
const REDUCED_FIRST_GAMEWEEK = 16;
const FIT_PHIS: (number | null)[] = [1, 2, 3, 4, 6, 8, 10, 12, 16, 24, 32, 48, 64, 100, 200, null];
const ARM_NAMES = [
  "current mix: NB(phi=12) clean sheet / Poisson conceded",
  "consistent Poisson",
  "consistent NB(phi=12)",
  "consistent training-selected distribution",
] as const;

interface EloRow {
  fixtureId: number;
  gameweek: number;
  homeElo: number;
  awayElo: number;
}

interface TeamInfo {
  teamId: number;
  name: string;
  shortName: string;
}

interface EventCase {
  gameweek: number;
  cleanSheet: 0 | 1;
  goalsAgainst: number;
  lambda: number;
  probabilities: number[];
}

interface PlayerCase {
  gameweek: number;
  position: Position;
  actualPoints: number;
  expectedPoints: number[];
  actualConcededPoints?: number;
  concededPoints: number[];
}

interface PhiScore { phi: number | null; brier: number }

interface SeasonResult {
  season: string;
  phase: "reduced" | "training" | "held-out";
  arms: string[];
  firstGameweek: number;
  fitPhi: number | null;
  fitScores: PhiScore[];
  parity: { rows: number; worstTotalGap: number; worstComponentGap: number };
  coverage: {
    teamFixtureSides: number;
    ratedTeamFixtureSides: number;
    playedRows: number;
    goalkeeperDefenderRowsWithConceded: number;
  };
  eventCases: EventCase[];
  playerCases: PlayerCase[];
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function nbZeroProbability(mean: number, phi: number): number {
  const shape = Math.max(phi, 0.1);
  return clamp(Math.pow(shape / (shape + mean), shape), 0.02, 0.9);
}

function assertDistributionHelpers(): void {
  const mean = 1.408;
  const poissonFloor = expectedFloorDivision(mean, 2);
  assert.equal(expectedNegativeBinomialFloorDivision(0, 2, CLEAN_SHEET_DISPERSION), 0);
  assert.ok(Math.abs(
    expectedNegativeBinomialFloorDivision(mean, 2, 1_000_000) - poissonFloor,
  ) < 1e-6, "negative-binomial floor expectation must converge to the Poisson limit");
  assert.ok(Math.abs(
    nbZeroProbability(mean, CLEAN_SHEET_DISPERSION)
      - Math.pow(CLEAN_SHEET_DISPERSION / (CLEAN_SHEET_DISPERSION + mean), CLEAN_SHEET_DISPERSION),
  ) < 1e-12, "phi must remain the negative-binomial shape parameter");
}

function makeVariant(cleanSheet: Variant["cleanSheet"], conceded: "POISSON" | "NEGATIVE_BINOMIAL", phi = CLEAN_SHEET_DISPERSION): Variant {
  return {
    ...BASELINE,
    cleanSheet,
    leagueAverageGoals: LEAGUE_AVERAGE_GOALS_AGAINST,
    savesBaselineGoals: LEAGUE_AVERAGE_GOALS_AGAINST,
    negativeBinomialDispersion: phi,
    goalsConcededDistribution: conceded,
  };
}

function variants(phiFit: number | null): Variant[] {
  return [
    makeVariant("RATED_NEGATIVE_BINOMIAL", "POISSON", CLEAN_SHEET_DISPERSION),
    makeVariant("RATED_POISSON", "POISSON"),
    makeVariant("RATED_NEGATIVE_BINOMIAL", "NEGATIVE_BINOMIAL", CLEAN_SHEET_DISPERSION),
    phiFit === null
      ? makeVariant("RATED_POISSON", "POISSON")
      : makeVariant("RATED_NEGATIVE_BINOMIAL", "NEGATIVE_BINOMIAL", phiFit),
  ];
}

function neutralStrengths(fixtures: readonly { homeTeamId: number; awayTeamId: number }[]): Record<number, TeamStrength> {
  const ids = new Set(fixtures.flatMap((fixture) => [fixture.homeTeamId, fixture.awayTeamId]));
  return Object.fromEntries([...ids].map((teamId) => [teamId, {
    teamId,
    attackHome: 1,
    attackAway: 1,
    defenceHome: 1,
    defenceAway: 1,
    overall: 1,
  }]));
}

const dataDir = process.env.BACKTEST_DATA_DIR
  ?? path.join(path.resolve(__dirname, "../.."), "data/generated");
const seasonName = path.basename(dataDir);
const isReducedSeason = seasonName === "2022-23";
const isTrainingSeason = seasonName === "2023-24";
const isHeldOutSeason = seasonName === "2024-25" || seasonName === "2025-26";
if (!isReducedSeason && !isTrainingSeason && !isHeldOutSeason) {
  throw new Error(`unsupported season directory: ${dataDir}`);
}

const eloPath = path.join(dataDir, "backtest-elo.json");
if (!existsSync(eloPath)) throw new Error(`missing ${eloPath}; prepared Elo inputs are required`);
const eloRows = JSON.parse(readFileSync(eloPath, "utf8")) as EloRow[];
const teamInfo = JSON.parse(readFileSync(path.join(dataDir, "team-strength.json"), "utf8")) as TeamInfo[];

function eloAtGameweekStart(
  season: ReturnType<typeof loadSeason>,
  gameweek: number,
): Map<number, number> {
  const fixtureById = new Map(season.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const result = new Map<number, number>();
  // elo-history.json is in kickoff order. The first future rating for each
  // club is its pre-match rating before that club's first game of this GW, so
  // it cannot include any result from the target GW.
  for (const row of eloRows) {
    if (row.gameweek < gameweek) continue;
    const fixture = fixtureById.get(row.fixtureId);
    if (!fixture) continue;
    if (!result.has(fixture.homeTeamId)) result.set(fixture.homeTeamId, row.homeElo);
    if (!result.has(fixture.awayTeamId)) result.set(fixture.awayTeamId, row.awayElo);
  }
  return result;
}

function matchesPlayedBefore(season: ReturnType<typeof loadSeason>, gameweek: number): Map<number, number> {
  const played = new Map<number, number>();
  for (const fixture of season.fixtures) {
    if (fixture.gameweek >= gameweek) continue;
    played.set(fixture.homeTeamId, (played.get(fixture.homeTeamId) ?? 0) + 1);
    played.set(fixture.awayTeamId, (played.get(fixture.awayTeamId) ?? 0) + 1);
  }
  return played;
}

function cleanSheetStrengthsAt(
  strengths: Record<number, TeamStrength>,
  elo: ReadonlyMap<number, number>,
  matchesPlayed?: ReadonlyMap<number, number>,
): Record<number, CleanSheetStrength> {
  for (const team of teamInfo) {
    if (!Number.isFinite(elo.get(team.teamId))) {
      throw new Error(`Elo map is missing ${team.name} before ${seasonName} fixture`);
    }
  }
  return deriveCleanSheetStrengths(strengths, elo, matchesPlayed);
}

function collectEventCases(
  season: ReturnType<typeof loadSeason>,
  firstGameweek: number,
  modelVariants: readonly Variant[],
): EventCase[] {
  const cases: EventCase[] = [];
  const fixtureSides = new Set<number>();
  const ratedSides = new Set<number>();
  for (let gameweek = firstGameweek; gameweek <= 38; gameweek += 1) {
    const strengths = isReducedSeason ? neutralStrengths(season.fixtures) : strengthsBefore(season, gameweek);
    const elo = eloAtGameweekStart(season, gameweek);
    const cleanSheet = cleanSheetStrengthsAt(
      strengths,
      elo,
      isReducedSeason ? undefined : matchesPlayedBefore(season, gameweek),
    );
    for (const fixture of season.fixturesByGameweek.get(gameweek) ?? []) {
      for (const isHome of [true, false]) {
        const ownId = isHome ? fixture.homeTeamId : fixture.awayTeamId;
        const opponentId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
        fixtureSides.add(fixture.fixtureId * 2 + Number(isHome));
        const ownCs = cleanSheet[ownId];
        const opponentCs = cleanSheet[opponentId];
        if (!ownCs || !opponentCs) continue;
        ratedSides.add(fixture.fixtureId * 2 + Number(isHome));
        const playerFixture: PlayerFixture = {
          gameweek,
          opponentTeamId: opponentId,
          opponentShortName: "OPP",
          isHome,
          difficulty: (isHome ? fixture.homeDifficulty : fixture.awayDifficulty) ?? 3,
        };
        const predictions = modelVariants.map((variant) => adjust(playerFixture, {
          ownTeam: strengths[ownId],
          opponentTeam: strengths[opponentId],
          ownCleanSheet: ownCs,
          opponentCleanSheet: opponentCs,
        }, variant));
        const goalsAgainst = isHome ? fixture.awayGoals : fixture.homeGoals;
        cases.push({
          gameweek,
          cleanSheet: goalsAgainst === 0 ? 1 : 0,
          goalsAgainst,
          lambda: predictions[0].expectedGoalsAgainst,
          probabilities: predictions.map((prediction) => prediction.cleanSheetProbability),
        });
      }
    }
  }
  if (ratedSides.size !== fixtureSides.size) {
    throw new Error(`rated only ${ratedSides.size}/${fixtureSides.size} team-fixture sides`);
  }
  return cases;
}

function brier(cases: readonly EventCase[], phi: number | null): number {
  const probability = (lambda: number) => phi === null
    ? clamp(Math.exp(-lambda), 0.02, 0.9)
    : nbZeroProbability(lambda, phi);
  return cases.reduce((sum, item) => sum + (probability(item.lambda) - item.cleanSheet) ** 2, 0)
    / cases.length;
}

function fitPhi(cases: readonly EventCase[]): { phi: number | null; scores: PhiScore[] } {
  const scores = FIT_PHIS.map((phi) => ({ phi, brier: brier(cases, phi) }));
  const minimum = Math.min(...scores.map((score) => score.brier));
  const selected = scores
    .filter((score) => score.brier <= minimum + 1e-12)
    .sort((a, b) => (a.phi === null ? Infinity : Math.abs(a.phi - CLEAN_SHEET_DISPERSION))
      - (b.phi === null ? Infinity : Math.abs(b.phi - CLEAN_SHEET_DISPERSION)))[0];
  return { phi: selected.phi, scores };
}

function fitPhiFromFile(): number | null {
  const fitFile = process.env.TIER_C_FIT_FILE;
  if (!fitFile) throw new Error("TIER_C_FIT_FILE must point to the 2023/24 fit output for this season");
  const result = JSON.parse(readFileSync(fitFile, "utf8")) as SeasonResult;
  if (result.season !== "2023-24" || result.phase !== "training") {
    throw new Error(`fit source must be the 2023/24 training run, found ${result.season}/${result.phase}`);
  }
  return result.fitPhi;
}

function main(): void {
  assertDistributionHelpers();
  const season = loadSeason();
  const firstGameweek = isReducedSeason ? REDUCED_FIRST_GAMEWEEK : FIRST_GAMEWEEK;
  const phase: SeasonResult["phase"] = isReducedSeason ? "reduced" : isTrainingSeason ? "training" : "held-out";
  const variantsBeforeFit = variants(CLEAN_SHEET_DISPERSION);
  const eventCases = collectEventCases(season, firstGameweek, variantsBeforeFit);
  if (eventCases.length === 0) throw new Error(`no rated team-fixtures for ${seasonName}`);

  const fit = isTrainingSeason ? fitPhi(eventCases) : undefined;
  const phiFit = fit ? fit.phi : fitPhiFromFile();
  const modelVariants = variants(phiFit);
  // The event predictions are re-created with the selected train-only phi.
  const finalEventCases = collectEventCases(season, firstGameweek, modelVariants);

  const parity = { rows: 0, worstTotalGap: 0, worstComponentGap: 0 };
  const playerCases: PlayerCase[] = [];
  let playedRows = 0;
  let goalkeeperDefenderRowsWithConceded = 0;

  if (!isReducedSeason) {
    if (!season.hasPreparedPriors) throw new Error("xP comparison requires prepared previous-season priors");
    for (let gameweek = FIRST_GAMEWEEK; gameweek <= 38; gameweek += 1) {
      const strengths = strengthsBefore(season, gameweek);
      const cleanSheet = cleanSheetStrengthsAt(strengths, eloAtGameweekStart(season, gameweek), matchesPlayedBefore(season, gameweek));
      const fixtureByIdForGw = new Map(
        (season.fixturesByGameweek.get(gameweek) ?? []).map((fixture) => [fixture.fixtureId, fixture]),
      );
      for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
        if (row.minutes <= 0) continue;
        const fixture = fixtureByIdForGw.get(row.fixtureId);
        if (!fixture) continue;
        const player = playerAt(season, row.historicalPlayerId, gameweek, fixture, row.wasHome);
        if (!player || player.fixtures.length === 0) continue;
        const form = formBefore(season, row.historicalPlayerId, gameweek);
        const rates = playerRates(player, form, gameweek, undefined, strengths);
        const current = expectedPoints(
          player, player.fixtures[0], row.minutes, rates, strengths, modelVariants[0],
          undefined, true, undefined, undefined, undefined, cleanSheet,
        );
        const real = projectPlayer(player, {
          currentGameweek: gameweek,
          horizon: 1,
          teamStrengths: strengths,
          cleanSheetStrengths: cleanSheet,
          playerForm: { [player.id]: form },
          expectedMinutes: row.minutes,
        }).fixtures[0]?.components;
        if (!real) continue;
        parity.rows += 1;
        parity.worstTotalGap = Math.max(parity.worstTotalGap, Math.abs(current.total - real.total));
        for (const key of Object.keys(current) as (keyof typeof current)[]) {
          parity.worstComponentGap = Math.max(parity.worstComponentGap, Math.abs(current[key] - real[key]));
        }
        playedRows += 1;
        if ((player.position === "GK" || player.position === "DEF") && row.goalsConceded !== undefined) {
          goalkeeperDefenderRowsWithConceded += 1;
        }

        if (!isHeldOutSeason) continue;
        const byArm = modelVariants.map((variant) => expectedPoints(
          player, player.fixtures[0], row.minutes, rates, strengths, variant,
          undefined, true, undefined, undefined, undefined, cleanSheet,
        ));
        const playerCase: PlayerCase = {
          gameweek,
          position: player.position,
          actualPoints: row.totalPoints,
          expectedPoints: byArm.map((components) => components.total),
          concededPoints: byArm.map((components) => components.goalsConceded),
        };
        if ((player.position === "GK" || player.position === "DEF") && row.goalsConceded !== undefined) {
          playerCase.actualConcededPoints = -Math.floor(row.goalsConceded / 2);
        }
        playerCases.push(playerCase);
      }
    }
    const tolerance = 1e-9;
    if (parity.rows === 0 || parity.worstTotalGap > tolerance || parity.worstComponentGap > tolerance) {
      throw new Error(
        `production-path parity failed: rows=${parity.rows}, total=${parity.worstTotalGap}, component=${parity.worstComponentGap}`,
      );
    }
  }

  const totalTeamFixtureSides = finalEventCases.length;
  const result: SeasonResult = {
    season: seasonName,
    phase,
    arms: [...ARM_NAMES],
    firstGameweek,
    fitPhi: phiFit,
    fitScores: fit?.scores ?? [],
    parity,
    coverage: {
      teamFixtureSides: totalTeamFixtureSides,
      ratedTeamFixtureSides: finalEventCases.length,
      playedRows,
      goalkeeperDefenderRowsWithConceded,
    },
    eventCases: finalEventCases,
    playerCases,
  };
  const output = process.env.TIER_C_CASES_OUT;
  if (!output) throw new Error("TIER_C_CASES_OUT must point inside the assigned worktree's output/tier-c directory");
  const absoluteOutput = path.resolve(output);
  const allowedOutput = path.resolve(path.join(path.resolve(__dirname, "../.."), "output/tier-c")) + path.sep;
  if (!absoluteOutput.startsWith(allowedOutput)) throw new Error(`results output must stay under output/tier-c: ${output}`);
  mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  writeFileSync(absoluteOutput, JSON.stringify(result));

  console.log(`season=${seasonName} phase=${phase} gameweeks=${firstGameweek}-38`);
  console.log(`training-selected model=${phiFit === null ? "Poisson limit" : `NB phi=${phiFit}`}; production phi=${CLEAN_SHEET_DISPERSION}`);
  if (fit) console.log(`training fit: ${fit.scores.map((score) => `${score.phi === null ? "Poisson" : score.phi}:${score.brier.toFixed(6)}`).join(" ")}`);
  console.log(`team-fixture sides=${finalEventCases.length}; played rows=${playedRows}; GK/DEF rows with goalsConceded=${goalkeeperDefenderRowsWithConceded}`);
  if (parity.rows) {
    console.log(`production rated-path parity: ${parity.rows} rows; worst total=${parity.worstTotalGap.toExponential(3)}; worst component=${parity.worstComponentGap.toExponential(3)}`);
  } else {
    console.log("xP and xP parity skipped: reduced 2022/23 event-only replication (neutral xG lean; Elo burn-in)");
  }
  console.log(`case file=${absoluteOutput}`);
}

main();
