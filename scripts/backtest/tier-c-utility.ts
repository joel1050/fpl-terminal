/**
 * Tier C: compare raw xP with the shipped utility-weighted beam search using
 * leak-free historical inputs. The source CSV supplies only prices, because
 * prepare-seasons.ts intentionally drops them from the shared backtest corpus.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Player, PlayerFixture, Position } from "@/types/player";
import type { PlayerMatchRate, TeamStrength } from "@/types/projection";
import type { EntryPick, EntryPicks } from "@/types/leagues";
import type { HistoricalBundle, HistoricalMatchStat } from "@/lib/historical/types";
import { buildPlayerSelections } from "@/lib/availability/selection";
import type { StartObservation } from "@/lib/availability/startRate";
import { applyInSeasonForm, type TeamMatchXG } from "@/lib/historical/inSeasonForm";
import { analyzeSquad } from "@/lib/analysis/analyzeSquad";
import {
  horizonValue,
  legalSquad,
  playerMap,
  POSITION_MINIMUMS,
  POSITIONS,
  utilityValue,
} from "@/lib/analysis/context";
import { optimizeFullSquad, type OptimizerInput } from "@/lib/optimizer/optimizer";
import { projectPlayer } from "@/lib/projections/projectPlayer";
import { pickWeeklyTeam } from "@/lib/squad/weeklyLineup";
import { applyFallbackAutosubs } from "@/lib/leagues/calculateLiveEntry";
import { minimumRemainingSpend } from "@/lib/squad/budget";
import { parseCsv } from "@/lib/historical/ingest";
import { buildFixturesFromMatchRows } from "./multiSeasonData";
import { loadSeason, playerAt, type Fixture, type MatchRow, type Season } from "./season";

const ROOT = path.resolve(__dirname, "../..");
const OUTPUT = path.join(ROOT, "output/tier-c");
const ARCHIVE = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data";
const HORIZON = 5 as const;
const BUDGET = 1000;
const MAX_PER_CLUB = 3;
const CANDIDATE_LIMIT = 20;
const BEAM_WIDTH = 120;
const LAMBDA_GRID = [0, 0.25, 0.5, 0.75, 1] as const;
const PREVIOUS_SEASON: Record<string, string> = {
  "2023-24": "2022-23",
  "2024-25": "2023-24",
  "2025-26": "2024-25",
};

type HistoricalSelectionData = Pick<HistoricalBundle, "players" | "matchStats" | "playerMappings">;
type WalkForwardInputs = {
  strengths: Record<number, TeamStrength>;
  eligibleFixtures: Map<number, Map<number, Fixture>>;
};

type PriceRow = { playerId: number; gameweek: number; priceTenths: number };
type PriceIndex = Map<number, PriceRow[]>;
type PriceData = { rows: PriceRow[]; hash: string; source: string; duplicateRows: number };
type WeekResult = {
  gameweek: number;
  poolSize: number;
  rawPoints: number;
  utilityPoints: number;
  fittedPoints: number;
  utilityVsRaw: number;
  fittedVsUtility: number;
  rawIds: number[];
  utilityIds: number[];
  fittedIds: number[];
};
type EvalFile = {
  season: string;
  startGameweek: number;
  endGameweek: number;
  fittedLambda: number;
  priceCsvSha256: string;
  source: string;
  duplicateSourceRows: number;
  deduplicatedPreparedRows: number;
  failures: Array<{ gameweek: number; poolSize: number; message: string; minimumLegalCostTenths: number }>;
  decisions: WeekResult[];
};

function fail(message: string): never {
  throw new Error(message);
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "" || value === "None" || value === "null") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rowKey(playerId: number, gameweek: number, fixtureId?: number): string {
  return `${playerId}:${gameweek}:${fixtureId ?? ""}`;
}

function deduplicateSeason(season: Season): number {
  const unique = new Map<string, MatchRow>();
  let duplicateRows = 0;
  for (const row of [...season.rowsByPlayer.values()].flat()) {
    const key = rowKey(row.historicalPlayerId, row.gameweek, row.fixtureId);
    const previous = unique.get(key);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(row)) fail(`Conflicting prepared duplicate row: ${key}`);
      duplicateRows += 1;
    } else unique.set(key, row);
  }
  if (!duplicateRows) return 0;

  const rows = [...unique.values()];
  season.rowsByGameweek = new Map();
  season.rowsByPlayer = new Map();
  const countsByPlayer = new Map<number, Map<number, number>>();
  const fixtureById = new Map(season.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  for (const row of rows) {
    (season.rowsByGameweek.get(row.gameweek) ?? season.rowsByGameweek.set(row.gameweek, []).get(row.gameweek)!).push(row);
    (season.rowsByPlayer.get(row.historicalPlayerId) ?? season.rowsByPlayer.set(row.historicalPlayerId, []).get(row.historicalPlayerId)!).push(row);
    const teamId = teamForRow(row, fixtureById);
    if (teamId !== undefined) {
      const counts = countsByPlayer.get(row.historicalPlayerId) ?? countsByPlayer.set(row.historicalPlayerId, new Map()).get(row.historicalPlayerId)!;
      counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
    }
  }
  for (const rowsForPlayer of season.rowsByPlayer.values()) rowsForPlayer.sort((a, b) => a.gameweek - b.gameweek || (a.fixtureId ?? 0) - (b.fixtureId ?? 0));
  season.teamOf = new Map([...countsByPlayer].map(([playerId, counts]) => {
    let teamId = -1;
    let bestCount = -1;
    for (const [candidate, count] of counts) if (count > bestCount) { teamId = candidate; bestCount = count; }
    return [playerId, teamId];
  }));

  const oldFixtures = new Map(season.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  season.fixtures = buildFixturesFromMatchRows(rows).map((fixture) => {
    const previous = oldFixtures.get(fixture.fixtureId);
    return previous ? { ...fixture, homeDifficulty: previous.homeDifficulty, awayDifficulty: previous.awayDifficulty } : fixture;
  });
  season.fixturesByGameweek = new Map();
  for (const fixture of season.fixtures) {
    (season.fixturesByGameweek.get(fixture.gameweek) ?? season.fixturesByGameweek.set(fixture.gameweek, []).get(fixture.gameweek)!).push(fixture);
  }
  season.leagueAverageXg = season.fixtures.length
    ? season.fixtures.reduce((sum, fixture) => sum + fixture.homeXg + fixture.awayXg, 0) / (season.fixtures.length * 2)
    : 0;
  return duplicateRows;
}

async function readPriceRows(seasonName: string, season: Season): Promise<PriceData> {
  const source = `${ARCHIVE}/${seasonName}/gws/merged_gw.csv`;
  const response = await fetch(source, { headers: { Accept: "text/plain" }, cache: "no-store" });
  if (!response.ok) fail(`Historical price source returned HTTP ${response.status}: ${source}`);
  const csv = await response.text();
  const rows = parseCsv(csv);
  const rawByKey = new Map<string, Record<string, string>>();
  const prices: PriceRow[] = [];
  let duplicateRows = 0;
  for (const row of rows) {
    const playerId = numeric(row.element);
    const gameweek = numeric(row.GW ?? row.round);
    if (playerId === undefined || gameweek === undefined) continue;
    const fixtureId = numeric(row.fixture);
    const key = rowKey(playerId, gameweek, fixtureId);
    const previous = rawByKey.get(key);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(row)) fail(`Conflicting source duplicate row for ${key} in ${source}`);
      duplicateRows += 1;
      continue;
    }
    rawByKey.set(key, row);
    const priceTenths = numeric(row.value);
    if (priceTenths !== undefined && priceTenths > 0) prices.push({ playerId, gameweek, priceTenths });
  }

  const preparedRows = [...season.rowsByPlayer.values()].flat();
  if (preparedRows.length !== rawByKey.size) {
    fail(`Prepared/source row count mismatch for ${seasonName}: ${preparedRows.length} vs ${rawByKey.size}`);
  }
  const fields: Array<["minutes" | "totalPoints" | "goals" | "assists" | "expectedGoals" | "expectedAssists" | "bonus" | "bps" | "saves" | "goalsConceded", string]> = [
    ["minutes", "minutes"], ["totalPoints", "total_points"], ["goals", "goals_scored"],
    ["assists", "assists"], ["expectedGoals", "expected_goals"],
    ["expectedAssists", "expected_assists"], ["bonus", "bonus"], ["bps", "bps"],
    ["saves", "saves"], ["goalsConceded", "goals_conceded"],
  ];
  for (const prepared of preparedRows) {
    const raw = rawByKey.get(rowKey(prepared.historicalPlayerId, prepared.gameweek, prepared.fixtureId));
    if (!raw) fail(`Prepared row missing from price source: ${rowKey(prepared.historicalPlayerId, prepared.gameweek, prepared.fixtureId)}`);
    for (const [field, rawField] of fields) {
      const left = prepared[field];
      const right = numeric(raw[rawField]);
      if (left === undefined && right === undefined) continue;
      if (left === undefined || right === undefined || Math.abs(left - right) > 1e-9) {
        fail(`Prepared/source mismatch at player ${prepared.historicalPlayerId}, GW${prepared.gameweek}, ${rawField}: ${left} vs ${right}`);
      }
    }
    const rawWasHome = raw.was_home;
    if ((rawWasHome === "True" || rawWasHome === "true") !== prepared.wasHome) {
      fail(`Prepared/source venue mismatch for player ${prepared.historicalPlayerId}, GW${prepared.gameweek}`);
    }
  }
  return { rows: prices, hash: createHash("sha256").update(csv).digest("hex"), source, duplicateRows };
}

function indexPrices(prices: readonly PriceRow[]): PriceIndex {
  const indexed: PriceIndex = new Map();
  for (const price of prices) {
    const rows = indexed.get(price.playerId) ?? [];
    rows.push(price);
    indexed.set(price.playerId, rows);
  }
  for (const rows of indexed.values()) rows.sort((a, b) => a.gameweek - b.gameweek);
  return indexed;
}

function currentPrice(prices: PriceIndex, playerId: number, beforeGameweek: number): number | undefined {
  let bestWeek = -1;
  let bestPrice: number | undefined;
  for (const row of prices.get(playerId) ?? []) {
    if (row.gameweek < beforeGameweek && row.gameweek >= bestWeek) {
      bestWeek = row.gameweek;
      bestPrice = row.priceTenths;
    }
  }
  return bestPrice;
}

function teamForRow(row: MatchRow, fixtures: ReadonlyMap<number, Fixture>): number | undefined {
  const fixture = fixtures.get(row.fixtureId);
  return fixture ? (row.wasHome ? fixture.homeTeamId : fixture.awayTeamId) : undefined;
}

function fixtureFor(teamId: number, fixture: Fixture, gameweek: number): PlayerFixture {
  const isHome = fixture.homeTeamId === teamId;
  return {
    fixtureId: fixture.fixtureId,
    gameweek,
    opponentTeamId: isHome ? fixture.awayTeamId : fixture.homeTeamId,
    opponentShortName: "OPP",
    isHome,
    // Historical FDR snapshots are not archived by gameweek; neutralize it.
    difficulty: 3,
    exactDifficulty: 3,
  };
}

async function loadHistoricalSelectionData(seasonName: string): Promise<HistoricalSelectionData> {
  const previousSeason = PREVIOUS_SEASON[seasonName];
  if (!previousSeason) fail(`No adjacent previous-season mapping for ${seasonName}.`);
  const seasonDir = process.env.BACKTEST_DATA_DIR;
  if (!seasonDir) fail("Set BACKTEST_DATA_DIR to the prepared season directory.");
  if (path.basename(path.resolve(seasonDir)) !== seasonName) {
    fail(`BACKTEST_DATA_DIR must point at the ${seasonName} directory; got ${seasonDir}.`);
  }
  const dataRoot = path.dirname(path.resolve(seasonDir));
  const [anchorsText, rowsText] = await Promise.all([
    readFile(path.join(seasonDir, "previous-player-anchors.json"), "utf8"),
    readFile(path.join(dataRoot, previousSeason, "historical-match-stats.json"), "utf8"),
  ]);
  const anchors = JSON.parse(anchorsText) as Array<{ historicalPlayerId: number; sourceHistoricalPlayerId: number }>;
  const previousRows = JSON.parse(rowsText) as MatchRow[];
  const currentIdByPreviousId = new Map(anchors.map((anchor) => [anchor.sourceHistoricalPlayerId, anchor.historicalPlayerId]));
  const matchStats: HistoricalMatchStat[] = previousRows.flatMap((row) => {
    const historicalPlayerId = currentIdByPreviousId.get(row.historicalPlayerId);
    return historicalPlayerId === undefined ? [] : [{ ...row, historicalPlayerId }];
  });
  return {
    players: [],
    matchStats,
    playerMappings: anchors.map((anchor) => ({
      currentPlayerId: anchor.historicalPlayerId,
      historicalPlayerId: anchor.historicalPlayerId,
      confidence: "EXACT" as const,
    })),
  };
}

function walkForwardInputs(season: Season, gameweek: number): WalkForwardInputs {
  const eligibleFixtures = new Map<number, Map<number, Fixture>>();
  for (const [week, fixtures] of season.fixturesByGameweek) {
    if (week >= gameweek) continue;
    const appearances = new Map<number, number>();
    for (const fixture of fixtures) {
      appearances.set(fixture.homeTeamId, (appearances.get(fixture.homeTeamId) ?? 0) + 1);
      appearances.set(fixture.awayTeamId, (appearances.get(fixture.awayTeamId) ?? 0) + 1);
    }
    const eligible = new Map<number, Fixture>();
    for (const fixture of fixtures) {
      if (appearances.get(fixture.homeTeamId) === 1) eligible.set(fixture.homeTeamId, fixture);
      if (appearances.get(fixture.awayTeamId) === 1) eligible.set(fixture.awayTeamId, fixture);
    }
    if (eligible.size) eligibleFixtures.set(week, eligible);
  }

  const history: Record<number, TeamMatchXG[]> = {};
  for (const [week, fixtures] of season.fixturesByGameweek) {
    if (week >= gameweek) continue;
    const eligible = eligibleFixtures.get(week);
    if (!eligible) continue;
    // The production team-xG loader only records a fixture when both clubs
    // have exactly one match in that gameweek.
    for (const fixture of fixtures) {
      if (!eligible.has(fixture.homeTeamId) || !eligible.has(fixture.awayTeamId)) continue;
      (history[fixture.homeTeamId] ??= []).push({
        xgFor: fixture.homeXg, xgAgainst: fixture.awayXg,
        opponentTeamId: fixture.awayTeamId, wasHome: true,
      });
      (history[fixture.awayTeamId] ??= []).push({
        xgFor: fixture.awayXg, xgAgainst: fixture.homeXg,
        opponentTeamId: fixture.homeTeamId, wasHome: false,
      });
    }
  }
  return { strengths: applyInSeasonForm(season.priorStrengths, history), eligibleFixtures };
}

function groupedPlayerRows(season: Season, playerId: number, beforeGameweek: number): Map<number, MatchRow[]> {
  const rowsByWeek = new Map<number, MatchRow[]>();
  for (const row of season.rowsByPlayer.get(playerId) ?? []) {
    if (row.gameweek >= beforeGameweek) continue;
    (rowsByWeek.get(row.gameweek) ?? rowsByWeek.set(row.gameweek, []).get(row.gameweek)!).push(row);
  }
  return rowsByWeek;
}

function playerFormBefore(
  season: Season,
  playerId: number,
  teamId: number,
  rowsByWeek: ReadonlyMap<number, readonly MatchRow[]>,
  eligibleFixtures: ReadonlyMap<number, ReadonlyMap<number, Fixture>>,
  firstPriceWeek: number,
): PlayerMatchRate[] {
  const form: PlayerMatchRate[] = [];
  for (const [week, fixtures] of eligibleFixtures) {
    if (week < firstPriceWeek) continue;
    const fixture = fixtures.get(teamId);
    if (!fixture) continue;
    const rows = rowsByWeek.get(week) ?? [];
    const minutes = rows.reduce((sum, row) => sum + row.minutes, 0);
    if (minutes <= 0) continue;
    const isHome = fixture.homeTeamId === teamId;
    form.push({
      xg: rows.reduce((sum, row) => sum + (row.expectedGoals ?? 0), 0),
      xa: rows.reduce((sum, row) => sum + (row.expectedAssists ?? 0), 0),
      minutes,
      opponentTeamId: isHome ? fixture.awayTeamId : fixture.homeTeamId,
      wasHome: isHome,
    });
  }
  return form;
}

function startHistoryBefore(
  rowsByWeek: ReadonlyMap<number, readonly MatchRow[]>,
  teamId: number,
  eligibleFixtures: ReadonlyMap<number, ReadonlyMap<number, Fixture>>,
  firstPriceWeek: number,
): StartObservation[] {
  const observations: StartObservation[] = [];
  for (const [week, fixtures] of eligibleFixtures) {
    if (week < firstPriceWeek || !fixtures.has(teamId)) continue;
    const minutes = (rowsByWeek.get(week) ?? []).reduce((sum, row) => sum + row.minutes, 0);
    observations.push({ started: minutes >= 60, appeared: minutes > 0, minutes });
  }
  return observations;
}

function firstPriceGameweek(prices: PriceIndex, playerId: number): number | undefined {
  const rows = prices.get(playerId) ?? [];
  return rows.length ? rows[0].gameweek : undefined;
}

function buildUniverse(
  season: Season,
  prices: PriceIndex,
  gameweek: number,
  historical: HistoricalSelectionData,
): Player[] {
  if (!season.hasPreparedPriors) fail("This season lacks prepared previous-season player anchors; refusing target-season aggregate leakage.");
  const fixtureById = new Map(season.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const fixturesByGameweek = season.fixturesByGameweek;
  const { strengths, eligibleFixtures } = walkForwardInputs(season, gameweek);
  const horizonFixtures = Array.from({ length: HORIZON }, (_, offset) => fixturesByGameweek.get(gameweek + offset) ?? [])
    .flat();
  const candidates: Player[] = [];
  const formByPlayer = new Map<number, PlayerMatchRate[]>();
  const startsByPlayer: Record<number, StartObservation[]> = {};

  for (const [playerId, source] of season.players) {
    const priorRows = season.rowsByPlayer.get(playerId)?.filter((row) => row.gameweek < gameweek) ?? [];
    const priceTenths = currentPrice(prices, playerId, gameweek);
    const firstPriceWeek = firstPriceGameweek(prices, playerId);
    if (!priorRows.length || priceTenths === undefined || firstPriceWeek === undefined || !source.position) continue;
    const latestTeam = teamForRow(priorRows[priorRows.length - 1], fixtureById);
    // Use the latest team observed before the decision deadline; the target
    // gameweek's match rows would reveal transfers and teams after kickoff.
    const teamId = latestTeam;
    if (teamId === undefined) continue;
    const scheduled = horizonFixtures.filter((fixture) => fixture.homeTeamId === teamId || fixture.awayTeamId === teamId);
    const referenceFixture = scheduled[0] ?? fixtureById.get(priorRows[priorRows.length - 1].fixtureId ?? -1) ?? season.fixtures[0];
    if (!referenceFixture) continue;
    const referenceIsHome = referenceFixture.homeTeamId === teamId;
    const previous = playerAt(season, playerId, gameweek, referenceFixture, referenceIsHome);
    if (!previous) continue;
    const player: Player = {
      ...previous,
      teamId,
      teamName: `Team ${teamId}`,
      teamShortName: "TST",
      priceTenths,
      status: "a",
      chanceOfPlaying: undefined,
      fixtures: scheduled.map((fixture) => fixtureFor(teamId, fixture, fixture.gameweek)),
    };
    const rowsByWeek = groupedPlayerRows(season, playerId, gameweek);
    formByPlayer.set(playerId, playerFormBefore(season, playerId, teamId, rowsByWeek, eligibleFixtures, firstPriceWeek));
    startsByPlayer[playerId] = startHistoryBefore(rowsByWeek, teamId, eligibleFixtures, firstPriceWeek);
    candidates.push(player);
  }

  const selections = buildPlayerSelections(candidates, {
    historical,
    historicalStats: season.previousStatsByPlayerId,
    startHistory: startsByPlayer,
    targetGameweek: gameweek,
  });
  const universe = candidates.map((candidate) => ({ ...candidate, selection: selections.get(candidate.id) }));
  for (const player of universe) {
    player.projection = projectPlayer(player, {
      currentGameweek: gameweek,
      horizon: HORIZON,
      teamStrengths: strengths,
      playerForm: { [player.id]: formByPlayer.get(player.id) ?? [] },
    });
  }
  return universe;
}

function valueFor(player: Player, lambda: number): number {
  const xp = horizonValue(player, HORIZON);
  if (lambda === 0 || xp <= 0) return xp;
  if (lambda === 1) return utilityValue(player, HORIZON, "BALANCED");
  return xp * Math.pow(utilityValue(player, HORIZON, "BALANCED") / xp, lambda);
}

type State = { ids: number[]; cost: number; score: number };

function poolFor(players: readonly Player[], position: Position, lambda: number): Player[] {
  const available = players.filter((player) => player.position === position);
  const score = (player: Player) => valueFor(player, lambda);
  const ranked = [...available].sort((a, b) => score(b) - score(a) || a.priceTenths - b.priceTenths || a.id - b.id);
  const cheap = [...available].sort((a, b) => a.priceTenths - b.priceTenths || a.id - b.id);
  const chosen = new Map<number, Player>();
  for (const player of [...ranked.slice(0, CANDIDATE_LIMIT), ...cheap.slice(0, Math.max(8, Math.floor(CANDIDATE_LIMIT / 2)))]) chosen.set(player.id, player);
  return [...chosen.values()].sort((a, b) => a.id - b.id);
}

function minimumCheapCost(
  remaining: readonly Position[],
  pools: ReadonlyMap<Position, readonly Player[]>,
  selected: ReadonlySet<number>,
): number | undefined {
  const positions = [...remaining].sort((a, b) => (pools.get(a)?.length ?? 0) - (pools.get(b)?.length ?? 0));
  const used = new Set(selected);
  let total = 0;
  for (const position of positions) {
    const candidate = (pools.get(position) ?? []).filter((player) => !used.has(player.id))
      .sort((a, b) => a.priceTenths - b.priceTenths || a.id - b.id)[0];
    if (!candidate) return undefined;
    used.add(candidate.id);
    total += candidate.priceTenths;
  }
  return total;
}

function constructionScore(ids: readonly number[], players: ReadonlyMap<number, Player>, lambda: number): number {
  const keepers = ids.map((id) => players.get(id)).filter((player): player is Player => player?.position === "GK")
    .sort((a, b) => valueFor(b, lambda) - valueFor(a, lambda));
  const outfield = ids.map((id) => players.get(id)).filter((player): player is Player => player !== undefined && player.position !== "GK");
  return outfield.reduce((sum, player) => sum + valueFor(player, lambda), 0)
    + (keepers[0] ? valueFor(keepers[0], lambda) : 0)
    + keepers.slice(1).reduce((sum, player) => sum + valueFor(player, lambda) * 0.05 - player.priceTenths / 20, 0);
}

function objectiveScore(ids: readonly number[], players: Player[], lambda: number): number {
  const map = playerMap(players);
  const analysis = analyzeSquad({ squad: ids, players, horizon: HORIZON, risk: "BALANCED", budgetTenths: BUDGET, maxPlayersPerClub: MAX_PER_CLUB });
  const starters = new Set(analysis.startingXI);
  let score = analysis.startingXI.reduce((sum, id) => sum + valueFor(map.get(id)!, lambda), 0);
  const benchWeights = [0.25, 0.15, 0.1];
  let outfieldIndex = 0;
  for (const id of analysis.bench) {
    const player = map.get(id)!;
    if (player.position === "GK") score += valueFor(player, lambda) * 0.05 - player.priceTenths / 20;
    else {
      score += valueFor(player, lambda) * (benchWeights[outfieldIndex] ?? 0.1);
      outfieldIndex += 1;
    }
  }
  score += [...starters].reduce((sum, id) => sum + (map.get(id)?.projection?.confidence === "HIGH" ? 0.01 : 0), 0);
  return score;
}

/** Same bounded beam as optimizer.ts with only the value scalar parameterized. */
function chooseSquad(players: Player[], lambda: number): { ids: number[]; score: number } | undefined {
  const map = playerMap(players);
  const pools = new Map<Position, Player[]>(POSITIONS.map((position) => [position, poolFor(players, position, lambda)]));
  const positions = POSITIONS.flatMap((position) => Array.from({ length: POSITION_MINIMUMS[position] }, () => position));
  let states: State[] = [{ ids: [], cost: 0, score: 0 }];
  for (let slot = 0; slot < positions.length; slot += 1) {
    const position = positions[slot];
    const next: State[] = [];
    for (const state of states) {
      const selected = new Set(state.ids);
      const clubs = new Map<number, number>();
      for (const id of state.ids) {
        const club = map.get(id)!.teamId;
        clubs.set(club, (clubs.get(club) ?? 0) + 1);
      }
      for (const player of pools.get(position) ?? []) {
        if (selected.has(player.id) || (clubs.get(player.teamId) ?? 0) >= MAX_PER_CLUB) continue;
        const cost = state.cost + player.priceTenths;
        if (cost > BUDGET) continue;
        const ids = [...state.ids, player.id];
        const minimum = minimumCheapCost(positions.slice(slot + 1), pools, new Set([...selected, player.id]));
        if (minimum === undefined || cost + minimum > BUDGET) continue;
        next.push({ ids, cost, score: constructionScore(ids, map, lambda) });
      }
    }
    next.sort((a, b) => b.score - a.score || a.cost - b.cost || a.ids.join(",").localeCompare(b.ids.join(",")));
    states = next.slice(0, Math.max(24, BEAM_WIDTH));
    if (!states.length) return undefined;
  }
  const complete = states.filter((state) => legalSquad(state.ids, map, { budgetTenths: BUDGET, maxPlayersPerClub: MAX_PER_CLUB }).legal)
    .sort((a, b) => objectiveScore(b.ids, players, lambda) - objectiveScore(a.ids, players, lambda) || a.cost - b.cost);
  return complete[0] ? { ids: complete[0].ids, score: objectiveScore(complete[0].ids, players, lambda) } : undefined;
}

function productionSquad(players: Player[]): { ids: number[]; score: number } {
  const input: OptimizerInput = {
    players,
    horizon: HORIZON,
    risk: "BALANCED",
    budgetTenths: BUDGET,
    maxPlayersPerClub: MAX_PER_CLUB,
    candidateLimit: CANDIDATE_LIMIT,
    beamWidth: BEAM_WIDTH,
  };
  const result = optimizeFullSquad(input);
  if (!result.legal || result.score === undefined) fail(`Shipped beam failed to return a legal squad: ${result.errors.join("; ")}`);
  return { ids: result.playerIds, score: result.score };
}

function realizedPoints(ids: readonly number[], players: readonly Player[], season: Season, gameweek: number): number {
  const byId = new Map(players.map((player) => [player.id, player]));
  const squad = ids.map((id) => byId.get(id)).filter((player): player is Player => player !== undefined);
  if (squad.length !== 15) fail(`Decision squad has ${squad.length} players in GW${gameweek}`);
  const plan = pickWeeklyTeam({ squad, gameweek, riskMode: "BALANCED" });
  if (plan.warnings.length || plan.starterIds.length !== 11) fail(`Production lineup invalid in GW${gameweek}: ${plan.warnings.join("; ")}`);
  const substituteIds = [plan.benchGoalkeeperId, ...plan.benchOrder];
  const ordered = [...plan.starterIds, ...substituteIds];
  const picks: EntryPick[] = ordered.map((element, index) => ({
    element,
    position: index + 1,
    elementType: byId.get(element)!.position === "GK" ? 1 : byId.get(element)!.position === "DEF" ? 2 : byId.get(element)!.position === "MID" ? 3 : 4,
    multiplier: index < 11 ? (element === plan.captainId ? 2 : 1) : 0,
    isCaptain: element === plan.captainId,
    isViceCaptain: element === plan.viceCaptainId,
  }));
  const entry: EntryPicks = { entryId: 0, gameweek, automaticSubs: [], picks };
  const actualRows = season.rowsByGameweek.get(gameweek) ?? [];
  const stats = new Map<number, { minutes: number; total_points: number }>();
  for (const row of actualRows) {
    const prior = stats.get(row.historicalPlayerId) ?? { minutes: 0, total_points: 0 };
    prior.minutes += row.minutes;
    prior.total_points += row.totalPoints;
    stats.set(row.historicalPlayerId, prior);
  }
  const liveStats = new Map(picks.map((pick) => [pick.element, stats.get(pick.element) ?? { minutes: 0, total_points: 0 }]));
  const statuses = new Map(picks.map((pick) => [pick.element, {
    status: "DONE" as const, started: true, remaining: 0, finished: 1, live: 0,
  }]));
  const multipliers = applyFallbackAutosubs(entry, liveStats, statuses);
  return picks.reduce((sum, pick) => sum + (liveStats.get(pick.element)?.total_points ?? 0) * (multipliers.get(pick.element) ?? 0), 0);
}

async function save(file: string, value: unknown): Promise<void> {
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(path.join(OUTPUT, file), `${JSON.stringify(value, null, 2)}\n`);
}

async function fit(): Promise<void> {
  const seasonName = process.env.TIER_C_SEASON ?? "2024-25";
  const start = Number(process.env.TIER_C_START_GW ?? 6);
  const end = Number(process.env.TIER_C_END_GW ?? 20);
  const season = loadSeason();
  const preparedDuplicates = deduplicateSeason(season);
  const historical = await loadHistoricalSelectionData(seasonName);
  const priceData = await readPriceRows(seasonName, season);
  const prices = indexPrices(priceData.rows);
  const weeks: Array<{ gameweek: number; poolSize: number; points: Record<string, number> }> = [];
  for (let gameweek = start; gameweek <= end; gameweek += 1) {
    if (gameweek + HORIZON - 1 > 38) continue;
    const players = buildUniverse(season, prices, gameweek, historical);
    const production = productionSquad(players);
    const shippedClone = chooseSquad(players, 1);
    if (!shippedClone || shippedClone.ids.join(",") !== production.ids.join(",") || Math.abs(shippedClone.score - production.score) > 1e-9) {
      fail(`Production parity failure in utility beam clone, ${seasonName} GW${gameweek}`);
    }
    const points: Record<string, number> = {};
    for (const lambda of LAMBDA_GRID) {
      const decision = lambda === 1 ? production : chooseSquad(players, lambda);
      if (!decision) fail(`No legal squad for lambda=${lambda}, ${seasonName} GW${gameweek}`);
      const legality = legalSquad(decision.ids, playerMap(players), { budgetTenths: BUDGET, maxPlayersPerClub: MAX_PER_CLUB });
      if (!legality.legal) fail(`Illegal training squad: ${legality.errors.join("; ")}`);
      points[String(lambda)] = realizedPoints(decision.ids, players, season, gameweek);
    }
    weeks.push({ gameweek, poolSize: players.length, points });
    console.log(`${seasonName} GW${gameweek}: pool=${players.length}; ${Object.entries(points).map(([lambda, score]) => `lambda=${lambda}:${score}`).join(" ")}`);
  }
  if (!weeks.length) fail("Training range produced no gameweeks.");
  const means = LAMBDA_GRID.map((lambda) => ({
    lambda,
    meanPoints: weeks.reduce((sum, week) => sum + week.points[String(lambda)], 0) / weeks.length,
    totalPoints: weeks.reduce((sum, week) => sum + week.points[String(lambda)], 0),
  }));
  const selected = [...means].sort((a, b) => b.meanPoints - a.meanPoints || b.lambda - a.lambda)[0];
  const result = { season: seasonName, startGameweek: start, endGameweek: end, priceCsvSha256: priceData.hash, source: priceData.source, duplicateSourceRows: priceData.duplicateRows, deduplicatedPreparedRows: preparedDuplicates, decisions: weeks, means, fittedLambda: selected.lambda };
  await save("fit.json", result);
  console.log(`FIT lambda=${selected.lambda} on ${weeks.length} GW clusters; SHA256=${priceData.hash}`);
}

async function evaluate(): Promise<void> {
  const seasonName = process.env.TIER_C_SEASON;
  if (!seasonName) fail("Set TIER_C_SEASON to one prepared season.");
  const start = Number(process.env.TIER_C_START_GW ?? (seasonName === "2024-25" ? 21 : 6));
  const end = Number(process.env.TIER_C_END_GW ?? 34);
  const fit = JSON.parse(await readFile(path.join(OUTPUT, "fit.json"), "utf8")) as { fittedLambda: number };
  const season = loadSeason();
  const preparedDuplicates = deduplicateSeason(season);
  const historical = await loadHistoricalSelectionData(seasonName);
  const priceData = await readPriceRows(seasonName, season);
  const prices = indexPrices(priceData.rows);
  const decisions: WeekResult[] = [];
  const failures: EvalFile["failures"] = [];
  for (let gameweek = start; gameweek <= end; gameweek += 1) {
    if (gameweek + HORIZON - 1 > 38) continue;
    const players = buildUniverse(season, prices, gameweek, historical);
    let production: { ids: number[]; score: number };
    try {
      production = productionSquad(players);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const minimumCost = minimumRemainingSpend([], players);
      failures.push({ gameweek, poolSize: players.length, message, minimumLegalCostTenths: minimumCost });
      console.error(`FAIL ${seasonName} GW${gameweek}: ${message}; minimumLegalCost=${minimumCost} tenths`);
      continue;
    }
    const utilityClone = chooseSquad(players, 1);
    if (!utilityClone || utilityClone.ids.join(",") !== production.ids.join(",") || Math.abs(utilityClone.score - production.score) > 1e-9) {
      fail(`Production parity failure in utility beam clone, ${seasonName} GW${gameweek}`);
    }
    const raw = chooseSquad(players, 0);
    const fitted = fit.fittedLambda === 1 ? production : chooseSquad(players, fit.fittedLambda);
    if (!raw || !fitted) fail(`No legal squad for ${seasonName} GW${gameweek}`);
    for (const ids of [production.ids, raw.ids, fitted.ids]) {
      const legality = legalSquad(ids, playerMap(players), { budgetTenths: BUDGET, maxPlayersPerClub: MAX_PER_CLUB });
      if (!legality.legal) fail(`Illegal test squad: ${legality.errors.join("; ")}`);
    }
    const utilityPoints = realizedPoints(production.ids, players, season, gameweek);
    const rawPoints = realizedPoints(raw.ids, players, season, gameweek);
    const fittedPoints = realizedPoints(fitted.ids, players, season, gameweek);
    decisions.push({
      gameweek, poolSize: players.length, rawPoints, utilityPoints, fittedPoints,
      utilityVsRaw: utilityPoints - rawPoints,
      fittedVsUtility: fittedPoints - utilityPoints,
      rawIds: raw.ids, utilityIds: production.ids, fittedIds: fitted.ids,
    });
    console.log(`${seasonName} GW${gameweek}: pool=${players.length}; raw=${rawPoints} shipped=${utilityPoints} fitted=${fittedPoints}`);
  }
  if (!decisions.length) fail("Evaluation range produced no gameweeks.");
  const result: EvalFile = {
    season: seasonName, startGameweek: start, endGameweek: end,
    fittedLambda: fit.fittedLambda, priceCsvSha256: priceData.hash, source: priceData.source,
    duplicateSourceRows: priceData.duplicateRows, deduplicatedPreparedRows: preparedDuplicates, failures, decisions,
  };
  await save(`eval-${seasonName}.json`, result);
  console.log(`EVAL ${seasonName}: ${decisions.length} GW clusters; fitted lambda=${fit.fittedLambda}; SHA256=${priceData.hash}`);
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: readonly number[], p: number): number {
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower] * (1 - fraction) + sorted[Math.min(lower + 1, sorted.length - 1)] * fraction;
}

function interval(groups: readonly number[][], seed: number): { mean: number; low: number; high: number } {
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  const mean = groups.flat().reduce((sum, value) => sum + value, 0) / total;
  const rng = random(seed);
  const samples: number[] = [];
  for (let iteration = 0; iteration < 10000; iteration += 1) {
    let sum = 0;
    for (const group of groups) {
      for (let draw = 0; draw < group.length; draw += 1) sum += group[Math.floor(rng() * group.length)];
    }
    samples.push(sum / total);
  }
  samples.sort((a, b) => a - b);
  return { mean, low: quantile(samples, 0.025), high: quantile(samples, 0.975) };
}

function seasonMetric(file: EvalFile, field: "utilityVsRaw" | "fittedVsUtility") {
  const differences = file.decisions.map((decision) => decision[field]);
  const result = interval([differences], 26008 + file.season.length + differences.length);
  const wins = differences.filter((value) => value > 0).length;
  return { decisions: differences.length, meanPointsPerGw: result.mean, low: result.low, high: result.high, positiveGws: wins, meanUtilityPoints: file.decisions.reduce((sum, decision) => sum + decision.utilityPoints, 0) / differences.length, meanRawPoints: file.decisions.reduce((sum, decision) => sum + decision.rawPoints, 0) / differences.length, meanFittedPoints: file.decisions.reduce((sum, decision) => sum + decision.fittedPoints, 0) / differences.length, differentSquads: file.decisions.filter((decision) => decision.rawIds.join(",") !== decision.utilityIds.join(",")).length };
}

async function summarize(): Promise<void> {
  const fit = JSON.parse(await readFile(path.join(OUTPUT, "fit.json"), "utf8")) as { fittedLambda: number; means: Array<{ lambda: number; meanPoints: number; totalPoints: number }>; decisions: unknown[] };
  const files: EvalFile[] = [];
  for (const seasonName of ["2024-25", "2025-26"]) {
    try { files.push(JSON.parse(await readFile(path.join(OUTPUT, `eval-${seasonName}.json`), "utf8")) as EvalFile); }
    catch { /* Missing held-out season outputs are reported below. */ }
  }
  if (!files.length) fail("No held-out evaluation JSON files found.");
  const shippedVsRaw = files.map((file) => seasonMetric(file, "utilityVsRaw"));
  const fittedVsShipped = files.map((file) => seasonMetric(file, "fittedVsUtility"));
  const fittedVsRaw = files.map((file, index) => interval(
    [file.decisions.map((decision) => decision.fittedPoints - decision.rawPoints)],
    260083 + index,
  ));
  const pooledRaw = interval(files.map((file) => file.decisions.map((decision) => decision.utilityVsRaw)), 260081);
  const pooledFit = interval(files.map((file) => file.decisions.map((decision) => decision.fittedVsUtility)), 260082);
  const pooledFitRaw = interval(files.map((file) => file.decisions.map((decision) => decision.fittedPoints - decision.rawPoints)), 260083);
  console.log(`Train fit: ${fit.decisions.length} GW clusters; selected lambda=${fit.fittedLambda}`);
  console.log("Train grid: " + fit.means.map((row) => `lambda=${row.lambda} mean=${row.meanPoints.toFixed(3)}`).join(" | "));
  for (let index = 0; index < files.length; index += 1) {
    const raw = shippedVsRaw[index];
    const fitted = fittedVsShipped[index];
    console.log(`${files[index].season} held out: n=${raw.decisions}; actual FPL points/GW raw=${raw.meanRawPoints.toFixed(3)} shipped=${raw.meanUtilityPoints.toFixed(3)} fitted=${raw.meanFittedPoints.toFixed(3)}; shipped-raw=${raw.meanPointsPerGw.toFixed(3)} [${raw.low.toFixed(3)}, ${raw.high.toFixed(3)}], positive GWs=${raw.positiveGws}/${raw.decisions}, squads changed=${raw.differentSquads}/${raw.decisions}; fitted-shipped=${fitted.meanPointsPerGw.toFixed(3)} [${fitted.low.toFixed(3)}, ${fitted.high.toFixed(3)}]; fitted-raw=${fittedVsRaw[index].mean.toFixed(3)} [${fittedVsRaw[index].low.toFixed(3)}, ${fittedVsRaw[index].high.toFixed(3)}]`);
  }
  const n = files.reduce((sum, file) => sum + file.decisions.length, 0);
  console.log(`Pooled held out: n=${n} GW clusters; shipped-raw=${pooledRaw.mean.toFixed(3)} [${pooledRaw.low.toFixed(3)}, ${pooledRaw.high.toFixed(3)}]; fitted-shipped=${pooledFit.mean.toFixed(3)} [${pooledFit.low.toFixed(3)}, ${pooledFit.high.toFixed(3)}]; fitted-raw=${pooledFitRaw.mean.toFixed(3)} [${pooledFitRaw.low.toFixed(3)}, ${pooledFitRaw.high.toFixed(3)}]`);
  for (const file of files) {
    console.log(`Source ${file.season}: ${file.source} sha256=${file.priceCsvSha256}; duplicate source/prepared rows=${file.duplicateSourceRows}/${file.deduplicatedPreparedRows}`);
    for (const failure of file.failures ?? []) console.log(`Failed GW ${file.season}: GW${failure.gameweek}, pool=${failure.poolSize}, minimumLegalCost=${failure.minimumLegalCostTenths} tenths, ${failure.message}`);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "fit") return fit();
  if (mode === "evaluate") return evaluate();
  if (mode === "summarize") return summarize();
  fail("Usage: npx tsx scripts/backtest/tier-c-utility.ts <fit|evaluate|summarize>");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
