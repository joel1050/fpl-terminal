/**
 * Reproducible ClubElo attack/defence multiplier experiment.
 *
 *   BACKTEST_ATTACK_DEFENSE_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008 \
 *     npx tsx scripts/backtest/attackdefensemult-testing.ts freeze
 *   BACKTEST_ATTACK_DEFENSE_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008 \
 *     npx tsx scripts/backtest/attackdefensemult-testing.ts run
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gzipSync } from "node:zlib";
import type { HistoricalBundle, HistoricalMatchStat, HistoricalPlayerRecord, HistoricalTeamStrength } from "@/lib/historical/types";
import { calculateClubEloFdr, calculateContinuousClubEloFdr, CLUB_ELO_SNAPSHOT } from "@/lib/clubElo";
import { buildPlayerSelections } from "@/lib/availability/selection";
import type { StartObservation } from "@/lib/availability/startRate";
import { deriveTeamStrengths } from "@/lib/historical/enrichPlayers";
import {
  ELO_LEVEL_SLOPE,
  CLEAN_SHEET_SKEW_WEIGHT,
  CLEAN_SHEET_LEVEL_PRIOR_MATCHES,
  deriveCleanSheetStrengths,
} from "@/lib/projections/cleanSheetStrength";
import { projectPlayer, aggregateFixturePointsByGameweek } from "@/lib/projections/projectPlayer";
import {
  AWAY_ATTACK_MULTIPLIER,
  CLEAN_SHEET_DISPERSION,
  HOME_ATTACK_MULTIPLIER,
  LEAGUE_MEAN_XG,
  calculateFixtureAdjustment,
  continuousDifficultyMultiplier,
} from "@/lib/projections/fixtureAdjustment";
import type { FixtureAdjustmentResult } from "@/lib/projections/fixtureAdjustment";
import type { Player, PlayerFixture, Position } from "@/types/player";
import type { PlayerMatchRate, TeamStrength } from "@/types/projection";
import {
  BASELINE_ATTACK_CURVE,
  BASELINE_ATTACK_DEFENSE_MODEL,
  DEFAULT_REGULARIZATION_GRID,
  ATTACK_RATIO_BOUNDS,
  ATTACK_MULTIPLIER_BOUNDS,
  CURVE_MULTIPLIER_BOUNDS,
  RATIO_EXPONENT_BOUNDS,
  RAW_ELO_COEFFICIENT_BOUNDS,
  clubEloReferenceFromFitRows,
  evaluateAttackDefenseModel,
  fitDifficultyCurveGrid,
  fitRawEloModelGrid,
  latestStrictlyPriorElo,
  pairedGameweekClusterBootstrap,
  poissonQuasiDeviance,
  type AttackDefenseFitRow,
  type AttackDefenseModel,
  type PairedMetricKind,
  type PairedMetricRow,
} from "./attackdefensemult-model";
import { attackdefensemultFixtureAdjustment } from "./attackdefensemult-adjustment";
import {
  deduplicateHistoricalFixtureRows,
  recordedFixtureOutcome,
  rowsBeforeGameweek,
} from "./historicalBacktest";
import { buildFixturesFromMatchRows } from "./multiSeasonData";
import {
  loadSeason,
  playerAt,
  strengthsBefore,
  type Fixture,
  type MatchRow,
  type Season,
} from "./season";
import {
  clubEloFixture,
  clubEloRatingsBeforeDate,
  readClubEloHistoryCache,
} from "./clubelo-history";
import { splitCsvLine } from "./vaastavFixtures";

const REPO = process.cwd();
const DATA_ROOT = path.resolve(process.env.BACKTEST_ATTACK_DEFENSE_DATA_DIR
  ?? "/tmp/fpl-tier-c-elo-corrected-20261008");
const OUTPUT = path.resolve(process.env.ATTACKDEFENSEMULT_OUTPUT_DIR
  ?? "output/attackdefensemult-testing");
const RESULT_JSON = path.resolve("scripts/backtest/results/attackdefensemult-testing.json");
const RESULT_MD = path.resolve("scripts/backtest/results/attackdefensemult-testing.md");
const ELO_HISTORY_FILE = path.resolve(process.env.ATTACKDEFENSEMULT_CLUBELO_HISTORY_FILE
  ?? "scripts/backtest/results/clubelo-history.json");
const SEASONS = ["2023-24", "2024-25", "2025-26"] as const;
const BOOTSTRAP_DRAWS = 5_000;
const BOOTSTRAP_SEED = 0xad202610;
const PRICE_PRIOR_TENTHS = 50;
const STARTER_PROBABILITY_THRESHOLD = 0.5;
const STALE_RATING_DAYS = 30;
const REGULARIZATION_GRID = [...DEFAULT_REGULARIZATION_GRID];
const VARIANT_FILE = path.join(OUTPUT, "variants/projectPlayer.ts");
const PROTOCOL_FILE = path.join(OUTPUT, "frozen-protocol.json");

interface TeamIdentity {
  teamId: number;
  name: string;
  shortName: string;
}

interface FixtureCsvRow {
  id: number;
  kickoff: string;
  teamHome: number;
  teamAway: number;
  homeScore: number;
  awayScore: number;
}

interface EloAsOf {
  teamId: number;
  shortName: string;
  slug: string;
  elo: number;
  ratingDate: string;
  lagDays: number;
}

interface FixtureContext {
  fixture: Fixture;
  kickoffDate: string;
  cutoffDate: string;
  homeScore: number;
  awayScore: number;
  homeElo: EloAsOf;
  awayElo: EloAsOf;
  strengths: Record<number, TeamStrength>;
  cleanSheetStrengths: ReturnType<typeof deriveCleanSheetStrengths>;
}

interface TeamObservation {
  season: string;
  gameweek: number;
  fixtureId: number;
  cutoffDate: string;
  kickoffDate: string;
  teamId: number;
  opponentTeamId: number;
  teamShortName: string;
  opponentShortName: string;
  isHome: boolean;
  ownElo: number;
  opponentElo: number;
  ownRatingDate: string;
  opponentRatingDate: string;
  ownRatingLagDays: number;
  opponentRatingLagDays: number;
  difficulty: number;
  ownTeam: TeamStrength;
  opponentTeam: TeamStrength;
  ownCleanSheet: { attack: number; defence: number };
  opponentCleanSheet: { attack: number; defence: number };
  attackRatio: number;
  ratedConcedingRatio: number;
  observedTeamXg: number;
  observedOpponentXg: number;
  observedGoals: number;
  observedGoalsAgainst: number;
  observedCleanSheet: number;
  staleRating: boolean;
  predictions?: Record<string, TeamArmPrediction>;
}

interface TeamArmPrediction {
  attackMultiplier: number;
  attackMultiplierRaw: number;
  predictedAttackXg: number;
  expectedGoalsAgainst: number;
  cleanSheetProbability: number;
  attackClampBound: "low" | "high" | null;
}

interface PlayerArmPrediction {
  prediction: number;
  expectedMinutes: number;
  components: Record<string, number>;
  fixtureComponents: Array<{ fixtureId: number; components: Record<string, number> }>;
}

interface PlayerForecastRow {
  season: string;
  gameweek: number;
  playerId: number;
  position: Position;
  forecastStarter: boolean;
  actual: number;
  actualMinutes: number;
  fixtureCount: number;
  actualGoalPoints: number;
  actualAssistPoints: number;
  actualCleanSheetPoints: number;
  allFixtureRatingsFresh: boolean;
  arms: Record<string, PlayerArmPrediction>;
}

interface ModelArm {
  id: string;
  label: string;
  model: AttackDefenseModel;
  role: "baseline" | "primary-candidate" | "diagnostic";
  fit?: unknown;
}

interface SeasonContext {
  seasonName: string;
  season: Season;
  teamInfo: TeamIdentity[];
  teamById: Map<number, TeamIdentity>;
  fixtureById: Map<number, FixtureContext>;
  fixturesByGameweek: Map<number, FixtureContext[]>;
  eloAsOfByGameweek: Record<string, { cutoffDate: string; teams: EloAsOf[] }>;
  duplicateRowsRemoved: number;
  rawRows: number;
  coverage: Record<string, number | Record<string, number>>;
  observations: TeamObservation[];
  historical: HistoricalBundle;
  historicalTeamStrengths: Record<number, TeamStrength>;
}

interface FrozenProtocol {
  experiment: string;
  createdAt: string;
  gitHead: string;
  dirtyTreePorcelain: string;
  dirtyTreeSha256: string;
  dataRoot: string;
  outputRoot: string;
  clubEloHistoryPath: string;
  clubEloHistorySha256: string;
  sourceHashes: Record<string, string>;
  inputHashes: Record<string, string>;
  generatedVariantPath: string;
  generatedVariantSha256: string;
  generatedVariantPatch: string[];
  fitReferenceElo: number;
  protocol: Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trimEnd();
}

function assertFile(file: string): void {
  if (!existsSync(file)) throw new Error(`Required experiment input is missing: ${file}`);
}

function round(value: number, places = 6): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function dateInLondon(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid fixture kickoff timestamp: ${isoTimestamp}`);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function readFixtureCsv(seasonName: string): Map<number, FixtureCsvRow> {
  const file = path.join(DATA_ROOT, `fixtures-${seasonName}.csv`);
  assertFile(file);
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error(`${seasonName}: fixture CSV is empty.`);
  const header = splitCsvLine(lines[0]);
  const index = (name: string) => {
    const found = header.indexOf(name);
    if (found < 0) throw new Error(`${seasonName}: fixture CSV has no ${name} field.`);
    return found;
  };
  const columns = {
    id: index("id"), kickoff: index("kickoff_time"), home: index("team_h"), away: index("team_a"),
    homeScore: index("team_h_score"), awayScore: index("team_a_score"),
  };
  const rows = new Map<number, FixtureCsvRow>();
  for (const [lineOffset, line] of lines.slice(1).entries()) {
    const cells = splitCsvLine(line);
    const homeScoreCell = cells[columns.homeScore]?.trim() ?? "";
    const awayScoreCell = cells[columns.awayScore]?.trim() ?? "";
    const row: FixtureCsvRow = {
      id: Number(cells[columns.id]),
      kickoff: cells[columns.kickoff],
      teamHome: Number(cells[columns.home]),
      teamAway: Number(cells[columns.away]),
      homeScore: homeScoreCell === "" ? Number.NaN : Number(homeScoreCell),
      awayScore: awayScoreCell === "" ? Number.NaN : Number(awayScoreCell),
    };
    if (!Number.isInteger(row.id) || !Number.isFinite(Date.parse(row.kickoff))
      || !Number.isInteger(row.teamHome) || !Number.isInteger(row.teamAway)
      || row.teamHome === row.teamAway) {
      throw new Error(`${seasonName}: malformed fixture CSV row ${lineOffset + 2}.`);
    }
    if (rows.has(row.id)) throw new Error(`${seasonName}: duplicate fixture CSV id ${row.id}.`);
    rows.set(row.id, row);
  }
  return rows;
}

function normalizedName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function teamForRow(row: MatchRow, fixtures: ReadonlyMap<number, Fixture>): number | undefined {
  const fixture = fixtures.get(row.fixtureId);
  if (!fixture) return undefined;
  return row.wasHome ? fixture.homeTeamId : fixture.awayTeamId;
}

function rebuildDeduplicatedSeason(season: Season): number {
  const initialFixtureById = new Map(season.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const raw = [...season.rowsByPlayer.values()].flat();
  const { rows, duplicatesRemoved } = deduplicateHistoricalFixtureRows(raw);
  const countsByPlayer = new Map<number, Map<number, number>>();
  season.rowsByGameweek = new Map();
  season.rowsByPlayer = new Map();
  for (const row of rows) {
    if (row.expectedGoals === undefined || !Number.isFinite(row.expectedGoals) || row.expectedGoals < 0) {
      throw new Error(`${season.players.get(row.historicalPlayerId)?.displayName ?? row.historicalPlayerId} fixture ${row.fixtureId}: missing or invalid xG.`);
    }
    (season.rowsByGameweek.get(row.gameweek) ?? season.rowsByGameweek.set(row.gameweek, []).get(row.gameweek)!).push(row);
    (season.rowsByPlayer.get(row.historicalPlayerId) ?? season.rowsByPlayer.set(row.historicalPlayerId, []).get(row.historicalPlayerId)!).push(row);
    const teamId = teamForRow(row, initialFixtureById);
    if (teamId !== undefined) {
      const counts = countsByPlayer.get(row.historicalPlayerId)
        ?? countsByPlayer.set(row.historicalPlayerId, new Map()).get(row.historicalPlayerId)!;
      counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
    }
  }
  for (const playerRows of season.rowsByPlayer.values()) {
    playerRows.sort((left, right) => left.gameweek - right.gameweek || left.fixtureId - right.fixtureId);
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
  for (const values of season.rowsByGameweek.values()) values.sort((left, right) => left.fixtureId - right.fixtureId);
  const totalXg = season.fixtures.reduce((sum, fixture) => sum + fixture.homeXg + fixture.awayXg, 0);
  season.leagueAverageXg = totalXg / (season.fixtures.length * 2);
  return duplicatesRemoved;
}

function loadHistoricalForSeason(seasonName: string): {
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
  const previousById = new Map(previousPlayers.map((player) => [player.historicalPlayerId, player]));
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
    if (strength) {
      strengthByName.set(normalizedName(team.name ?? ""), strength);
      strengthByName.set(normalizedName(team.shortName ?? ""), strength);
    }
  });
  const historicalTeamStrengths: Record<number, TeamStrength> = {};
  anchors.forEach((anchor) => {
    const previous = previousById.get(anchor.sourceHistoricalPlayerId);
    const sourceStrength = previous?.teamName ? strengthByName.get(normalizedName(previous.teamName)) : undefined;
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

function countMatchesBefore(season: Season, gameweek: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (const fixture of season.fixtures) {
    if (fixture.gameweek >= gameweek) continue;
    counts.set(fixture.homeTeamId, (counts.get(fixture.homeTeamId) ?? 0) + 1);
    counts.set(fixture.awayTeamId, (counts.get(fixture.awayTeamId) ?? 0) + 1);
  }
  return counts;
}

function readTeamIdentities(inputDir: string): TeamIdentity[] {
  const rows = readJson<HistoricalTeamStrength[]>(path.join(inputDir, "preseason-team-strength.json"));
  if (!rows.length) throw new Error(`${inputDir}: preseason team strengths are empty.`);
  return rows.map((row) => {
    if (!Number.isInteger(row.teamId) || !row.name || !row.shortName) {
      throw new Error(`${inputDir}: preseason team identity is incomplete.`);
    }
    return { teamId: row.teamId, name: row.name, shortName: row.shortName };
  });
}

function exactPriorTeam(
  season: Season,
  playerId: number,
  targetGameweek: number,
  fixtureById: ReadonlyMap<number, Fixture>,
): number | undefined {
  const prior = rowsBeforeGameweek(season.rowsByPlayer.get(playerId) ?? [], targetGameweek);
  if (!prior.length) return undefined;
  const lastWeek = Math.max(...prior.map((row) => row.gameweek));
  const lastRows = prior.filter((row) => row.gameweek === lastWeek);
  const teams = new Set(lastRows.map((row) => teamForRow(row, fixtureById)).filter((value) => value !== undefined));
  return teams.size === 1 ? [...teams][0] : undefined;
}

function priorSeasonTeamByPlayer(
  seasonName: string,
  targetDir: string,
  teamByName: ReadonlyMap<string, number>,
): Map<number, number> {
  const previousSeason = `${Number(seasonName.slice(0, 4)) - 1}-${seasonName.slice(2, 4)}`;
  const anchors = readJson<Array<{ historicalPlayerId: number; sourceHistoricalPlayerId: number }>>(
    path.join(targetDir, "previous-player-anchors.json"),
  );
  const previousPlayers = readJson<HistoricalPlayerRecord[]>(path.join(DATA_ROOT, previousSeason, "historical-players.json"));
  const byId = new Map(previousPlayers.map((player) => [player.historicalPlayerId, player]));
  const result = new Map<number, number>();
  for (const anchor of anchors) {
    const previous = byId.get(anchor.sourceHistoricalPlayerId);
    const teamId = previous?.teamName ? teamByName.get(normalizedName(previous.teamName)) : undefined;
    if (teamId !== undefined) result.set(anchor.historicalPlayerId, teamId);
  }
  return result;
}

function buildSeasonContext(
  seasonName: string,
  history: ReturnType<typeof readClubEloHistoryCache>,
): SeasonContext {
  const targetDir = path.join(DATA_ROOT, seasonName);
  const season = loadSeason(targetDir);
  if (!season.hasPreparedPriors) throw new Error(`${seasonName}: prepared previous-season priors are required.`);
  const rawRows = [...season.rowsByPlayer.values()].flat().length;
  const duplicateRowsRemoved = rebuildDeduplicatedSeason(season);
  const teamInfo = readTeamIdentities(targetDir);
  const teamById = new Map(teamInfo.map((team) => [team.teamId, team]));
  if (teamById.size !== teamInfo.length) throw new Error(`${seasonName}: repeated team ids in preseason strengths.`);
  const teamByName = new Map<string, number>();
  teamInfo.forEach((team) => {
    teamByName.set(normalizedName(team.name), team.teamId);
    teamByName.set(normalizedName(team.shortName), team.teamId);
  });
  const fixturesCsv = readFixtureCsv(seasonName);
  const { bundle: historical, historicalTeamStrengths } = loadHistoricalForSeason(seasonName);
  const fixtureByIdSeason = new Map(season.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const fixtureById = new Map<number, FixtureContext>();
  const fixturesByGameweek = new Map<number, FixtureContext[]>();
  const eloAsOfByGameweek: SeasonContext["eloAsOfByGameweek"] = {};
  const observations: TeamObservation[] = [];
  const rawRatingStaleCounts: number[] = [];
  const fixtureDateById = new Map<number, string>();
  for (const fixture of season.fixtures) {
    const csv = fixturesCsv.get(fixture.fixtureId);
    if (!csv) throw new Error(`${seasonName} fixture ${fixture.fixtureId}: no local fixture CSV row.`);
    if (csv.teamHome !== fixture.homeTeamId || csv.teamAway !== fixture.awayTeamId) {
      throw new Error(`${seasonName} fixture ${fixture.fixtureId}: fixture CSV team ids disagree with player rows.`);
    }
    if (!Number.isFinite(csv.homeScore) || !Number.isFinite(csv.awayScore) || csv.homeScore < 0 || csv.awayScore < 0) {
      throw new Error(`${seasonName} fixture ${fixture.fixtureId}: final score is missing from local CSV.`);
    }
    fixtureDateById.set(fixture.fixtureId, dateInLondon(csv.kickoff));
  }
  const strengthsByGameweek = new Map<number, Record<number, TeamStrength>>();
  const cleanSheetsByGameweek = new Map<number, ReturnType<typeof deriveCleanSheetStrengths>>();
  const ratingsByGameweek = new Map<number, Map<number, EloAsOf>>();
  const firstKickoffByGameweek = new Map<number, string>();
  for (const [gameweek, fixtures] of [...season.fixturesByGameweek.entries()].sort(([a], [b]) => a - b)) {
    const targetFixtures = fixtures.map((fixture) => {
      const csv = fixturesCsv.get(fixture.fixtureId)!;
      return { fixture, csv, date: fixtureDateById.get(fixture.fixtureId)! };
    });
    const cutoffDate = targetFixtures.map((item) => item.date).sort()[0];
    firstKickoffByGameweek.set(gameweek, cutoffDate);
    const rated = clubEloRatingsBeforeDate(history, teamInfo, cutoffDate);
    if (rated.ratings.size !== teamInfo.length || rated.asOf.length !== teamInfo.length) {
      throw new Error(`${seasonName} GW${gameweek}: strict-prior ClubElo coverage is incomplete.`);
    }
    for (const item of rated.asOf) {
      const teamHistory = history.teams[item.slug];
      const exactPrior = teamHistory && latestStrictlyPriorElo(teamHistory.points, cutoffDate);
      assert.ok(exactPrior, `${seasonName} GW${gameweek} ${item.shortName}: no rating strictly before ${cutoffDate}.`);
      assert.equal(exactPrior.date, item.ratingDate, `${seasonName} GW${gameweek}: ClubElo adapter did not use strict-prior rating.`);
      assert.equal(exactPrior.elo, item.elo);
      rawRatingStaleCounts.push(item.lagDays);
    }
    eloAsOfByGameweek[String(gameweek)] = { cutoffDate, teams: rated.asOf };
    const strengths = strengthsBefore(season, gameweek);
    const ratedStrengths = deriveCleanSheetStrengths(strengths, rated.ratings, countMatchesBefore(season, gameweek));
    assert.equal(Object.keys(ratedStrengths).length, teamInfo.length,
      `${seasonName} GW${gameweek}: rated clean-sheet strengths do not cover every club.`);
    const asOfMap = new Map(rated.asOf.map((row) => [row.teamId, row]));
    const gameweekRatings = new Map<number, EloAsOf>();
    asOfMap.forEach((value, key) => gameweekRatings.set(key, value));
    strengthsByGameweek.set(gameweek, strengths);
    cleanSheetsByGameweek.set(gameweek, ratedStrengths);
    ratingsByGameweek.set(gameweek, gameweekRatings);
    for (const { fixture, csv, date } of targetFixtures) {
      const panel = clubEloFixture(history, seasonName, fixture.fixtureId);
      if (panel.date !== date) {
        throw new Error(`${seasonName} fixture ${fixture.fixtureId}: archive kickoff date ${panel.date} differs from local London date ${date}.`);
      }
      const homeElo = gameweekRatings.get(fixture.homeTeamId);
      const awayElo = gameweekRatings.get(fixture.awayTeamId);
      if (!homeElo || !awayElo) throw new Error(`${seasonName} fixture ${fixture.fixtureId}: missing strict-prior Elo side.`);
      const context: FixtureContext = {
        fixture,
        kickoffDate: date,
        cutoffDate,
        homeScore: csv.homeScore,
        awayScore: csv.awayScore,
        homeElo,
        awayElo,
        strengths,
        cleanSheetStrengths: ratedStrengths,
      };
      fixtureById.set(fixture.fixtureId, context);
      (fixturesByGameweek.get(gameweek) ?? fixturesByGameweek.set(gameweek, []).get(gameweek)!).push(context);
    }
  }
  const fixtureObservationRows = new Map<number, Fixture>();
  for (const fixture of season.fixtures) fixtureObservationRows.set(fixture.fixtureId, fixture);
  for (const [gameweek, targetFixtures] of fixturesByGameweek) {
    for (const context of targetFixtures) {
      const fixture = context.fixture;
      const homeTeam = context.strengths[fixture.homeTeamId];
      const awayTeam = context.strengths[fixture.awayTeamId];
      const homeCleanSheet = context.cleanSheetStrengths[fixture.homeTeamId];
      const awayCleanSheet = context.cleanSheetStrengths[fixture.awayTeamId];
      if (!homeTeam || !awayTeam || !homeCleanSheet || !awayCleanSheet) {
        throw new Error(`${seasonName} fixture ${fixture.fixtureId}: pre-GW team or clean-sheet strength is missing.`);
      }
      const homeInfo = teamById.get(fixture.homeTeamId)!;
      const awayInfo = teamById.get(fixture.awayTeamId)!;
      const shared = {
        season: seasonName,
        gameweek,
        fixtureId: fixture.fixtureId,
        cutoffDate: context.cutoffDate,
        kickoffDate: context.kickoffDate,
      };
      const homeDifficulty = calculateContinuousClubEloFdr(context.homeElo.elo, context.awayElo.elo, true);
      const awayDifficulty = calculateContinuousClubEloFdr(context.awayElo.elo, context.homeElo.elo, false);
      const homeRatio = productionAttackRatio(homeTeam, awayTeam, true);
      const awayRatio = productionAttackRatio(awayTeam, homeTeam, false);
      const homeConcedingRatio = awayCleanSheet.attack / homeCleanSheet.defence;
      const awayConcedingRatio = homeCleanSheet.attack / awayCleanSheet.defence;
      observations.push({
        ...shared,
        teamId: fixture.homeTeamId,
        opponentTeamId: fixture.awayTeamId,
        teamShortName: homeInfo.shortName,
        opponentShortName: awayInfo.shortName,
        isHome: true,
        ownElo: context.homeElo.elo,
        opponentElo: context.awayElo.elo,
        ownRatingDate: context.homeElo.ratingDate,
        opponentRatingDate: context.awayElo.ratingDate,
        ownRatingLagDays: context.homeElo.lagDays,
        opponentRatingLagDays: context.awayElo.lagDays,
        difficulty: homeDifficulty,
        ownTeam: homeTeam,
        opponentTeam: awayTeam,
        ownCleanSheet: homeCleanSheet,
        opponentCleanSheet: awayCleanSheet,
        attackRatio: homeRatio,
        ratedConcedingRatio: homeConcedingRatio,
        observedTeamXg: fixture.homeXg,
        observedOpponentXg: fixture.awayXg,
        observedGoals: context.homeScore,
        observedGoalsAgainst: context.awayScore,
        observedCleanSheet: context.awayScore === 0 ? 1 : 0,
        staleRating: context.homeElo.lagDays > STALE_RATING_DAYS || context.awayElo.lagDays > STALE_RATING_DAYS,
      });
      observations.push({
        ...shared,
        teamId: fixture.awayTeamId,
        opponentTeamId: fixture.homeTeamId,
        teamShortName: awayInfo.shortName,
        opponentShortName: homeInfo.shortName,
        isHome: false,
        ownElo: context.awayElo.elo,
        opponentElo: context.homeElo.elo,
        ownRatingDate: context.awayElo.ratingDate,
        opponentRatingDate: context.homeElo.ratingDate,
        ownRatingLagDays: context.awayElo.lagDays,
        opponentRatingLagDays: context.homeElo.lagDays,
        difficulty: awayDifficulty,
        ownTeam: awayTeam,
        opponentTeam: homeTeam,
        ownCleanSheet: awayCleanSheet,
        opponentCleanSheet: homeCleanSheet,
        attackRatio: awayRatio,
        ratedConcedingRatio: awayConcedingRatio,
        observedTeamXg: fixture.awayXg,
        observedOpponentXg: fixture.homeXg,
        observedGoals: context.awayScore,
        observedGoalsAgainst: context.homeScore,
        observedCleanSheet: context.homeScore === 0 ? 1 : 0,
        staleRating: context.awayElo.lagDays > STALE_RATING_DAYS || context.homeElo.lagDays > STALE_RATING_DAYS,
      });
    }
  }
  const teamFixtureCounts = new Map<number, Map<number, number>>();
  for (const fixture of season.fixtures) {
    for (const teamId of [fixture.homeTeamId, fixture.awayTeamId]) {
      const weeks = teamFixtureCounts.get(teamId) ?? teamFixtureCounts.set(teamId, new Map()).get(teamId)!;
      weeks.set(fixture.gameweek, (weeks.get(fixture.gameweek) ?? 0) + 1);
    }
  }
  const scheduledDoubleTeamGameweeks = [...teamFixtureCounts.values()].reduce(
    (sum, weeks) => sum + [...weeks.values()].filter((count) => count > 1).length, 0,
  );
  const sourcePlayerGameweeks = [...season.rowsByGameweek.values()].reduce((sum, rows) => {
    return sum + new Set(rows.map((row) => `${row.historicalPlayerId}:${row.gameweek}`)).size;
  }, 0);
  const coverage = {
    rawPlayerFixtureRows: rawRows,
    duplicatesRemoved: duplicateRowsRemoved,
    deduplicatedPlayerFixtureRows: rawRows - duplicateRowsRemoved,
    sourcePlayerGameweeks,
    scheduledFixtures: season.fixtures.length,
    scheduledGameweeks: fixturesByGameweek.size,
    scheduledDoubleTeamGameweeks,
    strictPriorClubRatings: Object.values(eloAsOfByGameweek).reduce((sum, row) => sum + row.teams.length, 0),
    missingClubRatings: 0,
    staleClubGameweekRatings: rawRatingStaleCounts.filter((lag) => lag > STALE_RATING_DAYS).length,
    maxRatingLagDays: Math.max(...rawRatingStaleCounts),
    p95RatingLagDays: quantile(rawRatingStaleCounts, 0.95),
  };
  void strengthsByGameweek;
  void cleanSheetsByGameweek;
  void ratingsByGameweek;
  void firstKickoffByGameweek;
  void fixtureObservationRows;
  return {
    seasonName,
    season,
    teamInfo,
    teamById,
    fixtureById,
    fixturesByGameweek,
    eloAsOfByGameweek,
    duplicateRowsRemoved,
    rawRows,
    coverage,
    observations,
    historical,
    historicalTeamStrengths,
  };
}

function productionAttackRatio(own: TeamStrength, opponent: TeamStrength, isHome: boolean): number {
  const ownAttack = isHome ? own.attackHome : own.attackAway;
  const opponentDefence = isHome ? opponent.defenceAway : opponent.defenceHome;
  if (!(ownAttack > 0) || !(opponentDefence > 0)) return 1;
  return Math.min(ATTACK_RATIO_BOUNDS[1], Math.max(ATTACK_RATIO_BOUNDS[0], ownAttack / opponentDefence));
}

function quantile(values: readonly number[], probability: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * (index - lower);
}

function inputFiles(): string[] {
  const files: string[] = [ELO_HISTORY_FILE, path.join(REPO, "data/generated/club-elo.json")];
  for (const seasonName of SEASONS) {
    const target = path.join(DATA_ROOT, seasonName);
    const previous = `${Number(seasonName.slice(0, 4)) - 1}-${seasonName.slice(2, 4)}`;
    files.push(
      path.join(DATA_ROOT, `fixtures-${seasonName}.csv`),
      ...["historical-match-stats.json", "historical-players.json", "previous-player-anchors.json", "preseason-team-strength.json", "fixture-difficulty.json"]
        .map((name) => path.join(target, name)),
      ...["historical-match-stats.json", "historical-players.json", "team-strength.json"]
        .map((name) => path.join(DATA_ROOT, previous, name)),
    );
  }
  return [...new Set(files)];
}

function sourceFiles(): string[] {
  return [
    "attackdefensemult_testing.md",
    "calculations.md",
    "scripts/backtest/attackdefensemult-testing.ts",
    "scripts/backtest/attackdefensemult-model.ts",
    "scripts/backtest/attackdefensemult-adjustment.ts",
    "scripts/backtest/season.ts",
    "scripts/backtest/historicalBacktest.ts",
    "scripts/backtest/multiSeasonData.ts",
    "scripts/backtest/clubelo-history.ts",
    "scripts/backtest/vaastavFixtures.ts",
    "scripts/backtest/tier-c-combined.ts",
    "lib/clubElo.ts",
    "lib/availability/selection.ts",
    "lib/availability/startRate.ts",
    "lib/historical/enrichPlayers.ts",
    "lib/historical/inSeasonForm.ts",
    "lib/projections/projectPlayer.ts",
    "lib/projections/fixtureAdjustment.ts",
    "lib/projections/cleanSheetStrength.ts",
    "lib/projections/expectedMinutes.ts",
    "lib/projections/playerForm.ts",
    "lib/projections/distributions.ts",
    "lib/projections/regression.ts",
    "lib/projections/metrics.ts",
    "data/generated/club-elo.json",
  ];
}

function assertClose(actual: number, expected: number, message: string, tolerance = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: got ${actual}, expected ${expected}.`);
}

function verifyProductionFormulas(): Record<string, unknown> {
  const anchors = [1.14, 1.07, 1, 0.92, 0.84];
  assert.deepEqual([1, 2, 3, 4, 5].map(continuousDifficultyMultiplier), anchors);
  assert.equal(calculateContinuousClubEloFdr(1500, 1800, true), 4);
  assert.equal(calculateContinuousClubEloFdr(1500, 1800, false), 4);
  assert.equal(calculateClubEloFdr(1500, 1800, true), 4);
  assert.equal(calculateClubEloFdr(1500, 1800, false), 4);
  assert.equal(CLEAN_SHEET_DISPERSION, 12);
  assert.equal(ELO_LEVEL_SLOPE, 0.0034);
  assert.equal(CLEAN_SHEET_SKEW_WEIGHT, 0.6);
  assert.equal(CLEAN_SHEET_LEVEL_PRIOR_MATCHES, 12);

  const ownTeam: TeamStrength = {
    teamId: 1, overall: 1.1,
    attackHome: 1.12, attackAway: 0.96, defenceHome: 1.03, defenceAway: 0.91,
  };
  const opponentTeam: TeamStrength = {
    teamId: 2, overall: 0.9,
    attackHome: 0.88, attackAway: 1.04, defenceHome: 0.94, defenceAway: 1.16,
  };
  const ownCleanSheet = { attack: 0.93, defence: 1.18 };
  const opponentCleanSheet = { attack: 1.12, defence: 0.91 };
  const fixture: PlayerFixture = {
    fixtureId: 1001, gameweek: 10, opponentTeamId: 2, opponentShortName: "OPP",
    isHome: true, difficulty: 4, exactDifficulty: 4.2,
  };
  const ratio = Math.min(ATTACK_RATIO_BOUNDS[1], Math.max(ATTACK_RATIO_BOUNDS[0], ownTeam.attackHome / opponentTeam.defenceAway));
  const expectedAttack = Math.min(ATTACK_MULTIPLIER_BOUNDS[1], Math.max(
    ATTACK_MULTIPLIER_BOUNDS[0], continuousDifficultyMultiplier(4.2) * HOME_ATTACK_MULTIPLIER * ratio,
  ));
  const expectedGoalsAgainst = LEAGUE_MEAN_XG * opponentCleanSheet.attack / ownCleanSheet.defence * AWAY_ATTACK_MULTIPLIER;
  const expectedCs = Math.min(0.9, Math.max(0.02, (CLEAN_SHEET_DISPERSION / (CLEAN_SHEET_DISPERSION + expectedGoalsAgainst)) ** CLEAN_SHEET_DISPERSION));
  const production = calculateFixtureAdjustment(fixture, { ownTeam, opponentTeam, ownCleanSheet, opponentCleanSheet });
  assertClose(production.attackMultiplier, expectedAttack, "Production attack path includes difficulty, venue and clamped attack ratio");
  assertClose(production.expectedGoalsAgainst, expectedGoalsAgainst, "Rated defence uses the rated ratio and venue, with no additional difficulty factor");
  assertClose(production.cleanSheetProbability, expectedCs, "Rated clean sheet uses the production negative-binomial mean");
  return {
    continuousDifficulty: "clamp(3 + (opponentElo - ownElo) / 300, 1, 5)",
    attackDifficultyAnchors: anchors,
    attackRatioClamp: ATTACK_RATIO_BOUNDS,
    finalAttackClamp: ATTACK_MULTIPLIER_BOUNDS,
    homeAwayAttackFactors: [HOME_ATTACK_MULTIPLIER, AWAY_ATTACK_MULTIPLIER],
    cleanSheetDispersion: CLEAN_SHEET_DISPERSION,
    eloLevelSlope: ELO_LEVEL_SLOPE,
    skewRetention: CLEAN_SHEET_SKEW_WEIGHT,
    levelPriorMatches: CLEAN_SHEET_LEVEL_PRIOR_MATCHES,
    ratedDefenseAdditionalDifficultyMultiplier: 1,
    verifiedFixture: production,
  };
}

function generateProjectPlayerVariant(): { sha256: string; patch: string[] } {
  const originalFile = path.join(REPO, "lib/projections/projectPlayer.ts");
  const original = readFileSync(originalFile, "utf8");
  let generated = original.replace(/from ["']\.\/([^"']+)["']/g, (_match, relative: string) => `from "@/lib/projections/${relative}"`);
  if (generated === original) throw new Error("projectPlayer source had no relative projection imports to isolate.");
  const fixtureImport = 'import { calculateFixtureAdjustment, LEAGUE_AVERAGE_GOALS_AGAINST } from "@/lib/projections/fixtureAdjustment";';
  if (!generated.includes(fixtureImport)) throw new Error("projectPlayer fixture import no longer matches the isolated variant patch.");
  generated = generated.replace(fixtureImport, `${fixtureImport}\nimport { attackdefensemultFixtureAdjustment } from "@/scripts/backtest/attackdefensemult-adjustment";\nimport type { AttackDefenseModel } from "@/scripts/backtest/attackdefensemult-model";`);
  const optionsMarker = "  leagueSavePercentage?: number;\n};";
  if (generated.split(optionsMarker).length !== 2) throw new Error("projectPlayer options marker changed; refusing an imprecise patch.");
  generated = generated.replace(optionsMarker, "  leagueSavePercentage?: number;\n  /** Experiment-only per-fixture multiplier model and frozen ratings. */\n  attackDefenseModel?: AttackDefenseModel;\n  attackDefenseEloByTeam?: ReadonlyMap<number, number>;\n};");
  const fixtureStart = generated.indexOf("function fixtureFor(");
  const nextFunction = generated.indexOf("\nfunction zeroComponents()", fixtureStart);
  if (fixtureStart < 0 || nextFunction < 0) throw new Error("projectPlayer fixtureFor block changed; refusing an imprecise patch.");
  const oldFixtureFor = generated.slice(fixtureStart, nextFunction);
  if (!oldFixtureFor.includes("return calculateFixtureAdjustment(fixture, {")) {
    throw new Error("projectPlayer fixtureFor expression changed; refusing an imprecise patch.");
  }
  const variantFixtureFor = `function fixtureFor(\n  player: Player,\n  fixture: PlayerFixture,\n  options: ProjectPlayerOptions,\n): ReturnType<typeof calculateFixtureAdjustment> {\n  if (options.attackDefenseModel) {\n    return attackdefensemultFixtureAdjustment(fixture, {\n      model: options.attackDefenseModel,\n      ownTeam: teamFor(player, options),\n      opponentTeam: options.teamStrengths?.[fixture.opponentTeamId],\n      ownCleanSheet: options.cleanSheetStrengths?.[player.teamId],\n      opponentCleanSheet: options.cleanSheetStrengths?.[fixture.opponentTeamId],\n      ownElo: options.attackDefenseEloByTeam?.get(player.teamId),\n      opponentElo: options.attackDefenseEloByTeam?.get(fixture.opponentTeamId),\n    });\n  }\n  return calculateFixtureAdjustment(fixture, {\n    ownTeam: teamFor(player, options),\n    opponentTeam: options.teamStrengths?.[fixture.opponentTeamId],\n    ownCleanSheet: options.cleanSheetStrengths?.[player.teamId],\n    opponentCleanSheet: options.cleanSheetStrengths?.[fixture.opponentTeamId],\n  });\n}`;
  generated = `${generated.slice(0, fixtureStart)}${variantFixtureFor}${generated.slice(nextFunction)}`;
  const scheduleStart = generated.indexOf("function pastFixtureMultiplier(");
  const scheduleEnd = generated.indexOf("\n}\n", scheduleStart);
  if (scheduleStart < 0 || scheduleEnd < 0 || !generated.slice(scheduleStart, scheduleEnd).includes("return calculateFixtureAdjustment(")) {
    throw new Error("Generated player variant changed schedule-adjusted historical form.");
  }
  mkdirSync(path.dirname(VARIANT_FILE), { recursive: true });
  writeFileSync(VARIANT_FILE, generated, "utf8");
  return {
    sha256: sha256(VARIANT_FILE),
    patch: [
      "Copied the exact current lib/projections/projectPlayer.ts source into output/attackdefensemult-testing/variants/projectPlayer.ts.",
      "Rewrote only the copied source's relative lib/projections imports to @/lib/projections aliases so the isolated file resolves from output/.",
      "Added optional experiment-only attackDefenseModel and attackDefenseEloByTeam fields to the copied ProjectPlayerOptions type.",
      "Replaced only copied fixtureFor's direct calculateFixtureAdjustment call with attackdefensemultFixtureAdjustment when an experiment model is supplied; the absent-model path remains direct production code.",
      "Verified the copied pastFixtureMultiplier still calls unchanged production calculateFixtureAdjustment, preserving schedule-adjusted player form.",
      `Original production projectPlayer sha256=${sha256(originalFile)}; generated variant sha256=${sha256(VARIANT_FILE)}.`,
    ],
  };
}

function makeFitRows(context: SeasonContext): AttackDefenseFitRow[] {
  return context.observations.map((row) => ({
    season: row.season,
    gameweek: row.gameweek,
    fixtureId: row.fixtureId,
    difficulty: row.difficulty,
    ownElo: row.ownElo,
    opponentElo: row.opponentElo,
    attackRatio: row.attackRatio,
    ratedConcedingRatio: row.ratedConcedingRatio,
    isHome: row.isHome,
    leagueMeanXg: LEAGUE_MEAN_XG,
    observedAttackXg: row.observedTeamXg,
    observedConcededXg: row.observedOpponentXg,
  }));
}

function createFrozenProtocol(): FrozenProtocol {
  for (const file of inputFiles()) assertFile(file);
  const productionConstants = verifyProductionFormulas();
  const variant = generateProjectPlayerVariant();
  const history = readClubEloHistoryCache(ELO_HISTORY_FILE);
  const fitContext = buildSeasonContext("2023-24", history);
  const fitReferenceElo = clubEloReferenceFromFitRows(makeFitRows(fitContext.observations.length
    ? fitContext
    : (() => { throw new Error("2023/24 has no strict-prior team observations."); })()));
  const dirtyTreePorcelain = git(["status", "--porcelain=v1", "-uall"]);
  const sourceHashes = Object.fromEntries(sourceFiles().map((file) => [file, sha256(path.join(REPO, file))]));
  sourceHashes["output/attackdefensemult-testing/variants/projectPlayer.ts"] = variant.sha256;
  const inputHashes = Object.fromEntries(inputFiles().map((file) => [path.relative(REPO, file).startsWith("../") ? file : path.relative(REPO, file), sha256(file)]));
  const protocol: Record<string, unknown> = {
    productionConstants,
    ratings: {
      source: "dated ClubElo event histories in scripts/backtest/results/clubelo-history.json",
      policy: "For each target GW, use each club's latest event rating strictly earlier than the Europe/London local date of that GW's earliest kickoff; all clubs share that cutoff.",
      noProxyFallback: true,
      staleSensitivityDays: STALE_RATING_DAYS,
    },
    outcomes: {
      teamXg: "Sum expectedGoals by team-fixture only after exact player-fixture deduplication; reject conflicting duplicates and missing xG.",
      goals: "Final team_h_score/team_a_score from the local prepared fixtures-<season>.csv files.",
      cleanSheet: "Indicator that the final opponent score is zero.",
      playerPoints: "Sum totalPoints over all explicit player-fixture rows in the target GW; absent rows are unknown and excluded, while explicit 0-minute rows remain DNPs.",
    },
    modelFamilies: {
      baseline: "Unchanged production calculateFixtureAdjustment with rated clean-sheet path.",
      curve: "Anchored piecewise-linear attack and conceded curves at difficulty 1..5, monotone decreasing/increasing, separate nonnegative strength-ratio exponents; divisor 300 fixed.",
      rawElo: "Separate own/opponent raw-Elo log-linear attack and conceding equations with the existing Elo-levelled clean-sheet strengths held fixed; no additional gap feature.",
      diagnostics: ["rawElo gap-only tied coefficients", "rawElo elo-only with ratio exponents fixed at zero"],
    },
    parameterBounds: {
      regularizationGrid: REGULARIZATION_GRID,
      curveKnots: { attackAtDifficulty3: 1, concededAtDifficulty3: 1, multiplierBounds: CURVE_MULTIPLIER_BOUNDS, attackMonotone: "decreasing", concededMonotone: "increasing" },
      strengthRatioExponents: RATIO_EXPONENT_BOUNDS,
      rawEloCoefficients: RAW_ELO_COEFFICIENT_BOUNDS,
      eloScale: 100,
      fitReferenceElo,
      productionAttackRatioClamp: ATTACK_RATIO_BOUNDS,
      productionFinalAttackClamp: ATTACK_MULTIPLIER_BOUNDS,
      cleanSheetDispersion: CLEAN_SHEET_DISPERSION,
      cleanSheetProbabilityBounds: [0.02, 0.9],
    },
    fitting: {
      season: "2023-24",
      objective: "Mean Poisson quasi-deviance on nonnegative fractional team xG: 2*(mu-y+y*log(y/mu)), using the exact y=0 limit 2*mu; separate attacking and conceded fits. This is not an integer likelihood.",
      rowWeighting: "One row per team-perspective fixture; both fixture sides are retained and are dependent within a fixture/gameweek cluster.",
      curveRegularizationTargets: { attack: BASELINE_ATTACK_CURVE, conceded: [1, 1, 1, 1, 1], ratioExponents: [1, 1] },
      rawEloRegularizationTargets: { eloCoefficients: 0, ratioExponents: "unpenalized; bounded [0,2]" },
      optimizer: { algorithm: "deterministic projected gradient descent with Armijo backtracking", maxIterations: 2000, gradientTolerance: 1e-7 },
    },
    selection: {
      season: "2024-25",
      eligibleCandidates: "All fitted curve arms and full rawElo arms; gap-only and elo-only models are diagnostics and cannot be selected.",
      order: [
        "Compute pooled equal-weight team-xG RMSE = sqrt((mean attack-xG squared error + mean conceded-xG squared error)/2). Retain modified candidates within +0.005 xG of the best modified candidate.",
        "Reject candidates with attack or conceded team-xG RMSE more than +0.005 above production, player-GW total-xP RMSE more than +0.01 above production, clean-sheet Brier more than +0.002 above production, or goals-conceded RMSE more than +0.02 above production.",
        "Among remaining candidates choose lowest integrated player-GW xP RMSE, then lowest clean-sheet Brier, then lower pooled team-xG RMSE, then curve before rawElo, then lower regularization.",
        "If no modified candidate survives, select production baseline.",
      ],
    },
    finalEvaluation: {
      season: "2025-26",
      onePrimaryCandidateFrozenBeforeScoring: true,
      secondaryArms: "All fitted curve and rawElo full/gap-only/elo-only arms are scored as prespecified secondary comparisons; no final re-selection.",
      metrics: ["attack-xG RMSE", "conceded-xG RMSE", "goals-conceded RMSE", "clean-sheet Brier", "integrated player-GW total-xP RMSE/MAE/bias", "goal/assist/clean-sheet component RMSE", "xP components and minutes shifts"],
      slices: { exAnteStarter: `selection.startProbability >= ${STARTER_PROBABILITY_THRESHOLD}`, earlyGameweeks: "GW1-5", laterGameweeks: "GW6 onward", staleSensitivity: `Exclude a fixture if either team's pre-GW rating lag exceeds ${STALE_RATING_DAYS} days; for xP exclude a player-GW if any of that player's target team fixtures is stale.` },
      implementationAcceptance: {
        requireResolvedTeamXgImprovement: true,
        changedTeamXgDimensionNonInferiorityUpperBound: 0.005,
        playerXpRmseDifferenceUpperBound: 0.01,
        cleanSheetBrierDifferenceUpperBound: 0.002,
        goalsConcededRmseDifferenceUpperBound: 0.02,
        requireResolvedPlayerXpRmseImprovementForImplement: true,
        interpretation: "An interval crossing zero is inconclusive; a team-xG win without resolved player-xP improvement is not an implementation win.",
      },
    },
    uncertainty: {
      method: "Paired percentile bootstrap resampling complete season-GW clusters; both fixture sides and linked player rows stay in their cluster.",
      draws: BOOTSTRAP_DRAWS,
      seedHex: `0x${BOOTSTRAP_SEED.toString(16)}`,
      seed: BOOTSTRAP_SEED,
      pooledSecondaryStratifiedBySeason: true,
      parameterEstimationUncertaintyIncluded: false,
      refittingOrReselectionInsideBootstrap: false,
    },
    reconstruction: {
      commonPriceTenths: PRICE_PRIOR_TENTHS,
      status: "a",
      chanceOfPlaying: "not archived; undefined for all players",
      lineup: "RotoWire is not archived for these historical deadlines; buildPlayerSelections uses prior-season evidence and strictly prior explicit match observations.",
      doubles: "All scheduled target fixtures are projected and summed; prior double-gameweek player-form rows are retained fixture by fixture.",
      priorTeamAtGameweek1: "Use previous-season team only when an adjacent-season anchor maps it to a target-season team; otherwise cold-start and exclude rather than infer DNP.",
      schedule: "Historical final fixtures are used; the archived deadline fixture schedule is unavailable.",
      position: "Position is season-level historical data because no per-deadline position archive is prepared.",
    },
    reuseWarning: "These seasons informed earlier model development; this is reused historical validation, not a pristine holdout. Confirm prospectively on a later season.",
  };
  const frozen: FrozenProtocol = {
    experiment: "ClubElo attack and defence multipliers",
    createdAt: new Date().toISOString(),
    gitHead: git(["rev-parse", "HEAD"]),
    dirtyTreePorcelain,
    dirtyTreeSha256: sha256Text(dirtyTreePorcelain),
    dataRoot: DATA_ROOT,
    outputRoot: OUTPUT,
    clubEloHistoryPath: ELO_HISTORY_FILE,
    clubEloHistorySha256: sha256(ELO_HISTORY_FILE),
    sourceHashes,
    inputHashes,
    generatedVariantPath: path.relative(REPO, VARIANT_FILE),
    generatedVariantSha256: variant.sha256,
    generatedVariantPatch: variant.patch,
    fitReferenceElo,
    protocol,
  };
  writeJson(PROTOCOL_FILE, frozen);
  writeJson(path.join(OUTPUT, "baseline-formula-check.json"), productionConstants);
  writeJson(path.join(OUTPUT, "rating-coverage-fit-season.json"), {
    season: fitContext.seasonName,
    coverage: fitContext.coverage,
    strictPriorRatingsAsOfByGameweek: fitContext.eloAsOfByGameweek,
    inputHash: sha256(ELO_HISTORY_FILE),
  });
  console.log(`Protocol frozen before candidate scoring: ${PROTOCOL_FILE}`);
  console.log(`Fit-only raw-Elo reference: ${fitReferenceElo.toFixed(6)}; source/input hashes recorded.`);
  console.log(`No candidate fitting or scoring was run by freeze.`);
  return frozen;
}

function verifyFrozenProtocol(): FrozenProtocol {
  assertFile(PROTOCOL_FILE);
  const frozen = readJson<FrozenProtocol>(PROTOCOL_FILE);
  if (frozen.gitHead !== git(["rev-parse", "HEAD"])) throw new Error("Repository HEAD changed after protocol freeze; refreeze before scoring.");
  for (const [file, hash] of Object.entries(frozen.sourceHashes)) {
    if (sha256(path.resolve(REPO, file)) !== hash) throw new Error(`Source changed after protocol freeze: ${file}; refreeze before scoring.`);
  }
  for (const [file, hash] of Object.entries(frozen.inputHashes)) {
    const absolute = path.isAbsolute(file) ? file : path.resolve(REPO, file);
    if (sha256(absolute) !== hash) throw new Error(`Input changed after protocol freeze: ${file}; refreeze before scoring.`);
  }
  if (sha256(VARIANT_FILE) !== frozen.generatedVariantSha256) throw new Error("Generated player pipeline variant changed after freeze.");
  if (sha256(ELO_HISTORY_FILE) !== frozen.clubEloHistorySha256) throw new Error("ClubElo archive changed after protocol freeze.");
  return frozen;
}

function modelId(model: AttackDefenseModel): string {
  if (model.family === "baseline") return "baseline";
  if (model.family === "curve") return `curve-${model.regularizationId.replace(/[^a-zA-Z0-9.=+-]/g, "-")}`;
  return `rawElo-${model.parameters.restriction}-${model.regularizationId.replace(/[^a-zA-Z0-9.=+-]/g, "-")}`;
}

function fitModels(context: SeasonContext): { arms: ModelArm[]; fitArtifact: Record<string, unknown> } {
  const rows = makeFitRows(context);
  if (rows.length < 500) throw new Error(`2023/24 fit has only ${rows.length} team-fixture rows.`);
  const fitReference = clubEloReferenceFromFitRows(rows);
  const protocolReference = readJson<FrozenProtocol>(PROTOCOL_FILE).fitReferenceElo;
  assertClose(fitReference, protocolReference, "Fit-only raw-Elo reference differs from frozen protocol");
  const curveFits = fitDifficultyCurveGrid(rows, { regularizationGrid: REGULARIZATION_GRID });
  const eloFits = fitRawEloModelGrid(rows, fitReference, {
    regularizationGrid: REGULARIZATION_GRID,
    restrictions: ["full", "gap-only", "elo-only"],
  });
  const arms: ModelArm[] = [{
    id: "baseline",
    label: "Current production rated path",
    model: BASELINE_ATTACK_DEFENSE_MODEL,
    role: "baseline",
  }];
  for (const fit of curveFits) {
    if (!fit.attack.converged || !fit.conceded.converged) {
      throw new Error(`${fit.model.regularizationId}: curve fit failed to converge; no scoring was performed.`);
    }
    arms.push({
      id: modelId(fit.model), label: `Fitted difficulty curves (${fit.model.regularizationId})`,
      model: fit.model, role: "primary-candidate", fit: { attack: fit.attack, conceded: fit.conceded },
    });
  }
  for (const fit of eloFits) {
    if (!fit.attack.converged || !fit.conceded.converged) {
      throw new Error(`${fit.model.regularizationId}: raw-Elo fit failed to converge; no scoring was performed.`);
    }
    arms.push({
      id: modelId(fit.model),
      label: `Raw ClubElo (${fit.model.parameters.restriction}, ${fit.model.regularizationId})`,
      model: fit.model,
      role: fit.model.parameters.restriction === "full" ? "primary-candidate" : "diagnostic",
      fit: { attack: fit.attack, conceded: fit.conceded },
    });
  }
  const fitArtifact = {
    season: context.seasonName,
    fitRows: rows.length,
    fitReferenceElo: fitReference,
    fittingRowsSha256: sha256Text(JSON.stringify(rows)),
    regularizationGrid: REGULARIZATION_GRID,
    models: arms.filter((arm) => arm.model.family !== "baseline").map((arm) => ({
      id: arm.id,
      role: arm.role,
      model: arm.model,
      fit: arm.fit,
    })),
  };
  return { arms, fitArtifact };
}

function makeTeamPredictionRow(
  row: TeamObservation,
  model: AttackDefenseModel,
): TeamArmPrediction {
  const fixture: PlayerFixture = {
    fixtureId: row.fixtureId,
    gameweek: row.gameweek,
    opponentTeamId: row.opponentTeamId,
    opponentShortName: row.opponentShortName,
    isHome: row.isHome,
    difficulty: calculateClubEloFdr(row.ownElo, row.opponentElo, row.isHome),
    exactDifficulty: row.difficulty,
  };
  let attackMultiplier: number;
  let attackMultiplierRaw: number;
  let expectedGoalsAgainst: number;
  let cleanSheetProbability: number;
  if (model.family === "baseline") {
    const result: FixtureAdjustmentResult = calculateFixtureAdjustment(fixture, {
      ownTeam: row.ownTeam,
      opponentTeam: row.opponentTeam,
      ownCleanSheet: row.ownCleanSheet,
      opponentCleanSheet: row.opponentCleanSheet,
    });
    attackMultiplier = result.attackMultiplier;
    attackMultiplierRaw = continuousDifficultyMultiplier(row.difficulty)
      * (row.isHome ? HOME_ATTACK_MULTIPLIER : AWAY_ATTACK_MULTIPLIER) * row.attackRatio;
    expectedGoalsAgainst = result.expectedGoalsAgainst;
    cleanSheetProbability = result.cleanSheetProbability;
  } else {
    const result = evaluateAttackDefenseModel(model, {
      difficulty: row.difficulty,
      ownElo: row.ownElo,
      opponentElo: row.opponentElo,
      attackRatio: row.attackRatio,
      ratedConcedingRatio: row.ratedConcedingRatio,
      isHome: row.isHome,
      leagueMeanXg: LEAGUE_MEAN_XG,
    }, CLEAN_SHEET_DISPERSION);
    attackMultiplier = result.attackMultiplier;
    attackMultiplierRaw = result.attackMultiplierRaw;
    expectedGoalsAgainst = result.expectedGoalsAgainst;
    cleanSheetProbability = result.cleanSheetProbability;
  }
  return {
    attackMultiplier,
    attackMultiplierRaw,
    predictedAttackXg: LEAGUE_MEAN_XG * attackMultiplier,
    expectedGoalsAgainst,
    cleanSheetProbability,
    attackClampBound: attackMultiplierRaw < ATTACK_MULTIPLIER_BOUNDS[0]
      ? "low"
      : attackMultiplierRaw > ATTACK_MULTIPLIER_BOUNDS[1] ? "high" : null,
  };
}

function scoreTeamObservations(context: SeasonContext, arms: readonly ModelArm[]): TeamObservation[] {
  for (const row of context.observations) {
    row.predictions = {};
    const production = makeTeamPredictionRow(row, BASELINE_ATTACK_DEFENSE_MODEL);
    const direct = calculateFixtureAdjustment({
      fixtureId: row.fixtureId,
      gameweek: row.gameweek,
      opponentTeamId: row.opponentTeamId,
      opponentShortName: row.opponentShortName,
      isHome: row.isHome,
      difficulty: calculateClubEloFdr(row.ownElo, row.opponentElo, row.isHome),
      exactDifficulty: row.difficulty,
    }, {
      ownTeam: row.ownTeam,
      opponentTeam: row.opponentTeam,
      ownCleanSheet: row.ownCleanSheet,
      opponentCleanSheet: row.opponentCleanSheet,
    });
    assertClose(production.attackMultiplier, direct.attackMultiplier, `${context.seasonName} fixture ${row.fixtureId}: baseline attack parity`);
    assertClose(production.expectedGoalsAgainst, direct.expectedGoalsAgainst, `${context.seasonName} fixture ${row.fixtureId}: baseline conceded-mean parity`);
    assertClose(production.cleanSheetProbability, direct.cleanSheetProbability, `${context.seasonName} fixture ${row.fixtureId}: baseline clean-sheet parity`);
    for (const arm of arms) row.predictions[arm.id] = makeTeamPredictionRow(row, arm.model);
  }
  return context.observations;
}

function playerHistoryBefore(
  context: SeasonContext,
  playerId: number,
  teamId: number,
  targetGameweek: number,
  fixtureById: ReadonlyMap<number, Fixture>,
): { form: PlayerMatchRate[]; starts: StartObservation[] } {
  const rowsByWeek = new Map<number, MatchRow[]>();
  for (const row of rowsBeforeGameweek(context.season.rowsByPlayer.get(playerId) ?? [], targetGameweek)) {
    if (teamForRow(row, fixtureById) !== teamId) continue;
    (rowsByWeek.get(row.gameweek) ?? rowsByWeek.set(row.gameweek, []).get(row.gameweek)!).push(row);
  }
  const form: PlayerMatchRate[] = [];
  const starts: StartObservation[] = [];
  for (const [week, weekFixtures] of [...context.season.fixturesByGameweek].sort(([a], [b]) => a - b)) {
    if (week >= targetGameweek) continue;
    const teamFixtures = weekFixtures.filter((fixture) => fixture.homeTeamId === teamId || fixture.awayTeamId === teamId);
    if (!teamFixtures.length) continue;
    const rows = rowsByWeek.get(week) ?? [];
    const rowFixtureIds = [...new Set(rows.map((row) => row.fixtureId))].sort((a, b) => a - b);
    const fixtureIds = teamFixtures.map((fixture) => fixture.fixtureId).sort((a, b) => a - b);
    if (rowFixtureIds.length !== fixtureIds.length || rowFixtureIds.some((id, index) => id !== fixtureIds[index])) {
      continue; // An absent archive row is unknown; it cannot become a historical DNP.
    }
    for (const row of rows.sort((left, right) => left.fixtureId - right.fixtureId)) {
      const fixture = teamFixtures.find((item) => item.fixtureId === row.fixtureId)!;
      const wasHome = fixture.homeTeamId === teamId;
      starts.push({ started: row.minutes >= 60, appeared: row.minutes > 0, minutes: row.minutes });
      if (row.minutes <= 0) continue;
      form.push({
        xg: row.expectedGoals,
        xa: row.expectedAssists ?? 0,
        minutes: row.minutes,
        opponentTeamId: wasHome ? fixture.awayTeamId : fixture.homeTeamId,
        wasHome,
      });
    }
  }
  return { form, starts };
}

function makePlayerFixture(
  context: FixtureContext,
  teamId: number,
  teamById: ReadonlyMap<number, TeamIdentity>,
): PlayerFixture {
  const fixture = context.fixture;
  const isHome = fixture.homeTeamId === teamId;
  const opponentTeamId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
  const ownElo = isHome ? context.homeElo.elo : context.awayElo.elo;
  const opponentElo = isHome ? context.awayElo.elo : context.homeElo.elo;
  const opponent = teamById.get(opponentTeamId);
  if (!opponent) throw new Error(`${context.fixture.fixtureId}: missing opponent identity ${opponentTeamId}.`);
  return {
    fixtureId: fixture.fixtureId,
    gameweek: fixture.gameweek,
    opponentTeamId,
    opponentShortName: opponent.shortName,
    isHome,
    difficulty: calculateClubEloFdr(ownElo, opponentElo, isHome),
    exactDifficulty: calculateContinuousClubEloFdr(ownElo, opponentElo, isHome),
  };
}

function componentRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") throw new Error("projectPlayer did not return component breakdowns.");
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, Number(entry)]));
}

function projectSeason(
  context: SeasonContext,
  arms: readonly ModelArm[],
  variantProjectPlayer: (player: Player, options: Parameters<typeof projectPlayer>[1] & {
    attackDefenseModel?: AttackDefenseModel;
    attackDefenseEloByTeam?: ReadonlyMap<number, number>;
  }) => ReturnType<typeof projectPlayer>,
): { rows: PlayerForecastRow[]; coverage: Record<string, number | Record<string, number>> } {
  const fixtureById = new Map(context.season.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const teamByName = new Map<string, number>();
  context.teamInfo.forEach((team) => {
    teamByName.set(normalizedName(team.name), team.teamId);
    teamByName.set(normalizedName(team.shortName), team.teamId);
  });
  const openingTeamByPlayer = priorSeasonTeamByPlayer(context.seasonName, path.join(DATA_ROOT, context.seasonName), teamByName);
  let coldStarts = 0;
  let unsupportedPositions = 0;
  let priorTeamMismatches = 0;
  let incompleteTargetRows = 0;
  let scoredZeroMinute = 0;
  let scoredStarts = 0;
  let scoredShortAppearances = 0;
  let parityRows = 0;
  let scheduledDoubles = 0;
  const scoredRows: PlayerForecastRow[] = [];
  const scoredByWeek: Record<string, number> = {};
  for (const [gameweek, weekFixtures] of [...context.fixturesByGameweek.entries()].sort(([a], [b]) => a - b)) {
    const targetRows = context.season.rowsByGameweek.get(gameweek) ?? [];
    const groups = new Map<number, MatchRow[]>();
    for (const row of targetRows) {
      (groups.get(row.historicalPlayerId) ?? groups.set(row.historicalPlayerId, []).get(row.historicalPlayerId)!).push(row);
    }
    const teamFixtureCounts = new Map<number, number>();
    for (const contextFixture of weekFixtures) {
      teamFixtureCounts.set(contextFixture.fixture.homeTeamId, (teamFixtureCounts.get(contextFixture.fixture.homeTeamId) ?? 0) + 1);
      teamFixtureCounts.set(contextFixture.fixture.awayTeamId, (teamFixtureCounts.get(contextFixture.fixture.awayTeamId) ?? 0) + 1);
    }
    scheduledDoubles += [...teamFixtureCounts.values()].filter((count) => count > 1).length;
    const startsByPlayer: Record<number, StartObservation[]> = {};
    const formsByPlayer: Record<number, PlayerMatchRate[]> = {};
    const candidates: Array<{ player: Player; rows: MatchRow[]; teamId: number; teamFixtures: FixtureContext[] }> = [];
    for (const [playerId, rows] of groups) {
      const source = context.season.players.get(playerId);
      if (!source || (source.position !== "GK" && source.position !== "DEF" && source.position !== "MID" && source.position !== "FWD")) {
        unsupportedPositions += 1;
        continue;
      }
      const forecastTeam = exactPriorTeam(context.season, playerId, gameweek, fixtureById)
        ?? openingTeamByPlayer.get(playerId);
      if (forecastTeam === undefined) {
        coldStarts += 1;
        continue;
      }
      const rowTeams = new Set(rows.map((row) => teamForRow(row, fixtureById)).filter((team): team is number => team !== undefined));
      if (rowTeams.size !== 1 || !rowTeams.has(forecastTeam)) {
        priorTeamMismatches += 1;
        continue;
      }
      const teamFixtures = weekFixtures.filter((item) => item.fixture.homeTeamId === forecastTeam || item.fixture.awayTeamId === forecastTeam);
      const fixtureIds = teamFixtures.map((item) => item.fixture.fixtureId).sort((a, b) => a - b);
      const rowFixtureIds = [...new Set(rows.map((row) => row.fixtureId))].sort((a, b) => a - b);
      if (!teamFixtures.length || rowFixtureIds.length !== fixtureIds.length
        || rowFixtureIds.some((id, index) => id !== fixtureIds[index]) || rows.length !== teamFixtures.length) {
        incompleteTargetRows += 1;
        continue;
      }
      const firstFixture = teamFixtures[0];
      const firstWasHome = firstFixture.fixture.homeTeamId === forecastTeam;
      const player = playerAt(context.season, playerId, gameweek, firstFixture.fixture, firstWasHome);
      if (!player) {
        coldStarts += 1;
        continue;
      }
      const identity = context.teamById.get(forecastTeam);
      if (!identity) throw new Error(`${context.seasonName} GW${gameweek}: no club identity for team ${forecastTeam}.`);
      player.teamId = forecastTeam;
      player.teamName = identity.name;
      player.teamShortName = identity.shortName;
      player.priceTenths = PRICE_PRIOR_TENTHS;
      player.status = "a";
      player.chanceOfPlaying = undefined;
      player.fixtures = teamFixtures.map((item) => makePlayerFixture(item, forecastTeam, context.teamById));
      const history = playerHistoryBefore(context, playerId, forecastTeam, gameweek, fixtureById);
      startsByPlayer[playerId] = history.starts;
      formsByPlayer[playerId] = history.form;
      candidates.push({ player, rows, teamId: forecastTeam, teamFixtures });
    }
    const selection = buildPlayerSelections(candidates.map((entry) => entry.player), {
      historical: context.historical,
      historicalStats: context.season.previousStatsByPlayerId,
      startHistory: startsByPlayer,
      targetGameweek: gameweek,
    });
    const byWeekElo = context.eloAsOfByGameweek[String(gameweek)];
    const eloByTeam = new Map(byWeekElo.teams.map((item) => [item.teamId, item.elo]));
    const strengths = strengthsBefore(context.season, gameweek);
    const cleanSheets = deriveCleanSheetStrengths(strengths, eloByTeam, countMatchesBefore(context.season, gameweek));
    const playerForm: Record<number, PlayerMatchRate[]> = {};
    for (const entry of candidates) {
      entry.player.selection = selection.get(entry.player.id);
      playerForm[entry.player.id] = formsByPlayer[entry.player.id] ?? [];
    }
    for (const entry of candidates) {
      const { player, rows, teamFixtures } = entry;
      const options = {
        currentGameweek: gameweek,
        horizon: 1 as const,
        fixtureHorizon: 1,
        teamStrengths: strengths,
        cleanSheetStrengths: cleanSheets,
        historicalTeamStrengths: context.historicalTeamStrengths,
        playerForm,
      };
      const productionBaseline = projectPlayer(player, options);
      const generatedBaseline = variantProjectPlayer(player, {
        ...options,
        attackDefenseModel: BASELINE_ATTACK_DEFENSE_MODEL,
        attackDefenseEloByTeam: eloByTeam,
      });
      assert.ok(isDeepStrictEqual(productionBaseline, generatedBaseline),
        `${context.seasonName} GW${gameweek} player ${player.id}: no-op generated pipeline differs from production.`);
      parityRows += 1;
      const actualMinutes = rows.reduce((sum, row) => sum + row.minutes, 0);
      const outcome = recordedFixtureOutcome(actualMinutes);
      assert.notEqual(outcome, "NOT_RECORDED", `${context.seasonName} GW${gameweek} player ${player.id}: absent rows cannot be scored as DNP.`);
      const expectedFixtureIds = teamFixtures.map((item) => item.fixture.fixtureId).sort((a, b) => a - b);
      const projectedIds = productionBaseline.fixtures.map((item) => item.fixture.fixtureId!).sort((a, b) => a - b);
      assert.deepEqual(projectedIds, expectedFixtureIds,
        `${context.seasonName} GW${gameweek} player ${player.id}: double-GW fixtures were not all projected.`);
      const aggregated = aggregateFixturePointsByGameweek(productionBaseline.fixtures);
      assert.equal(round(aggregated.get(gameweek) ?? 0, 3), productionBaseline.nextGW,
        `${context.seasonName} GW${gameweek} player ${player.id}: fixture xP does not aggregate to nextGW.`);
      const position = player.position;
      const goalPoints: Record<Position, number> = { GK: 10, DEF: 6, MID: 5, FWD: 4 };
      const cleanSheetPoints: Record<Position, number> = { GK: 4, DEF: 4, MID: 1, FWD: 0 };
      let actualGoalPoints = 0;
      let actualAssistPoints = 0;
      let actualCleanSheetPoints = 0;
      for (const row of rows) {
        const fx = context.fixtureById.get(row.fixtureId);
        if (!fx) throw new Error(`${context.seasonName} fixture ${row.fixtureId}: no full fixture context.`);
        const goalsAgainst = row.wasHome ? fx.awayScore : fx.homeScore;
        actualGoalPoints += row.goals * goalPoints[position];
        actualAssistPoints += row.assists * 3;
        if (row.minutes >= 60 && goalsAgainst === 0) actualCleanSheetPoints += cleanSheetPoints[position];
      }
      const armsResult: Record<string, PlayerArmPrediction> = {};
      for (const arm of arms) {
        const projected = arm.id === "baseline"
          ? productionBaseline
          : variantProjectPlayer(player, {
            ...options,
            attackDefenseModel: arm.model,
            attackDefenseEloByTeam: eloByTeam,
          });
        assert.equal(projected.expectedMinutes, productionBaseline.expectedMinutes,
          `${context.seasonName} GW${gameweek} player ${player.id}: model arm changed expected minutes.`);
        assert.equal(projected.fixtures.length, teamFixtures.length,
          `${context.seasonName} GW${gameweek} player ${player.id}: model arm lost a fixture.`);
        armsResult[arm.id] = {
          prediction: projected.nextGW,
          expectedMinutes: projected.expectedMinutes,
          components: componentRecord(projected.components),
          fixtureComponents: projected.fixtures.map((fixture) => ({
            fixtureId: fixture.fixture.fixtureId!,
            components: componentRecord(fixture.components),
          })),
        };
      }
      const row: PlayerForecastRow = {
        season: context.seasonName,
        gameweek,
        playerId: player.id,
        position,
        forecastStarter: (player.selection?.startProbability ?? 0) >= STARTER_PROBABILITY_THRESHOLD,
        actual: rows.reduce((sum, match) => sum + match.totalPoints, 0),
        actualMinutes,
        fixtureCount: rows.length,
        actualGoalPoints,
        actualAssistPoints,
        actualCleanSheetPoints,
        allFixtureRatingsFresh: teamFixtures.every((item) => item.homeElo.lagDays <= STALE_RATING_DAYS && item.awayElo.lagDays <= STALE_RATING_DAYS),
        arms: armsResult,
      };
      scoredRows.push(row);
      scoredByWeek[String(gameweek)] = (scoredByWeek[String(gameweek)] ?? 0) + 1;
      if (outcome === "DNP") scoredZeroMinute += 1;
      else if (actualMinutes >= 60) scoredStarts += 1;
      else scoredShortAppearances += 1;
    }
    console.log(`${context.seasonName} GW${gameweek}: source=${groups.size} eligible=${candidates.length} scored=${candidates.length}`);
  }
  assert.ok(scoredRows.length > 0, `${context.seasonName}: no player-GW rows were scored.`);
  assert.equal(scoredRows.length, new Set(scoredRows.map((row) => `${row.playerId}:${row.gameweek}`)).size,
    `${context.seasonName}: a player-GW was scored more than once.`);
  return {
    rows: scoredRows.sort((left, right) => left.gameweek - right.gameweek || left.playerId - right.playerId),
    coverage: {
      scoredPlayerGameweeks: scoredRows.length,
      scoredZeroMinutePlayerGameweeks: scoredZeroMinute,
      scoredStarts,
      scoredShortAppearances,
      excludedColdStartPlayerGameweeks: coldStarts,
      excludedUnsupportedPositionPlayerGameweeks: unsupportedPositions,
      excludedPriorTeamMismatchPlayerGameweeks: priorTeamMismatches,
      excludedIncompleteFixturePlayerGameweeks: incompleteTargetRows,
      scheduledDoubleTeamGameweeks: scheduledDoubles,
      baselinePipelineParityRows: parityRows,
      scoredPlayerCount: new Set(scoredRows.map((row) => row.playerId)).size,
      scoredByGameweek: scoredByWeek,
    },
  };
}

function metricValue(actual: readonly number[], prediction: readonly number[], metric: PairedMetricKind): number {
  if (!actual.length || actual.length !== prediction.length) throw new Error("Metric arrays must be nonempty and paired.");
  const differences = actual.map((value, index) => prediction[index] - value);
  if (metric === "mae") return differences.reduce((sum, value) => sum + Math.abs(value), 0) / differences.length;
  if (metric === "bias") return differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const mse = differences.reduce((sum, value) => sum + value * value, 0) / differences.length;
  return metric === "rmse" ? Math.sqrt(mse) : mse;
}

function pairedMetric<T extends { season: string; gameweek: number }>(
  rows: readonly T[],
  actual: (row: T) => number,
  baseline: (row: T) => number,
  candidate: (row: T) => number,
  metric: PairedMetricKind,
): ReturnType<typeof pairedGameweekClusterBootstrap> {
  const paired: PairedMetricRow[] = rows.map((row) => ({
    season: row.season,
    gameweek: row.gameweek,
    actual: actual(row),
    baseline: baseline(row),
    candidate: candidate(row),
  }));
  return pairedGameweekClusterBootstrap(paired, metric, { draws: BOOTSTRAP_DRAWS, seed: BOOTSTRAP_SEED });
}

function teamComparison(rows: readonly TeamObservation[], armId: string, bootstrap = false): Record<string, unknown> {
  if (!rows.length) return { n: 0, unavailable: "empty predeclared slice" };
  const baselinePrediction = (row: TeamObservation) => row.predictions!.baseline;
  const candidatePrediction = (row: TeamObservation) => row.predictions![armId];
  const metrics: Record<string, unknown> = {};
  const define = (
    key: string,
    actual: (row: TeamObservation) => number,
    field: keyof TeamArmPrediction,
    kind: PairedMetricKind,
  ) => {
    const base = rows.map((row) => baselinePrediction(row)[field] as number);
    const next = rows.map((row) => candidatePrediction(row)[field] as number);
    const actuals = rows.map(actual);
    const baseValue = metricValue(actuals, base, kind);
    const nextValue = metricValue(actuals, next, kind);
    const summary: Record<string, unknown> = {
      n: rows.length,
      baseline: baseValue,
      candidate: nextValue,
      difference: nextValue - baseValue,
      relativeDifference: baseValue === 0 ? null : (nextValue - baseValue) / baseValue,
    };
    if (bootstrap) {
      const estimate = pairedMetric(rows, actual, (row) => baselinePrediction(row)[field] as number,
        (row) => candidatePrediction(row)[field] as number, kind);
      summary.bootstrap95 = estimate.interval95;
      summary.bootstrap = estimate;
    }
    metrics[key] = summary;
  };
  define("attackXgRmse", (row) => row.observedTeamXg, "predictedAttackXg", "rmse");
  define("concededXgRmse", (row) => row.observedOpponentXg, "expectedGoalsAgainst", "rmse");
  define("goalsConcededRmse", (row) => row.observedGoalsAgainst, "expectedGoalsAgainst", "rmse");
  define("cleanSheetBrier", (row) => row.observedCleanSheet, "cleanSheetProbability", "brier");
  const baselineClamp = rows.filter((row) => baselinePrediction(row).attackClampBound !== null).length;
  const candidateClamp = rows.filter((row) => candidatePrediction(row).attackClampBound !== null).length;
  return {
    n: rows.length,
    fixtures: new Set(rows.map((row) => `${row.season}|${row.fixtureId}`)).size,
    metrics,
    attackMultiplier: {
      baselineMean: rows.reduce((sum, row) => sum + baselinePrediction(row).attackMultiplier, 0) / rows.length,
      candidateMean: rows.reduce((sum, row) => sum + candidatePrediction(row).attackMultiplier, 0) / rows.length,
      baselineRawClampCount: baselineClamp,
      baselineRawClampRate: baselineClamp / rows.length,
      candidateRawClampCount: candidateClamp,
      candidateRawClampRate: candidateClamp / rows.length,
    },
  };
}

function meanOf(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

function playerComparison(rows: readonly PlayerForecastRow[], armId: string, bootstrap = false): Record<string, unknown> {
  if (!rows.length) return { n: 0, unavailable: "empty predeclared slice" };
  const baseline = (row: PlayerForecastRow) => row.arms.baseline;
  const candidate = (row: PlayerForecastRow) => row.arms[armId];
  const metrics: Record<string, unknown> = {};
  const define = (
    key: string,
    actual: (row: PlayerForecastRow) => number,
    predicted: (prediction: PlayerArmPrediction) => number,
    kind: PairedMetricKind,
  ) => {
    const actuals = rows.map(actual);
    const baseValues = rows.map((row) => predicted(baseline(row)));
    const candidateValues = rows.map((row) => predicted(candidate(row)));
    const baseValue = metricValue(actuals, baseValues, kind);
    const candidateValue = metricValue(actuals, candidateValues, kind);
    const summary: Record<string, unknown> = {
      n: rows.length,
      baseline: baseValue,
      candidate: candidateValue,
      difference: candidateValue - baseValue,
      relativeDifference: baseValue === 0 ? null : (candidateValue - baseValue) / baseValue,
    };
    if (bootstrap) {
      const estimate = pairedMetric(rows, actual, (row) => predicted(baseline(row)), (row) => predicted(candidate(row)), kind);
      summary.bootstrap95 = estimate.interval95;
      summary.bootstrap = estimate;
    }
    metrics[key] = summary;
  };
  define("totalXpRmse", (row) => row.actual, (value) => value.prediction, "rmse");
  define("totalXpMae", (row) => row.actual, (value) => value.prediction, "mae");
  define("totalXpBias", (row) => row.actual, (value) => value.prediction, "bias");
  define("goalComponentRmse", (row) => row.actualGoalPoints, (value) => value.components.goals, "rmse");
  define("assistComponentRmse", (row) => row.actualAssistPoints, (value) => value.components.assists, "rmse");
  define("cleanSheetComponentRmse", (row) => row.actualCleanSheetPoints, (value) => value.components.cleanSheets, "rmse");
  const componentKeys = ["appearance", "goals", "assists", "cleanSheets", "goalsConceded", "saves", "defensiveContribution", "bonus", "cards", "penalties"];
  const componentShift = Object.fromEntries(componentKeys.map((key) => [
    key,
    meanOf(rows.map((row) => candidate(row).components[key] - baseline(row).components[key])),
  ]));
  return {
    n: rows.length,
    metrics,
    meanExpectedMinutes: {
      baseline: meanOf(rows.map((row) => baseline(row).expectedMinutes)),
      candidate: meanOf(rows.map((row) => candidate(row).expectedMinutes)),
      difference: meanOf(rows.map((row) => candidate(row).expectedMinutes - baseline(row).expectedMinutes)),
    },
    meanComponentShiftCandidateMinusBaseline: componentShift,
  };
}

function pooledTeamXgRmse(rows: readonly TeamObservation[], armId: string): number {
  const attackError = meanOf(rows.map((row) => (row.predictions![armId].predictedAttackXg - row.observedTeamXg) ** 2));
  const concededError = meanOf(rows.map((row) => (row.predictions![armId].expectedGoalsAgainst - row.observedOpponentXg) ** 2));
  return Math.sqrt((attackError + concededError) / 2);
}

function selectPrimaryCandidate(
  arms: readonly ModelArm[],
  teamRows: readonly TeamObservation[],
  playerRows: readonly PlayerForecastRow[],
): Record<string, unknown> & { selectedArmId: string } {
  const baselineTeam = teamComparison(teamRows, "baseline") as {
    metrics: Record<string, { candidate: number }>;
  };
  const baselinePlayer = playerComparison(playerRows, "baseline") as { metrics: Record<string, { candidate: number }> };
  const baselineMetrics = {
    attackXgRmse: baselineTeam.metrics.attackXgRmse.candidate,
    concededXgRmse: baselineTeam.metrics.concededXgRmse.candidate,
    goalsConcededRmse: baselineTeam.metrics.goalsConcededRmse.candidate,
    cleanSheetBrier: baselineTeam.metrics.cleanSheetBrier.candidate,
    totalXpRmse: baselinePlayer.metrics.totalXpRmse.candidate,
  };
  const candidates = arms.filter((arm) => arm.role === "primary-candidate").map((arm) => {
    const team = teamComparison(teamRows, arm.id) as { metrics: Record<string, { candidate: number }> };
    const player = playerComparison(playerRows, arm.id) as { metrics: Record<string, { candidate: number }> };
    return {
      id: arm.id,
      label: arm.label,
      family: arm.model.family,
      regularization: arm.model.regularization,
      pooledTeamXgRmse: pooledTeamXgRmse(teamRows, arm.id),
      attackXgRmse: team.metrics.attackXgRmse.candidate,
      concededXgRmse: team.metrics.concededXgRmse.candidate,
      goalsConcededRmse: team.metrics.goalsConcededRmse.candidate,
      cleanSheetBrier: team.metrics.cleanSheetBrier.candidate,
      totalXpRmse: player.metrics.totalXpRmse.candidate,
    };
  });
  if (!candidates.length) throw new Error("No primary candidate arms were fitted.");
  const bestTeamXg = Math.min(...candidates.map((candidate) => candidate.pooledTeamXgRmse));
  const xgRetained = candidates.filter((candidate) => candidate.pooledTeamXgRmse <= bestTeamXg + 0.005);
  const passing = xgRetained.filter((candidate) =>
    candidate.attackXgRmse <= baselineMetrics.attackXgRmse + 0.005
    && candidate.concededXgRmse <= baselineMetrics.concededXgRmse + 0.005
    && candidate.totalXpRmse <= baselineMetrics.totalXpRmse + 0.01
    && candidate.cleanSheetBrier <= baselineMetrics.cleanSheetBrier + 0.002
    && candidate.goalsConcededRmse <= baselineMetrics.goalsConcededRmse + 0.02);
  const familyRank = (family: AttackDefenseModel["family"]) => family === "curve" ? 0 : family === "rawElo" ? 1 : 2;
  passing.sort((left, right) => left.totalXpRmse - right.totalXpRmse
    || left.cleanSheetBrier - right.cleanSheetBrier
    || left.pooledTeamXgRmse - right.pooledTeamXgRmse
    || familyRank(left.family) - familyRank(right.family)
    || left.regularization - right.regularization);
  const selectedArmId = passing[0]?.id ?? "baseline";
  return {
    season: "2024-25",
    selectedBeforeFinalScoring: true,
    selectedArmId,
    selectedModel: arms.find((arm) => arm.id === selectedArmId)?.model,
    baselineMetrics,
    bestModifiedPooledTeamXgRmse: bestTeamXg,
    xgRetentionMargin: 0.005,
    passingCandidates: passing.map((candidate) => candidate.id),
    allPrimaryCandidateMetrics: candidates,
    diagnosticArmsExcludedFromSelection: arms.filter((arm) => arm.role === "diagnostic").map((arm) => arm.id),
    rule: "Retain candidates within 0.005 pooled team-xG RMSE of the best; apply frozen xG/xP/Brier/goals-conceded non-inferiority gates; select lowest xP RMSE, then clean-sheet Brier, team-xG RMSE, curve simplicity, and regularization. If none pass, use production baseline.",
  };
}

function describeSeasonCoverage(context: SeasonContext, playerCoverage: Record<string, unknown>): Record<string, unknown> {
  return {
    ...context.coverage,
    scoredPlayerGameweeks: playerCoverage.scoredPlayerGameweeks,
    scoredZeroMinutePlayerGameweeks: playerCoverage.scoredZeroMinutePlayerGameweeks,
    scoredStarts: playerCoverage.scoredStarts,
    scoredShortAppearances: playerCoverage.scoredShortAppearances,
    excludedColdStartPlayerGameweeks: playerCoverage.excludedColdStartPlayerGameweeks,
    excludedUnsupportedPositionPlayerGameweeks: playerCoverage.excludedUnsupportedPositionPlayerGameweeks,
    excludedPriorTeamMismatchPlayerGameweeks: playerCoverage.excludedPriorTeamMismatchPlayerGameweeks,
    excludedIncompleteFixturePlayerGameweeks: playerCoverage.excludedIncompleteFixturePlayerGameweeks,
    baselinePipelineParityRows: playerCoverage.baselinePipelineParityRows,
    scoredPlayerCount: playerCoverage.scoredPlayerCount,
    scheduledDoubleTeamGameweeks: playerCoverage.scheduledDoubleTeamGameweeks,
  };
}

function playerForecastArtifact(context: SeasonContext, rows: readonly PlayerForecastRow[], coverage: unknown): void {
  const plainFile = path.join(OUTPUT, "predictions", `player-gameweeks-${context.seasonName}.json`);
  const compressedFile = `${plainFile}.gz`;
  rmSync(plainFile, { force: true });
  const value = {
    season: context.seasonName,
    coverage,
    rows,
  };
  mkdirSync(path.dirname(compressedFile), { recursive: true });
  writeFileSync(compressedFile, gzipSync(Buffer.from(`${JSON.stringify(value)}\n`)));
}

function teamObservationArtifact(context: SeasonContext): void {
  writeJson(path.join(OUTPUT, "data", `team-observations-${context.seasonName}.json`), {
    season: context.seasonName,
    coverage: context.coverage,
    strictPriorRatingsAsOfByGameweek: context.eloAsOfByGameweek,
    observations: context.observations,
  });
}

function componentByPosition(
  rows: readonly PlayerForecastRow[],
  armId: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const position of ["GK", "DEF", "MID", "FWD"] as const) {
    const group = rows.filter((row) => row.position === position);
    if (!group.length) continue;
    const candidate = group.map((row) => row.arms[armId].prediction);
    const baseline = group.map((row) => row.arms.baseline.prediction);
    const actual = group.map((row) => row.actual);
    result[position] = {
      n: group.length,
      baselineXpRmse: metricValue(actual, baseline, "rmse"),
      candidateXpRmse: metricValue(actual, candidate, "rmse"),
      difference: metricValue(actual, candidate, "rmse") - metricValue(actual, baseline, "rmse"),
      goalComponentRmse: metricValue(group.map((row) => row.actualGoalPoints), group.map((row) => row.arms[armId].components.goals), "rmse"),
      assistComponentRmse: metricValue(group.map((row) => row.actualAssistPoints), group.map((row) => row.arms[armId].components.assists), "rmse"),
      cleanSheetComponentRmse: metricValue(group.map((row) => row.actualCleanSheetPoints), group.map((row) => row.arms[armId].components.cleanSheets), "rmse"),
    };
  }
  return result;
}

function summarizeArm(
  context: SeasonContext,
  playerRows: readonly PlayerForecastRow[],
  armId: string,
): Record<string, unknown> {
  const earlyWeeks = playerRows.filter((row) => row.gameweek <= 5);
  const laterWeeks = playerRows.filter((row) => row.gameweek >= 6);
  const starters = playerRows.filter((row) => row.forecastStarter);
  const freshTeamRows = context.observations.filter((row) => !row.staleRating);
  const freshPlayerRows = playerRows.filter((row) => row.allFixtureRatingsFresh);
  return {
    season: context.seasonName,
    fullCoverage: {
      team: teamComparison(context.observations, armId, true),
      players: playerComparison(playerRows, armId, true),
      playerMetricsByPosition: componentByPosition(playerRows, armId),
    },
    exAnteForecastStarters: {
      definition: `pre-GW selection.startProbability >= ${STARTER_PROBABILITY_THRESHOLD}`,
      player: playerComparison(starters, armId, true),
    },
    earlyGameweeks1To5: {
      team: teamComparison(context.observations.filter((row) => row.gameweek <= 5), armId, true),
      players: playerComparison(earlyWeeks, armId, true),
    },
    laterGameweeks6Onward: {
      team: teamComparison(context.observations.filter((row) => row.gameweek >= 6), armId, true),
      players: playerComparison(laterWeeks, armId, true),
    },
    staleRatingSensitivity: {
      rule: `Exclude an observation/player-GW if either side of a relevant fixture uses a pre-GW rating older than ${STALE_RATING_DAYS} days; parameters are unchanged.`,
      team: teamComparison(freshTeamRows, armId, true),
      players: playerComparison(freshPlayerRows, armId, true),
    },
  };
}

function teamLevel(value: number, lowCut: number, highCut: number): "low" | "mid" | "high" {
  return value <= lowCut ? "low" : value <= highCut ? "mid" : "high";
}

function eloGapBand(gap: number): string {
  if (gap <= -300) return "<= -300";
  if (gap <= -150) return "(-300, -150]";
  if (gap <= -50) return "(-150, -50]";
  if (gap <= 50) return "(-50, 50]";
  if (gap <= 150) return "(50, 150]";
  if (gap <= 300) return "(150, 300]";
  return "> 300";
}

function calibrationArtifacts(
  context: SeasonContext,
  fitRows: readonly TeamObservation[],
  arms: readonly ModelArm[],
  referenceElo: number,
): Record<string, unknown> {
  const ownLow = quantile(fitRows.map((row) => row.ownElo), 1 / 3);
  const ownHigh = quantile(fitRows.map((row) => row.ownElo), 2 / 3);
  const opponentLow = quantile(fitRows.map((row) => row.opponentElo), 1 / 3);
  const opponentHigh = quantile(fitRows.map((row) => row.opponentElo), 2 / 3);
  const groupRows = new Map<string, TeamObservation[]>();
  const add = (key: string, row: TeamObservation) => {
    (groupRows.get(key) ?? groupRows.set(key, []).get(key)!).push(row);
  };
  for (const row of context.observations) {
    const ownLevel = teamLevel(row.ownElo, ownLow, ownHigh);
    const opponentLevel = teamLevel(row.opponentElo, opponentLow, opponentHigh);
    add(`eloGap:${eloGapBand(row.opponentElo - row.ownElo)}`, row);
    add(`venue:${row.isHome ? "home" : "away"}`, row);
    add(`ownEloLevel:${ownLevel}`, row);
    add(`opponentEloLevel:${opponentLevel}`, row);
    add(`ownOpponentEloLevel:${ownLevel}-${opponentLevel}`, row);
    if (ownLevel === "high" && opponentLevel === "high") add("matchup:strong-vs-strong", row);
    if (ownLevel === "low" && opponentLevel === "low") add("matchup:weak-vs-weak", row);
  }
  const groups = [...groupRows.entries()].map(([group, rows]) => ({
    group,
    arms: Object.fromEntries(arms.map((arm) => {
      const comparison = teamComparison(rows, arm.id) as Record<string, unknown>;
      return [arm.id, {
        n: rows.length,
        sparseWarning: rows.length < 30,
        fixtureCount: new Set(rows.map((row) => row.fixtureId)).size,
        observedAttackXgMean: meanOf(rows.map((row) => row.observedTeamXg)),
        predictedAttackXgMean: meanOf(rows.map((row) => row.predictions![arm.id].predictedAttackXg)),
        observedConcededXgMean: meanOf(rows.map((row) => row.observedOpponentXg)),
        predictedConcededXgMean: meanOf(rows.map((row) => row.predictions![arm.id].expectedGoalsAgainst)),
        actualGoalsAgainstMean: meanOf(rows.map((row) => row.observedGoalsAgainst)),
        predictedGoalsAgainstMean: meanOf(rows.map((row) => row.predictions![arm.id].expectedGoalsAgainst)),
        actualCleanSheetRate: meanOf(rows.map((row) => row.observedCleanSheet)),
        predictedCleanSheetRate: meanOf(rows.map((row) => row.predictions![arm.id].cleanSheetProbability)),
        attackMultiplierMean: meanOf(rows.map((row) => row.predictions![arm.id].attackMultiplier)),
        attackClampBindingCount: rows.filter((row) => row.predictions![arm.id].attackClampBound !== null).length,
        attackClampBindingRate: meanOf(rows.map((row) => row.predictions![arm.id].attackClampBound !== null ? 1 : 0)),
        pairedMetrics: comparison.metrics,
      }];
    })),
  }));
  const curves = arms.map((arm) => ({
    armId: arm.id,
    family: arm.model.family,
    points: [1, 2, 3, 4, 5].map((difficulty) => {
      const home = evaluateAttackDefenseModel(arm.model, {
        difficulty, ownElo: referenceElo, opponentElo: referenceElo,
        attackRatio: 1, ratedConcedingRatio: 1, isHome: true, leagueMeanXg: LEAGUE_MEAN_XG,
      }, CLEAN_SHEET_DISPERSION);
      const away = evaluateAttackDefenseModel(arm.model, {
        difficulty, ownElo: referenceElo, opponentElo: referenceElo,
        attackRatio: 1, ratedConcedingRatio: 1, isHome: false, leagueMeanXg: LEAGUE_MEAN_XG,
      }, CLEAN_SHEET_DISPERSION);
      return {
        difficulty,
        neutralMeanAttackMultiplier: (home.attackMultiplier + away.attackMultiplier) / 2,
        neutralMeanGoalsAgainst: (home.expectedGoalsAgainst + away.expectedGoalsAgainst) / 2,
        homeAttackMultiplier: home.attackMultiplier,
        awayAttackMultiplier: away.attackMultiplier,
      };
    }),
  }));
  return {
    season: context.seasonName,
    levelThresholdsFitOnly: { ownElo: [ownLow, ownHigh], opponentElo: [opponentLow, opponentHigh] },
    groups,
    multiplierCurvesAtNeutralStrengthRatios: curves,
    calibrationDefinition: "Each team-perspective fixture is a calibration row; the two sides of one fixture are dependent and all uncertainty clusters by season-GW.",
  };
}

function bootstrapSecondaryPooled(
  playerRows: readonly PlayerForecastRow[],
  teamRows: readonly TeamObservation[],
  armId: string,
): Record<string, unknown> {
  return {
    stratification: "The bootstrap helper samples gameweeks within each season, retaining both seasons as fixed strata.",
    player: playerComparison(playerRows, armId, true),
    team: teamComparison(teamRows, armId, true),
  };
}

function finalVerdict(
  selectedArmId: string,
  final: Record<string, unknown>,
): Record<string, unknown> {
  if (selectedArmId === "baseline") {
    return {
      recommendation: "do not implement",
      reason: "No modified candidate passed the frozen 2024/25 selection gates, so production remains the selected formula.",
    };
  }
  const full = final.fullCoverage as {
    team: { metrics: Record<string, { difference: number; bootstrap95: [number, number] }> };
    players: { metrics: Record<string, { difference: number; bootstrap95: [number, number] }> };
  };
  const attack = full.team.metrics.attackXgRmse;
  const concededXg = full.team.metrics.concededXgRmse;
  const goals = full.team.metrics.goalsConcededRmse;
  const cleanSheet = full.team.metrics.cleanSheetBrier;
  const playerXp = full.players.metrics.totalXpRmse;
  const teamAccuracyImproved = attack.bootstrap95[1] < 0 || concededXg.bootstrap95[1] < 0;
  const attackNonInferior = attack.bootstrap95[1] <= 0.005;
  const concededNonInferior = concededXg.bootstrap95[1] <= 0.005;
  const xpImproved = playerXp.bootstrap95[1] < 0;
  const cleanSheetNonInferior = cleanSheet.bootstrap95[1] <= 0.002;
  const goalsNonInferior = goals.bootstrap95[1] <= 0.02;
  const regression = attack.bootstrap95[0] > 0.005 || concededXg.bootstrap95[0] > 0.005
    || playerXp.bootstrap95[0] > 0.01 || cleanSheet.bootstrap95[0] > 0.002 || goals.bootstrap95[0] > 0.02;
  const recommendation = regression ? "do not implement"
    : teamAccuracyImproved && attackNonInferior && concededNonInferior && xpImproved && cleanSheetNonInferior && goalsNonInferior
      ? "implement"
      : "inconclusive";
  return {
    recommendation,
    reason: recommendation === "implement"
      ? "The selected model improves a relevant team-xG metric and total player-xP RMSE with paired intervals, while the changed team-xG, goals-conceded and clean-sheet metrics meet frozen non-inferiority limits."
      : recommendation === "do not implement"
        ? "The final paired intervals support deterioration beyond at least one frozen tolerance."
        : "The final intervals do not establish both a relevant team-xG and an integrated player-xP improvement while meeting all non-inferiority limits.",
    checks: {
      teamAccuracyImproved,
      attackXgNonInferior: attackNonInferior,
      concededXgNonInferior: concededNonInferior,
      playerXpImproved: xpImproved,
      cleanSheetNonInferior,
      goalsConcededNonInferior: goalsNonInferior,
      supportedRegression: regression,
    },
    margins: { teamXgRmse: 0.005, playerXpRmse: 0.01, cleanSheetBrier: 0.002, goalsConcededRmse: 0.02 },
  };
}

interface ReportMetric {
  n: number;
  baseline: number;
  candidate: number;
  difference: number;
  bootstrap95: [number, number];
}

interface ReportArm {
  fullCoverage: {
    team: { metrics: Record<string, ReportMetric> };
    players: {
      metrics: Record<string, ReportMetric>;
      meanComponentShiftCandidateMinusBaseline: Record<string, number>;
    };
  };
}

interface ReportSummary {
  selection: { selectedArmId: string };
  final: { byArm: Record<string, ReportArm> };
  verdict: { recommendation: string; reason: string };
  coverage: Record<string, Record<string, number>>;
  protocol: { gitHead: string; dirtyTreeSha256: string };
}

function conciseReport(summary: ReportSummary): string {
  const selectedId = summary.selection.selectedArmId as string;
  const selected = summary.final.byArm[selectedId] as ReportArm;
  const team = selected.fullCoverage.team.metrics;
  const player = selected.fullCoverage.players.metrics;
  const fmt = (metric: ReportMetric) => `${metric.baseline.toFixed(5)} → ${metric.candidate.toFixed(5)} (Δ ${metric.difference >= 0 ? "+" : ""}${metric.difference.toFixed(5)}, 95% [${metric.bootstrap95[0].toFixed(5)}, ${metric.bootstrap95[1].toFixed(5)}])`;
  const lines = [
    "# ClubElo attack and defence multiplier experiment",
    "",
    `Recommendation: **${summary.verdict.recommendation}** — ${summary.verdict.reason}`,
    "",
    `The 2024/25 protocol selected **${selectedId}** before 2025/26 final scoring. The final comparison uses ${player.totalXpRmse.n} matched player-GWs and ${team.attackXgRmse.n} team-perspective fixture rows; every paired interval uses ${BOOTSTRAP_DRAWS.toLocaleString()} season-GW cluster draws with seed 0x${BOOTSTRAP_SEED.toString(16)}.`,
    "",
    "## Selected model versus production on 2025/26",
    "",
    `- Attacking team xG RMSE: ${fmt(team.attackXgRmse)}.`,
    `- Conceded team xG RMSE: ${fmt(team.concededXgRmse)}.`,
    `- Goals-conceded RMSE: ${fmt(team.goalsConcededRmse)}.`,
    `- Clean-sheet Brier: ${fmt(team.cleanSheetBrier)}.`,
    `- Integrated player-GW xP RMSE: ${fmt(player.totalXpRmse)}.`,
    `- Integrated player-GW xP MAE: ${fmt(player.totalXpMae)}; signed bias: ${fmt(player.totalXpBias)}.`,
    `- Goal, assist, and clean-sheet component RMSE deltas: ${player.goalComponentRmse.difference.toFixed(5)}, ${player.assistComponentRmse.difference.toFixed(5)}, ${player.cleanSheetComponentRmse.difference.toFixed(5)} xP.`,
    `- Mean component shifts candidate minus production: ${JSON.stringify(selected.fullCoverage.players.meanComponentShiftCandidateMinusBaseline)}.`,
    "",
    "## Coverage and method limits",
    "",
    `Fit/selection/final seasons were 2023/24, 2024/25 and 2025/26. The selected-arm final coverage scored ${summary.coverage["2025-26"].scoredPlayerGameweeks} player-GWs, including ${summary.coverage["2025-26"].scoredZeroMinutePlayerGameweeks} explicit zero-minute DNPs and ${summary.coverage["2025-26"].scheduledDoubleTeamGameweeks} scheduled double-team-GWs; absent player rows were excluded as unknown.`,
    "",
    "Historical prices, FPL status/chance, archived lineups and forecast-time positions are unavailable in these prepared inputs. All arms therefore share a £5.0m prior, status `a`, no chance-of-playing factor, position from season-level history, and selection reconstructed from adjacent-season evidence plus strictly prior explicit match rows. Historical final schedules stand in for deadline schedules. The seasons were used in earlier model development, so this is reused historical validation, not a pristine holdout. Bootstrap intervals are conditional on fitted parameters and omit parameter-estimation uncertainty.",
    "",
    "The generated player pipeline was checked against production for every scored player-GW, with schedule-adjusted form, expected minutes, fixture components and double-GW aggregation unchanged. Production files were not modified.",
    "",
    "## Reproduction",
    "",
    "```sh",
    `BACKTEST_ATTACK_DEFENSE_DATA_DIR=${DATA_ROOT} node --import tsx scripts/backtest/attackdefensemult-testing.ts freeze`,
    `BACKTEST_ATTACK_DEFENSE_DATA_DIR=${DATA_ROOT} node --import tsx scripts/backtest/attackdefensemult-testing.ts run`,
    "npx vitest run tests/core/attackdefensemult-testing.test.ts",
    "```",
    "",
    `Detailed per-arm metrics, calibration tables, curves, hashes, fitted parameters and player predictions are in [attackdefensemult-testing.json](./attackdefensemult-testing.json) and output/attackdefensemult-testing/. Frozen Git revision: ${summary.protocol.gitHead}; frozen dirty-tree SHA-256: ${summary.protocol.dirtyTreeSha256}.`,
    "",
  ];
  return lines.join("\n");
}

async function runExperiment(): Promise<Record<string, unknown>> {
  const frozen = verifyFrozenProtocol();
  if (frozen.dataRoot !== DATA_ROOT || frozen.outputRoot !== OUTPUT) {
    throw new Error("The input or output directory differs from the frozen protocol.");
  }
  const variantModule = await import(pathToFileURL(VARIANT_FILE).href) as {
    projectPlayer: (player: Player, options: Parameters<typeof projectPlayer>[1] & {
      attackDefenseModel?: AttackDefenseModel;
      attackDefenseEloByTeam?: ReadonlyMap<number, number>;
    }) => ReturnType<typeof projectPlayer>;
  };
  const history = readClubEloHistoryCache(ELO_HISTORY_FILE);

  // Fit only on 2023/24, then evaluate/select on 2024/25. 2025/26 inputs are
  // intentionally not loaded until the selection artifact has been written.
  const fitContext = buildSeasonContext("2023-24", history);
  const { arms, fitArtifact } = fitModels(fitContext);
  writeJson(path.join(OUTPUT, "models/fits-2023-24.json"), fitArtifact);
  scoreTeamObservations(fitContext, arms);
  teamObservationArtifact(fitContext);
  writeJson(path.join(OUTPUT, "metrics/training-fit-2023-24.json"), Object.fromEntries(
    arms.map((arm) => [arm.id, teamComparison(fitContext.observations, arm.id)]),
  ));

  const selectionContext = buildSeasonContext("2024-25", history);
  scoreTeamObservations(selectionContext, arms);
  teamObservationArtifact(selectionContext);
  const selectionForecast = projectSeason(selectionContext, arms, variantModule.projectPlayer);
  playerForecastArtifact(selectionContext, selectionForecast.rows, selectionForecast.coverage);
  const selection = selectPrimaryCandidate(arms, selectionContext.observations, selectionForecast.rows);
  const allSelectionArmMetrics = Object.fromEntries(arms.map((arm) => [arm.id, {
    team: teamComparison(selectionContext.observations, arm.id),
    players: playerComparison(selectionForecast.rows, arm.id),
  }]));
  const selectionArtifact = {
    ...selection,
    coverage: describeSeasonCoverage(selectionContext, selectionForecast.coverage),
    allArmSelectionMetrics: allSelectionArmMetrics,
    selectedAt: new Date().toISOString(),
    frozenProtocolSha256: sha256(PROTOCOL_FILE),
    selectedModelParameters: arms.find((arm) => arm.id === selection.selectedArmId)?.model,
  };
  writeJson(path.join(OUTPUT, "selection.json"), selectionArtifact);
  console.log(`2024/25 selected ${selection.selectedArmId}; selection frozen to ${path.join(OUTPUT, "selection.json")}.`);

  // The final season is first loaded and scored only after the selection file
  // above exists, so no final outcomes can affect model choice.
  const finalContext = buildSeasonContext("2025-26", history);
  scoreTeamObservations(finalContext, arms);
  teamObservationArtifact(finalContext);
  const finalForecast = projectSeason(finalContext, arms, variantModule.projectPlayer);
  playerForecastArtifact(finalContext, finalForecast.rows, finalForecast.coverage);
  const finalByArm = Object.fromEntries(arms.map((arm) => [
    arm.id,
    summarizeArm(finalContext, finalForecast.rows, arm.id),
  ]));
  const finalCalibration = calibrationArtifacts(finalContext, fitContext.observations, arms, frozen.fitReferenceElo);
  writeJson(path.join(OUTPUT, "calibration/final-2025-26.json"), finalCalibration);

  const pooledTeamRows = [...selectionContext.observations, ...finalContext.observations];
  const pooledPlayerRows = [...selectionForecast.rows, ...finalForecast.rows];
  const pooledSecondary = bootstrapSecondaryPooled(pooledPlayerRows, pooledTeamRows, selection.selectedArmId);
  writeJson(path.join(OUTPUT, "metrics/pooled-2024-25-2025-26-secondary.json"), pooledSecondary);

  const selectedFinal = finalByArm[selection.selectedArmId] as Record<string, unknown>;
  const verdict = finalVerdict(selection.selectedArmId, selectedFinal);
  const coverage = {
    "2023-24": { ...fitContext.coverage, fitRows: makeFitRows(fitContext).length },
    "2024-25": describeSeasonCoverage(selectionContext, selectionForecast.coverage),
    "2025-26": describeSeasonCoverage(finalContext, finalForecast.coverage),
  };
  const summary: Record<string, unknown> = {
    experiment: "ClubElo attack and defence multipliers",
    generatedAt: new Date().toISOString(),
    protocol: {
      file: path.relative(REPO, PROTOCOL_FILE),
      sha256: sha256(PROTOCOL_FILE),
      gitHead: frozen.gitHead,
      dirtyTreeSha256: frozen.dirtyTreeSha256,
      dirtyTreePorcelain: frozen.dirtyTreePorcelain,
      sourceHashes: frozen.sourceHashes,
      inputHashes: frozen.inputHashes,
      clubEloHistorySha256: frozen.clubEloHistorySha256,
      fitReferenceElo: frozen.fitReferenceElo,
      frozenRules: frozen.protocol,
    },
    coverage,
    arms: arms.map((arm) => ({ id: arm.id, label: arm.label, role: arm.role, model: arm.model, fit: arm.fit })),
    fitting: fitArtifact,
    selection: selectionArtifact,
    final: {
      season: "2025-26",
      selectedArmId: selection.selectedArmId,
      byArm: finalByArm,
      calibrationArtifact: path.relative(REPO, path.join(OUTPUT, "calibration/final-2025-26.json")),
      pooled2024_25_2025_26Secondary: pooledSecondary,
    },
    verdict,
    limitations: [
      "All three seasons had informed earlier model development; the final season is reused historical validation rather than a pristine holdout.",
      "Historical deadline prices, FPL status/chance, RotoWire lineups, archived fixture schedules, and forecast-time positions are unavailable; all arms share the documented common reconstruction.",
      "ClubElo ratings are actual dated history and strictly prior to the first kickoff's UK local date, but final prepared fixture lists are used for each historical GW.",
      "Player-GW scoring requires complete explicit archive rows for every team fixture. An absent row is unknown; explicit zero-minute rows are retained as DNPs.",
      "Bootstrap intervals condition on fitted parameters and do not include estimation uncertainty; candidates are not refit or reselected within draws.",
      "Individual on-pitch goals-conceded timing is not present in player rows; projected goals-conceded component shifts are reported, while direct component RMSE is reported for goals, assists, and clean-sheet points.",
    ],
    artifacts: {
      protocol: path.relative(REPO, PROTOCOL_FILE),
      fits: path.relative(REPO, path.join(OUTPUT, "models/fits-2023-24.json")),
      selection: path.relative(REPO, path.join(OUTPUT, "selection.json")),
      teamObservations: SEASONS.map((season) => path.relative(REPO, path.join(OUTPUT, "data", `team-observations-${season}.json`))),
      playerPredictions: SEASONS.slice(1).map((season) => path.relative(REPO, path.join(OUTPUT, "predictions", `player-gameweeks-${season}.json.gz`))),
      calibration: path.relative(REPO, path.join(OUTPUT, "calibration/final-2025-26.json")),
      pooledSecondary: path.relative(REPO, path.join(OUTPUT, "metrics/pooled-2024-25-2025-26-secondary.json")),
    },
  };
  writeJson(path.join(OUTPUT, "summary.json"), summary);
  writeJson(RESULT_JSON, summary);
  const markdown = conciseReport(summary as unknown as ReportSummary);
  mkdirSync(path.dirname(RESULT_MD), { recursive: true });
  writeFileSync(RESULT_MD, markdown, "utf8");
  console.log(`Final recommendation: ${String((verdict as { recommendation: string }).recommendation)}.`);
  console.log(`Wrote ${RESULT_JSON}, ${RESULT_MD}, and experiment artifacts in ${OUTPUT}.`);
  return summary;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "freeze") {
    createFrozenProtocol();
    return;
  }
  if (command === "run") {
    await runExperiment();
    return;
  }
  throw new Error("Use 'freeze' to persist the protocol before scoring, then 'run' to execute the experiment.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(REPO, "scripts/backtest/attackdefensemult-testing.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
