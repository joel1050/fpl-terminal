/**
 * Paired held-out whole-xP comparison of the three Tier C production edits.
 * Run this exact script once from the old main snapshot and once from the
 * candidate checkout. Only projectPlayer, buildPlayerSelections, and the
 * production Elo FDR functions differ between those source trees.
 *
 *   BACKTEST_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008/2024-25 \
 *   TIER_C_ARM=main TIER_C_SOURCE_REF=74ceff2 \
 *   TIER_C_OUTPUT_DIR=output/tier-c \
 *   npx tsx scripts/backtest/tier-c-combined.ts run
 *
 * To use actual dated ClubElo, set TIER_C_ELO_SOURCE=historical-clubelo,
 * TIER_C_CLUBELO_HISTORY_FILE, and a separate TIER_C_OUTPUT_DIR. This freezes
 * all clubs' ratings before the first fixture date in each target Gameweek.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  HistoricalMatchStat,
  HistoricalPlayerRecord,
  HistoricalTeamStrength,
} from "@/lib/historical/types";
import type { HistoricalBundle } from "@/lib/historical/types";
import {
  calculateClubEloFdr,
  calculateContinuousClubEloFdr,
} from "@/lib/clubElo";
import { buildPlayerSelections } from "@/lib/availability/selection";
import type { StartObservation } from "@/lib/availability/startRate";
import { deriveTeamStrengths } from "@/lib/historical/enrichPlayers";
import { deriveCleanSheetStrengths } from "@/lib/projections/cleanSheetStrength";
import { projectPlayer } from "@/lib/projections/projectPlayer";
import type { Player, PlayerFixture, Position } from "@/types/player";
import type { PlayerMatchRate, TeamStrength } from "@/types/projection";
import {
  loadSeason,
  playerAt,
  strengthsBefore,
  type Fixture,
  type MatchRow,
  type Season,
} from "./season";
import { buildFixturesFromMatchRows } from "./multiSeasonData";
import {
  deduplicateHistoricalFixtureRows,
  recordedFixtureOutcome,
  rowsBeforeGameweek,
} from "./historicalBacktest";
import {
  clubEloFixture,
  clubEloRatingsBeforeDate,
  readClubEloHistoryCache,
} from "./clubelo-history";

const FIRST_GAMEWEEK = 6;
const LAST_GAMEWEEK = 38;
const PRICE_PRIOR_TENTHS = 50;
const SEASONS = ["2024-25", "2025-26"] as const;
const FIXED_BOOTSTRAPS = 10_000;
type Arm = "main" | "candidate";

interface EloTeam {
  teamId: number;
  elo: number;
}

interface WeekStartElo {
  gameweek: number;
  teams: EloTeam[];
}

interface TeamInfo {
  teamId: number;
  name: string;
  shortName: string;
}

interface ScoreRow {
  playerId: number;
  gameweek: number;
  position: Position;
  actual: number;
  prediction: number;
  actualMinutes: number;
  fixtureCount: number;
}

interface SeasonResult {
  season: string;
  arm: Arm;
  sourceRef: string;
  fdrDivisor: number;
  ratingSource: "proxy" | "historical-clubelo";
  ratingHistorySha256?: string;
  ratingsAsOfByGameweek: Record<string, {
    cutoffDate: string;
    teams: Array<{ teamId: number; shortName: string; slug: string; elo: number; ratingDate: string; lagDays: number }>;
  }>;
  productionHashes: Record<string, string>;
  inputHashes: Record<string, string>;
  coverage: {
    sourceRows: number;
    deduplicatedPreparedRows: number;
    sourceZeroMinuteRows: number;
    sourcePlayerGameweeks: number;
    scoredPlayerGameweeks: number;
    scoredZeroMinutePlayerGameweeks: number;
    scoredStarts: number;
    scoredShortAppearances: number;
    excludedColdStartPlayerGameweeks: number;
    excludedUnsupportedPositionPlayerGameweeks: number;
    excludedPriorTeamMismatchPlayerGameweeks: number;
    excludedIncompleteFixtureRows: number;
    scheduledGameweeks: number;
    scheduledDoubleTeamGameweeks: number;
    cleanSheetTeamStrengths: number;
    players: number;
  };
  metrics: Record<string, { n: number; rmse: number }>;
  rows: ScoreRow[];
}

interface PredictionFile extends SeasonResult {
  arm: Arm;
}

interface HeldoutFile {
  season: string;
  arm: Arm;
  rows: ScoreRow[];
}

const BACKTEST_DIR = process.env.BACKTEST_DATA_DIR ?? fail("Set BACKTEST_DATA_DIR to the corrected prepared season directory.");
const SEASON_NAME = path.basename(path.resolve(BACKTEST_DIR));
if (!SEASONS.includes(SEASON_NAME as typeof SEASONS[number])) {
  throw new Error(`Unsupported held-out season ${SEASON_NAME}.`);
}
const DATA_ROOT = path.dirname(path.resolve(BACKTEST_DIR));
const RATING_SOURCE: "proxy" | "historical-clubelo" = (() => {
  const source = process.env.TIER_C_ELO_SOURCE ?? "proxy";
  if (source !== "proxy" && source !== "historical-clubelo") {
    throw new Error("Set TIER_C_ELO_SOURCE to proxy or historical-clubelo.");
  }
  return source;
})();
if (RATING_SOURCE === "historical-clubelo" && !process.env.TIER_C_OUTPUT_DIR) {
  throw new Error("Set TIER_C_OUTPUT_DIR to a separate directory for historical ClubElo runs.");
}
const OUTPUT_DIR = path.resolve(process.env.TIER_C_OUTPUT_DIR ?? "output/tier-c");
if (RATING_SOURCE === "historical-clubelo" && OUTPUT_DIR === path.resolve("output/tier-c")) {
  throw new Error("Historical ClubElo results need an output directory separate from output/tier-c.");
}
const HISTORY_FILE = path.resolve(process.env.TIER_C_CLUBELO_HISTORY_FILE ?? "scripts/backtest/results/clubelo-history.json");
const ARM = process.env.TIER_C_ARM as Arm | undefined;
const SOURCE_REF = process.env.TIER_C_SOURCE_REF ?? "unspecified";
const DIVISOR = ARM === "main" ? 150 : ARM === "candidate" ? 300 : undefined;
if (DIVISOR === undefined) throw new Error("Set TIER_C_ARM to main or candidate.");

function fail(message: string): never {
  throw new Error(message);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function hashFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fileHash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-10;
}

function assertFdrSource(): void {
  const ownElo = 1800;
  const opponentElo = 1920;
  const exact = Math.min(5, Math.max(1, 3 + (opponentElo - ownElo) / DIVISOR!));
  assert.ok(close(calculateContinuousClubEloFdr(ownElo, opponentElo, false), exact),
    `This checkout's continuous FDR does not use the expected ${DIVISOR}-point divisor.`);
  assert.equal(calculateClubEloFdr(ownElo, opponentElo, false), Math.round(exact),
    "Integer/display FDR should match the same production divisor.");
}

function teamForRow(row: MatchRow, fixtures: ReadonlyMap<number, Fixture>): number | undefined {
  const fixture = fixtures.get(row.fixtureId);
  return fixture ? (row.wasHome ? fixture.homeTeamId : fixture.awayTeamId) : undefined;
}

function normalizedName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function deduplicateSeason(season: Season): number {
  const fixtureById = new Map(season.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const { rows, duplicatesRemoved: duplicates } = deduplicateHistoricalFixtureRows(
    [...season.rowsByPlayer.values()].flat(),
  );
  if (duplicates === 0) return 0;

  season.rowsByGameweek = new Map();
  season.rowsByPlayer = new Map();
  const countsByPlayer = new Map<number, Map<number, number>>();
  for (const row of rows) {
    (season.rowsByGameweek.get(row.gameweek)
      ?? season.rowsByGameweek.set(row.gameweek, []).get(row.gameweek)!).push(row);
    (season.rowsByPlayer.get(row.historicalPlayerId)
      ?? season.rowsByPlayer.set(row.historicalPlayerId, []).get(row.historicalPlayerId)!).push(row);
    const teamId = teamForRow(row, fixtureById);
    if (teamId !== undefined) {
      const counts = countsByPlayer.get(row.historicalPlayerId)
        ?? countsByPlayer.set(row.historicalPlayerId, new Map()).get(row.historicalPlayerId)!;
      counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
    }
  }
  for (const playerRows of season.rowsByPlayer.values()) {
    playerRows.sort((a, b) => a.gameweek - b.gameweek || a.fixtureId - b.fixtureId);
  }
  season.teamOf = new Map([...countsByPlayer].map(([playerId, counts]) => {
    let bestTeam = -1;
    let bestCount = -1;
    for (const [teamId, count] of counts) {
      if (count > bestCount) { bestTeam = teamId; bestCount = count; }
    }
    return [playerId, bestTeam];
  }));
  const oldFixtures = new Map(season.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  season.fixtures = buildFixturesFromMatchRows(rows).map((fixture) => {
    const old = oldFixtures.get(fixture.fixtureId);
    return old ? { ...fixture, homeDifficulty: old.homeDifficulty, awayDifficulty: old.awayDifficulty } : fixture;
  });
  season.fixturesByGameweek = new Map();
  for (const fixture of season.fixtures) {
    (season.fixturesByGameweek.get(fixture.gameweek)
      ?? season.fixturesByGameweek.set(fixture.gameweek, []).get(fixture.gameweek)!).push(fixture);
  }
  const fixtureTotal = season.fixtures.reduce((sum, fixture) => sum + fixture.homeXg + fixture.awayXg, 0);
  season.leagueAverageXg = fixtureTotal / (season.fixtures.length * 2);
  return duplicates;
}

function loadHistorical(seasonName: string): {
  bundle: HistoricalBundle;
  historicalTeamStrengths: Record<number, TeamStrength>;
} {
  const previousSeason = `${Number(seasonName.slice(0, 4)) - 1}-${seasonName.slice(2, 4)}`;
  const targetDir = path.join(DATA_ROOT, seasonName);
  const previousDir = path.join(DATA_ROOT, previousSeason);
  const anchors = readJson<Array<{ historicalPlayerId: number; sourceHistoricalPlayerId: number }>>(
    path.join(targetDir, "previous-player-anchors.json"),
  );
  const previousPlayers = readJson<HistoricalPlayerRecord[]>(path.join(previousDir, "historical-players.json"));
  const previousRows = readJson<HistoricalMatchStat[]>(path.join(previousDir, "historical-match-stats.json"));
  const previousTeams = readJson<HistoricalTeamStrength[]>(path.join(previousDir, "team-strength.json"));
  const previousById = new Map<number, HistoricalPlayerRecord>(
    previousPlayers.map((player) => [player.historicalPlayerId, player]),
  );
  const currentIdByPreviousId = new Map(anchors.map((anchor) => [anchor.sourceHistoricalPlayerId, anchor.historicalPlayerId]));
  const matchStats = previousRows.flatMap((row) => {
    const historicalPlayerId = currentIdByPreviousId.get(row.historicalPlayerId);
    return historicalPlayerId === undefined ? [] : [{ ...row, historicalPlayerId }];
  });
  const teamEnrichment = previousTeams.map((team) => ({
    id: team.teamId,
    name: team.name,
    shortName: team.shortName,
    strength: {
      overallHome: team.overallHome,
      overallAway: team.overallAway,
      attackHome: team.attackHome,
      attackAway: team.attackAway,
      defenceHome: team.defenceHome,
      defenceAway: team.defenceAway,
    },
  }));
  const priorStrengths = deriveTeamStrengths(teamEnrichment).strengths;
  const strengthByName = new Map<string, TeamStrength>();
  previousTeams.forEach((team) => {
    const strength = priorStrengths[team.teamId];
    if (!strength) return;
    strengthByName.set(normalizedName(team.name), strength);
    strengthByName.set(normalizedName(team.shortName), strength);
  });
  const historicalTeamStrengths: Record<number, TeamStrength> = {};
  anchors.forEach((anchor) => {
    const previous = previousById.get(anchor.sourceHistoricalPlayerId);
    const sourceStrength = previous?.teamName
      ? strengthByName.get(normalizedName(previous.teamName))
      : undefined;
    if (sourceStrength) historicalTeamStrengths[anchor.historicalPlayerId] = sourceStrength;
  });
  return {
    bundle: {
      players: previousPlayers,
      matchStats,
      teamStrength: previousTeams,
      playerMappings: anchors.map((anchor) => ({
        currentPlayerId: anchor.historicalPlayerId,
        historicalPlayerId: anchor.historicalPlayerId,
        confidence: "EXACT",
      })),
      sourceSeason: previousSeason,
    },
    historicalTeamStrengths,
  };
}

function readElo(dataDir: string): Map<number, Map<number, number>> {
  const rows = readJson<WeekStartElo[]>(path.join(dataDir, "gameweek-start-elo.json"));
  return new Map(rows.map((row) => [row.gameweek, new Map(row.teams.map((team) => [team.teamId, team.elo]))]));
}

function countMatchesBefore(season: Season, gameweek: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (const fixture of rowsBeforeGameweek(season.fixtures, gameweek)) {
    counts.set(fixture.homeTeamId, (counts.get(fixture.homeTeamId) ?? 0) + 1);
    counts.set(fixture.awayTeamId, (counts.get(fixture.awayTeamId) ?? 0) + 1);
  }
  return counts;
}

function ratedStrengths(
  strengths: Record<number, TeamStrength>,
  ratings: ReadonlyMap<number, number>,
  teamInfo: readonly TeamInfo[],
  seasonName: string,
  played: ReadonlyMap<number, number>,
): ReturnType<typeof deriveCleanSheetStrengths> {
  for (const team of teamInfo) {
    assert.ok(Number.isFinite(ratings.get(team.teamId)), `${seasonName}: missing pre-GW Elo for ${team.name}.`);
  }
  const result = deriveCleanSheetStrengths(strengths, ratings, played);
  assert.equal(Object.keys(result).length, teamInfo.length, `${seasonName}: clean-sheet strengths were not rated for all teams.`);
  return result;
}

function eligibleFixturesBefore(season: Season, beforeGameweek: number): Map<number, Map<number, Fixture>> {
  const result = new Map<number, Map<number, Fixture>>();
  for (const [gameweek, fixtures] of season.fixturesByGameweek) {
    if (rowsBeforeGameweek([{ gameweek }], beforeGameweek).length === 0) continue;
    const matchesPerTeam = new Map<number, number>();
    for (const fixture of fixtures) {
      matchesPerTeam.set(fixture.homeTeamId, (matchesPerTeam.get(fixture.homeTeamId) ?? 0) + 1);
      matchesPerTeam.set(fixture.awayTeamId, (matchesPerTeam.get(fixture.awayTeamId) ?? 0) + 1);
    }
    const eligible = new Map<number, Fixture>();
    for (const fixture of fixtures) {
      if (matchesPerTeam.get(fixture.homeTeamId) === 1) eligible.set(fixture.homeTeamId, fixture);
      if (matchesPerTeam.get(fixture.awayTeamId) === 1) eligible.set(fixture.awayTeamId, fixture);
    }
    if (eligible.size) result.set(gameweek, eligible);
  }
  return result;
}

function currentTeamBefore(season: Season, playerId: number, gameweek: number, fixtureById: ReadonlyMap<number, Fixture>): number | undefined {
  const prior = rowsBeforeGameweek(season.rowsByPlayer.get(playerId) ?? [], gameweek);
  const latest = prior[prior.length - 1];
  return latest ? teamForRow(latest, fixtureById) : undefined;
}

function playerHistories(
  season: Season,
  playerId: number,
  teamId: number,
  beforeGameweek: number,
  fixtureById: ReadonlyMap<number, Fixture>,
  eligible: ReadonlyMap<number, ReadonlyMap<number, Fixture>>,
): { form: PlayerMatchRate[]; starts: StartObservation[] } {
  const rowsByWeek = new Map<number, MatchRow[]>();
  for (const row of rowsBeforeGameweek(season.rowsByPlayer.get(playerId) ?? [], beforeGameweek)) {
    if (teamForRow(row, fixtureById) !== teamId) continue;
    (rowsByWeek.get(row.gameweek) ?? rowsByWeek.set(row.gameweek, []).get(row.gameweek)!).push(row);
  }
  const form: PlayerMatchRate[] = [];
  const starts: StartObservation[] = [];
  for (const [week, eligibleTeams] of eligible) {
    const fixture = eligibleTeams.get(teamId);
    if (!fixture) continue;
    const rows = rowsByWeek.get(week) ?? [];
    if (!rows.length) continue; // Missing rows are not assumed to be DNPs.
    const minutes = rows.reduce((sum, row) => sum + row.minutes, 0);
    starts.push({ started: minutes >= 60, appeared: minutes > 0, minutes });
    if (minutes <= 0) continue;
    const wasHome = fixture.homeTeamId === teamId;
    form.push({
      xg: rows.reduce((sum, row) => sum + (row.expectedGoals ?? 0), 0),
      xa: rows.reduce((sum, row) => sum + (row.expectedAssists ?? 0), 0),
      minutes,
      opponentTeamId: wasHome ? fixture.awayTeamId : fixture.homeTeamId,
      wasHome,
    });
  }
  return { form, starts };
}

function makeFplFixture(
  fixture: Fixture,
  teamId: number,
  gameweek: number,
  eloByTeam: ReadonlyMap<number, number>,
): PlayerFixture {
  const isHome = fixture.homeTeamId === teamId;
  const opponentTeamId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
  const ownElo = eloByTeam.get(teamId);
  const opponentElo = eloByTeam.get(opponentTeamId);
  if (ownElo === undefined || opponentElo === undefined) fail(`Missing opening Elo for fixture ${fixture.fixtureId}.`);
  const difficulty = calculateClubEloFdr(ownElo, opponentElo, isHome);
  const exactDifficulty = calculateContinuousClubEloFdr(ownElo, opponentElo, isHome);
  assert.ok(close(exactDifficulty, Math.min(5, Math.max(1, 3 + (opponentElo - ownElo) / DIVISOR!))));
  return {
    fixtureId: fixture.fixtureId,
    gameweek,
    opponentTeamId,
    opponentShortName: "OPP",
    isHome,
    difficulty,
    exactDifficulty,
  };
}

function rmse(values: readonly number[]): number {
  assert.ok(values.length > 0, "RMSE needs at least one row.");
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

function metricRows(rows: readonly ScoreRow[]): Record<string, { n: number; rmse: number }> {
  const groups = new Map<string, ScoreRow[]>([["ALL", [...rows]]]);
  for (const row of rows) {
    const group = groups.get(row.position) ?? [];
    group.push(row);
    groups.set(row.position, group);
  }
  return Object.fromEntries([...groups].map(([key, group]) => [
    key,
    { n: group.length, rmse: rmse(group.map((row) => row.prediction - row.actual)) },
  ]));
}

function activeRowsForWeek(season: Season, gameweek: number): Map<number, MatchRow[]> {
  const groups = new Map<number, MatchRow[]>();
  for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
    (groups.get(row.historicalPlayerId) ?? groups.set(row.historicalPlayerId, []).get(row.historicalPlayerId)!).push(row);
  }
  return groups;
}

function runSeason(): PredictionFile {
  const season = loadSeason();
  if (!season.hasPreparedPriors) fail("Prepared adjacent-season anchors are required; refusing aggregate target-season priors.");
  const duplicates = deduplicateSeason(season);
  const { bundle: historical, historicalTeamStrengths } = loadHistorical(SEASON_NAME);
  const eloByWeek = RATING_SOURCE === "proxy" ? readElo(BACKTEST_DIR) : undefined;
  const history = RATING_SOURCE === "historical-clubelo" ? readClubEloHistoryCache(HISTORY_FILE) : undefined;
  const ratingHistorySha256 = RATING_SOURCE === "historical-clubelo" ? fileHash(HISTORY_FILE) : undefined;
  const teamInfo = readJson<TeamInfo[]>(path.join(BACKTEST_DIR, "team-strength.json"));
  const shortNameByTeam = new Map(teamInfo.map((team) => [team.teamId, team.shortName]));
  const fixtureById = new Map(season.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const teamNames = new Map(teamInfo.map((team) => [team.teamId, team.name]));
  const ratingsAsOfByGameweek: SeasonResult["ratingsAsOfByGameweek"] = {};
  const hashRoot = path.resolve(__dirname, "../..");
  const productionHashes = Object.fromEntries([
    "lib/clubElo.ts",
    "lib/availability/selection.ts",
    "lib/projections/projectPlayer.ts",
  ].map((file) => [file, hashFile(path.join(hashRoot, file))]));
  const inputFiles = [
    "historical-match-stats.json",
    "historical-players.json",
    "previous-player-anchors.json",
    "preseason-team-strength.json",
    "fixture-difficulty.json",
    ...(RATING_SOURCE === "proxy" ? ["gameweek-start-elo.json"] : []),
  ];
  const inputHashes: Record<string, string> = Object.fromEntries(
    inputFiles.map((file) => [file, fileHash(path.join(BACKTEST_DIR, file))]),
  );
  if (ratingHistorySha256) inputHashes["clubelo-history.json"] = ratingHistorySha256;
  const previousSeason = `${Number(SEASON_NAME.slice(0, 4)) - 1}-${SEASON_NAME.slice(2, 4)}`;
  for (const file of ["historical-match-stats.json", "historical-players.json", "team-strength.json"]) {
    inputHashes[`previous-${file}`] = fileHash(path.join(DATA_ROOT, previousSeason, file));
  }
  const scored: ScoreRow[] = [];
  let sourceRows = 0;
  let sourceZeroMinuteRows = 0;
  let sourcePlayerGameweeks = 0;
  let scoredZeroMinutePlayerGameweeks = 0;
  let scoredStarts = 0;
  let scoredShortAppearances = 0;
  let coldStarts = 0;
  let unsupportedPositions = 0;
  let teamMismatches = 0;
  let incompleteRows = 0;
  let scheduledGameweeks = 0;
  let scheduledDoubleTeamGameweeks = 0;
  let ratedTeamStrengths = 0;
  const scoredPlayers = new Set<number>();
  assertFdrSource();

  for (let gameweek = FIRST_GAMEWEEK; gameweek <= LAST_GAMEWEEK; gameweek += 1) {
    const targetFixtures = season.fixturesByGameweek.get(gameweek) ?? [];
    if (!targetFixtures.length) continue;
    scheduledGameweeks += 1;
    const fixtureByWeek = new Map(targetFixtures.map((fixture) => [fixture.fixtureId, fixture]));
    const targetRows = season.rowsByGameweek.get(gameweek) ?? [];
    sourceRows += targetRows.length;
    sourceZeroMinuteRows += targetRows.filter((row) => row.minutes === 0).length;
    const groups = activeRowsForWeek(season, gameweek);
    sourcePlayerGameweeks += groups.size;
    let eloByTeam: ReadonlyMap<number, number>;
    if (RATING_SOURCE === "proxy") {
      const proxyRatings = eloByWeek?.get(gameweek);
      if (!proxyRatings) fail(`${SEASON_NAME} GW${gameweek}: no gameweek-opening Elo snapshot.`);
      eloByTeam = proxyRatings;
    } else {
      if (!history) fail("Historical ClubElo cache was not loaded.");
      const cutoffDate = targetFixtures
        .map((fixture) => clubEloFixture(history, SEASON_NAME, fixture.fixtureId).date)
        .sort()[0];
      if (!cutoffDate) fail(`${SEASON_NAME} GW${gameweek}: no dated fixture in the ClubElo panel.`);
      const datedRatings = clubEloRatingsBeforeDate(history, teamInfo, cutoffDate);
      eloByTeam = datedRatings.ratings;
      ratingsAsOfByGameweek[String(gameweek)] = { cutoffDate, teams: datedRatings.asOf };
    }
    const strengths = strengthsBefore(season, gameweek);
    const csStrengths = ratedStrengths(
      strengths,
      eloByTeam,
      teamInfo,
      SEASON_NAME,
      countMatchesBefore(season, gameweek),
    );
    ratedTeamStrengths = Object.keys(csStrengths).length;
    const eligible = eligibleFixturesBefore(season, gameweek);
    const matchesPerTeam = new Map<number, number>();
    for (const fixture of targetFixtures) {
      matchesPerTeam.set(fixture.homeTeamId, (matchesPerTeam.get(fixture.homeTeamId) ?? 0) + 1);
      matchesPerTeam.set(fixture.awayTeamId, (matchesPerTeam.get(fixture.awayTeamId) ?? 0) + 1);
    }
    scheduledDoubleTeamGameweeks += [...matchesPerTeam.values()].filter((count) => count > 1).length;
    const players: Player[] = [];
    const formByPlayer: Record<number, PlayerMatchRate[]> = {};
    const startsByPlayer: Record<number, StartObservation[]> = {};
    const scoreGroupByPlayer = new Map<number, MatchRow[]>();

    for (const [playerId, rows] of groups) {
      const source = season.players.get(playerId);
      if (!source) continue;
      if (source.position !== "GK" && source.position !== "DEF" && source.position !== "MID" && source.position !== "FWD") {
        unsupportedPositions += 1;
        continue;
      }
      const forecastTeam = currentTeamBefore(season, playerId, gameweek, fixtureById);
      if (forecastTeam === undefined) {
        coldStarts += 1;
        continue;
      }
      const currentTargetRows = rows.filter((row) => {
        const fixture = fixtureByWeek.get(row.fixtureId);
        return fixture && teamForRow(row, fixtureById) === forecastTeam;
      });
      if (currentTargetRows.length !== rows.length) {
        teamMismatches += 1;
        continue;
      }
      const teamFixtures = targetFixtures.filter((fixture) =>
        fixture.homeTeamId === forecastTeam || fixture.awayTeamId === forecastTeam);
      if (!teamFixtures.length || currentTargetRows.length !== teamFixtures.length
        || new Set(currentTargetRows.map((row) => row.fixtureId)).size !== teamFixtures.length) {
        incompleteRows += 1;
        continue;
      }
      const sourceTeamFixtures = currentTargetRows.map((row) => row.fixtureId).sort((a, b) => a - b);
      const scheduledTeamFixtures = teamFixtures.map((fixture) => fixture.fixtureId).sort((a, b) => a - b);
      if (sourceTeamFixtures.some((fixtureId, index) => fixtureId !== scheduledTeamFixtures[index])) {
        incompleteRows += 1;
        continue;
      }
      const reference = teamFixtures[0];
      const wasHome = reference.homeTeamId === forecastTeam;
      const player = playerAt(season, playerId, gameweek, reference, wasHome);
      if (!player) continue;
      player.teamId = forecastTeam;
      player.teamName = teamNames.get(forecastTeam) ?? source.teamName;
      player.teamShortName = shortNameByTeam.get(forecastTeam) ?? "TST";
      // Historical per-GW market prices are not part of the prepared corpus.
      // A common mid-market value keeps both production arms on the same prior.
      player.priceTenths = PRICE_PRIOR_TENTHS;
      player.status = "a";
      player.chanceOfPlaying = undefined;
      player.fixtures = teamFixtures.map((fixture) => makeFplFixture(fixture, forecastTeam, gameweek, eloByTeam));
      const history = playerHistories(season, playerId, forecastTeam, gameweek, fixtureById, eligible);
      startsByPlayer[playerId] = history.starts;
      formByPlayer[playerId] = history.form;
      players.push(player);
      scoreGroupByPlayer.set(playerId, currentTargetRows);
    }
    if (!players.length) continue;

    const selections = buildPlayerSelections(players, {
      historical,
      historicalStats: season.previousStatsByPlayerId,
      startHistory: startsByPlayer,
      targetGameweek: gameweek,
    });
    const selected = players.map((player) => ({ ...player, selection: selections.get(player.id) }));
    const playerForm = Object.fromEntries(selected.map((player) => [player.id, formByPlayer[player.id] ?? []]));
    for (const player of selected) {
      const prediction = projectPlayer(player, {
        currentGameweek: gameweek,
        horizon: 1,
        teamStrengths: strengths,
        cleanSheetStrengths: csStrengths,
        historicalTeamStrengths,
        playerForm,
      });
      const targetRowsForPlayer = scoreGroupByPlayer.get(player.id);
      if (!targetRowsForPlayer) fail(`Missing actual rows for ${player.id} GW${gameweek}.`);
      const actual = targetRowsForPlayer.reduce((sum, row) => sum + row.totalPoints, 0);
      const actualMinutes = targetRowsForPlayer.reduce((sum, row) => sum + row.minutes, 0);
      const outcome = recordedFixtureOutcome(targetRowsForPlayer.length ? actualMinutes : undefined);
      assert.notEqual(outcome, "NOT_RECORDED", `${player.id} GW${gameweek}: scored outcome has no recorded player-fixture row.`);
      const predictionValue = prediction.nextGW;
      assert.ok(Number.isFinite(predictionValue), `${player.id} GW${gameweek}: non-finite xP.`);
      assert.equal(prediction.fixtures.length, targetRowsForPlayer.length,
        `${player.id} GW${gameweek}: projected fixture count differs from observed corpus rows.`);
      const row: ScoreRow = {
        playerId: player.id,
        gameweek,
        position: player.position,
        actual,
        prediction: predictionValue,
        actualMinutes,
        fixtureCount: targetRowsForPlayer.length,
      };
      scored.push(row);
      scoredPlayers.add(player.id);
      if (outcome === "DNP") scoredZeroMinutePlayerGameweeks += 1;
      else if (actualMinutes >= 60) scoredStarts += 1;
      else scoredShortAppearances += 1;
    }
    console.log(`${SEASON_NAME} GW${gameweek}: source=${groups.size} scored=${scoreGroupByPlayer.size} after team/coverage filters`);
  }
  assert.ok(scored.length > 0, `${SEASON_NAME}: no player-gameweeks were scored.`);
  assert.equal(scored.length, new Set(scored.map((row) => `${row.playerId}:${row.gameweek}`)).size,
    "A player-gameweek may only be scored once.");
  assert.ok(scored.every((row) => Number.isFinite(row.prediction) && Number.isFinite(row.actual)), "All scored predictions/outcomes must be finite.");
  const result: PredictionFile = {
    season: SEASON_NAME,
    arm: ARM!,
    sourceRef: SOURCE_REF,
    fdrDivisor: DIVISOR!,
    ratingSource: RATING_SOURCE,
    ...(ratingHistorySha256 ? { ratingHistorySha256 } : {}),
    ratingsAsOfByGameweek,
    productionHashes,
    inputHashes,
    coverage: {
      sourceRows,
      deduplicatedPreparedRows: duplicates,
      sourceZeroMinuteRows,
      sourcePlayerGameweeks,
      scoredPlayerGameweeks: scored.length,
      scoredZeroMinutePlayerGameweeks,
      scoredStarts,
      scoredShortAppearances,
      excludedColdStartPlayerGameweeks: coldStarts,
      excludedUnsupportedPositionPlayerGameweeks: unsupportedPositions,
      excludedPriorTeamMismatchPlayerGameweeks: teamMismatches,
      excludedIncompleteFixtureRows: incompleteRows,
      scheduledGameweeks,
      scheduledDoubleTeamGameweeks,
      cleanSheetTeamStrengths: ratedTeamStrengths,
      players: scoredPlayers.size,
    },
    metrics: metricRows(scored),
    rows: scored.sort((a, b) => a.gameweek - b.gameweek || a.playerId - b.playerId),
  };
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const output = path.join(OUTPUT_DIR, `combined-${ARM}-${SEASON_NAME}.json`);
  writeFileSync(output, `${JSON.stringify(result)}\n`);
  console.log(`${SEASON_NAME} ${ARM}: ${result.metrics.ALL.rmse.toFixed(5)} xP RMSE over ${result.rows.length} player-GWs.`);
  console.log(`Wrote ${output}; production hashes=${JSON.stringify(productionHashes)}`);
  console.log(`Coverage: ${JSON.stringify(result.coverage)}`);
  return result;
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

function quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position);
  const fraction = position - low;
  return sorted[low] * (1 - fraction) + sorted[Math.min(low + 1, sorted.length - 1)] * fraction;
}

function squaredError(rows: readonly ScoreRow[], position?: Position): number {
  return rows.reduce((sum, row) => sum + (position && row.position !== position ? 0 : (row.prediction - row.actual) ** 2), 0);
}

function rowCount(rows: readonly ScoreRow[], position?: Position): number {
  return rows.reduce((sum, row) => sum + (position && row.position !== position ? 0 : 1), 0);
}

function summarizePair(
  seasonRows: ReadonlyMap<string, { main: ScoreRow[]; candidate: ScoreRow[] }>,
  position: Position | undefined,
  seed: number,
): { mainRmse: number; candidateRmse: number; delta: number; ci: [number, number]; n: number; clusters: number } {
  const seasonNames = [...seasonRows.keys()].sort();
  const allMain = seasonNames.flatMap((season) => seasonRows.get(season)!.main);
  const allCandidate = seasonNames.flatMap((season) => seasonRows.get(season)!.candidate);
  const mainSse = squaredError(allMain, position);
  const candidateSse = squaredError(allCandidate, position);
  const n = rowCount(allMain, position);
  assert.equal(n, rowCount(allCandidate, position), "Paired comparison arms have different sample sizes.");
  const clustersBySeason = new Map<string, Array<{ mainSse: number; candidateSse: number; n: number }>>();
  for (const season of seasonNames) {
    const pair = seasonRows.get(season)!;
    const gws = [...new Set(pair.main.map((row) => row.gameweek))].sort((a, b) => a - b);
    clustersBySeason.set(season, gws.map((gameweek) => {
      const main = pair.main.filter((row) => row.gameweek === gameweek);
      const candidate = pair.candidate.filter((row) => row.gameweek === gameweek);
      assert.equal(main.length, candidate.length, `${season} GW${gameweek}: pair row count mismatch.`);
      return {
        mainSse: squaredError(main, position),
        candidateSse: squaredError(candidate, position),
        n: rowCount(main, position),
      };
    }));
  }
  const random = seededRandom(seed);
  const deltas = new Array<number>(FIXED_BOOTSTRAPS);
  for (let draw = 0; draw < FIXED_BOOTSTRAPS; draw += 1) {
    let sampleMain = 0;
    let sampleCandidate = 0;
    let sampleN = 0;
    for (const clusters of clustersBySeason.values()) {
      for (let i = 0; i < clusters.length; i += 1) {
        const cluster = clusters[Math.floor(random() * clusters.length)];
        sampleMain += cluster.mainSse;
        sampleCandidate += cluster.candidateSse;
        sampleN += cluster.n;
      }
    }
    deltas[draw] = Math.sqrt(sampleCandidate / sampleN) - Math.sqrt(sampleMain / sampleN);
  }
  deltas.sort((a, b) => a - b);
  const mainRmse = Math.sqrt(mainSse / n);
  const candidateRmse = Math.sqrt(candidateSse / n);
  return {
    mainRmse,
    candidateRmse,
    delta: candidateRmse - mainRmse,
    ci: [quantile(deltas, 0.025), quantile(deltas, 0.975)],
    n,
    clusters: [...clustersBySeason.values()].reduce((sum, clusters) => sum + clusters.length, 0),
  };
}

function summarize(): void {
  const bySeason = new Map<string, { main: ScoreRow[]; candidate: ScoreRow[] }>();
  for (const season of SEASONS) {
    const mainPath = path.join(OUTPUT_DIR, `combined-main-${season}.json`);
    const candidatePath = path.join(OUTPUT_DIR, `combined-candidate-${season}.json`);
    if (!existsSync(mainPath) || !existsSync(candidatePath)) fail(`Missing paired files for ${season}: ${mainPath}, ${candidatePath}`);
    const main = readJson<HeldoutFile>(mainPath);
    const candidate = readJson<HeldoutFile>(candidatePath);
    const mainFull = readJson<PredictionFile>(mainPath);
    const candidateFull = readJson<PredictionFile>(candidatePath);
    assert.equal(main.season, season);
    assert.equal(candidate.season, season);
    assert.equal(main.arm, "main");
    assert.equal(candidate.arm, "candidate");
    assert.equal(mainFull.ratingSource, RATING_SOURCE, `${season}: main file uses a different Elo source than requested.`);
    assert.equal(candidateFull.ratingSource, RATING_SOURCE, `${season}: candidate file uses a different Elo source than requested.`);
    assert.equal(mainFull.ratingHistorySha256, candidateFull.ratingHistorySha256,
      `${season}: main and candidate used different historical ClubElo files.`);
    assert.deepEqual(mainFull.ratingsAsOfByGameweek, candidateFull.ratingsAsOfByGameweek,
      `${season}: main and candidate used different point-in-time ratings.`);
    assert.equal(main.rows.length, candidate.rows.length, `${season}: row count changed between arms.`);
    assert.deepEqual(mainFull.inputHashes, candidateFull.inputHashes,
      `${season}: main and candidate did not use identical prepared inputs.`);
    assert.equal(mainFull.sourceRef, "74ceff274962102b5d774043b29783b22be13d75");
    assert.equal(mainFull.fdrDivisor, 150);
    assert.equal(candidateFull.fdrDivisor, 300);
    for (const file of ["lib/clubElo.ts", "lib/availability/selection.ts", "lib/projections/projectPlayer.ts"]) {
      assert.notEqual(mainFull.productionHashes[file], candidateFull.productionHashes[file],
        `${season}: expected a source change in ${file}.`);
    }
    const mainByKey = new Map(main.rows.map((row) => [`${row.playerId}:${row.gameweek}`, row]));
    for (const row of candidate.rows) {
      const old = mainByKey.get(`${row.playerId}:${row.gameweek}`);
      assert.ok(old, `${season}: candidate introduced ${row.playerId} GW${row.gameweek}.`);
      assert.equal(row.position, old.position, `${season} player position changed between arms.`);
      assert.equal(row.actual, old.actual, `${season} outcome changed between arms.`);
      assert.equal(row.actualMinutes, old.actualMinutes, `${season} minutes changed between arms.`);
      assert.equal(row.fixtureCount, old.fixtureCount, `${season} fixture coverage changed between arms.`);
    }
    bySeason.set(season, { main: main.rows, candidate: candidate.rows });
  }
  const report = {
    ratingSource: RATING_SOURCE,
    ratingHistorySha256: readJson<PredictionFile>(path.join(OUTPUT_DIR, "combined-main-2024-25.json")).ratingHistorySha256,
    seasons: Object.fromEntries([...bySeason].map(([season, pair]) => [season, {
      main: metricRows(pair.main),
      candidate: metricRows(pair.candidate),
      coverage: readJson<PredictionFile>(path.join(OUTPUT_DIR, `combined-candidate-${season}.json`)).coverage,
    }])),
    perSeasonPaired: Object.fromEntries([...bySeason].map(([season, pair], index) => [season,
      Object.fromEntries([undefined, "GK", "DEF", "MID", "FWD"].map((position) => [
        position ?? "ALL",
        summarizePair(new Map([[season, pair]]), position as Position | undefined, 0x7c202608 + index * 100 + (position?.length ?? 0)),
      ])),
    ])),
    pooled: Object.fromEntries([undefined, "GK", "DEF", "MID", "FWD"].map((position) => [
      position ?? "ALL",
      summarizePair(bySeason, position as Position | undefined, 0x7c202608 + (position?.length ?? 0)),
    ])),
    sourceRefs: {
      main: "74ceff274962102b5d774043b29783b22be13d75",
      candidate: readJson<PredictionFile>(path.join(OUTPUT_DIR, "combined-candidate-2024-25.json")).sourceRef,
    },
    productionHashes: {
      main: readJson<PredictionFile>(path.join(OUTPUT_DIR, "combined-main-2024-25.json")).productionHashes,
      candidate: readJson<PredictionFile>(path.join(OUTPUT_DIR, "combined-candidate-2024-25.json")).productionHashes,
    },
    bootstrap: { draws: FIXED_BOOTSTRAPS, method: "paired GW-cluster percentile; resample GWs within each season, preserving each season's cluster count" },
    direction: "delta is candidate minus main RMSE; negative means improvement",
  };
  writeFileSync(path.join(OUTPUT_DIR, "combined-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

function main(): void {
  const command = process.argv[2] ?? "run";
  if (command === "run") runSeason();
  else if (command === "summarize") summarize();
  else fail(`Unknown command ${command}; use run or summarize.`);
}

main();
