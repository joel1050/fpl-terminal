import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Player, PlayerMapping, Position } from "@/types";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { FplBootstrapSchema, parseExternal } from "@/lib/fpl/schemas";
import type {
  HistoricalMatchStat,
  HistoricalPlayerRecord,
  HistoricalTeamStrength,
} from "./types";

export const HISTORICAL_SEASON = "2025/26";
export const HISTORICAL_REPOSITORY = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/2025-26";

export interface CsvRow {
  [key: string]: string;
}

export function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value !== "")) rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

function number(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "" || value === "None" || value === "null") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requiredNumber(value: string | undefined): number {
  return number(value) ?? 0;
}

function position(value: string | undefined): Position | undefined {
  return value === "GK" || value === "DEF" || value === "MID" || value === "FWD" ? value : undefined;
}

interface PlayerAccumulator {
  id: number;
  name: string;
  teamName?: string;
  position?: Position;
  minutes: number;
  starts: number;
  totalPoints: number;
  goals: number;
  assists: number;
  cleanSheets: number;
  saves: number;
  bonus: number;
  bps: number;
  influence: number;
  creativity: number;
  threat: number;
  expectedGoals: number;
  expectedAssists: number;
  defensiveContribution: number;
  yellowCards: number;
  redCards: number;
}

export function aggregateHistoricalPlayers(
  mergedText: string,
  playersRawText = "",
  season = HISTORICAL_SEASON,
): HistoricalPlayerRecord[] {
  const rawRows = parseCsv(playersRawText);
  const staticById = new Map(
    rawRows
      .map((row) => [number(row.id), row] as const)
      .filter((entry): entry is readonly [number, CsvRow] => entry[0] !== undefined),
  );
  const accumulators = new Map<number, PlayerAccumulator>();
  for (const row of parseCsv(mergedText)) {
    const id = number(row.element);
    if (id === undefined) continue;
    const staticRow = staticById.get(id);
    const current = accumulators.get(id) ?? {
      id,
      name: row.name || staticRow?.web_name || `Player ${id}`,
      teamName: row.team || undefined,
      position: position(row.position),
      minutes: 0,
      starts: 0,
      totalPoints: 0,
      goals: 0,
      assists: 0,
      cleanSheets: 0,
      saves: 0,
      bonus: 0,
      bps: 0,
      influence: 0,
      creativity: 0,
      threat: 0,
      expectedGoals: 0,
      expectedAssists: 0,
      defensiveContribution: 0,
      yellowCards: 0,
      redCards: 0,
    };
    current.minutes += requiredNumber(row.minutes);
    current.starts += requiredNumber(row.starts);
    current.totalPoints += requiredNumber(row.total_points);
    current.goals += requiredNumber(row.goals_scored);
    current.assists += requiredNumber(row.assists);
    current.cleanSheets += requiredNumber(row.clean_sheets);
    current.saves += requiredNumber(row.saves);
    current.bonus += requiredNumber(row.bonus);
    current.bps += requiredNumber(row.bps);
    current.influence += requiredNumber(row.influence);
    current.creativity += requiredNumber(row.creativity);
    current.threat += requiredNumber(row.threat);
    current.expectedGoals += requiredNumber(row.expected_goals);
    current.expectedAssists += requiredNumber(row.expected_assists);
    current.defensiveContribution += requiredNumber(row.defensive_contribution);
    current.yellowCards += requiredNumber(row.yellow_cards);
    current.redCards += requiredNumber(row.red_cards);
    accumulators.set(id, current);
  }

  return [...accumulators.values()].map((value) => {
    const per90 = value.minutes > 0 ? 90 / value.minutes : 0;
    return {
      historicalPlayerId: value.id,
      code: number(staticById.get(value.id)?.code),
      displayName: value.name,
      teamName: value.teamName,
      position: value.position,
      stats: {
        season,
        minutes: value.minutes,
        starts: value.starts,
        totalPoints: value.totalPoints,
        goals: value.goals,
        assists: value.assists,
        cleanSheets: value.cleanSheets,
        saves: value.saves,
        bonus: value.bonus,
        bps: value.bps,
        influence: value.influence,
        creativity: value.creativity,
        threat: value.threat,
        expectedGoals: value.expectedGoals,
        expectedAssists: value.expectedAssists,
        xGIPer90: (value.expectedGoals + value.expectedAssists) * per90,
        pointsPer90: value.totalPoints * per90,
        defensiveContribution: value.defensiveContribution,
        yellowCards: value.yellowCards,
        redCards: value.redCards,
      },
    };
  });
}

export function normalizeHistoricalMatchStats(mergedText: string): HistoricalMatchStat[] {
  return parseCsv(mergedText)
    .map((row): HistoricalMatchStat | null => {
      const playerId = number(row.element);
      const gameweek = number(row.GW ?? row.round);
      if (playerId === undefined || gameweek === undefined) return null;
      return {
        historicalPlayerId: playerId,
        gameweek,
        fixtureId: number(row.fixture),
        opponentTeamId: number(row.opponent_team),
        minutes: requiredNumber(row.minutes),
        totalPoints: requiredNumber(row.total_points),
        goals: requiredNumber(row.goals_scored),
        assists: requiredNumber(row.assists),
        expectedGoals: number(row.expected_goals),
        expectedAssists: number(row.expected_assists),
        bonus: requiredNumber(row.bonus),
        yellowCards: requiredNumber(row.yellow_cards),
        redCards: requiredNumber(row.red_cards),
        bps: requiredNumber(row.bps),
        wasHome: row.was_home === "True" || row.was_home === "true",
      };
    })
    .filter((row): row is HistoricalMatchStat => row !== null);
}

export function normalizeTeamStrength(teamsText: string): HistoricalTeamStrength[] {
  return parseCsv(teamsText)
    .map((row): HistoricalTeamStrength | null => {
      const teamId = number(row.id);
      if (teamId === undefined) return null;
      return {
        teamId,
        name: row.name,
        shortName: row.short_name,
        overallHome: number(row.strength_overall_home),
        overallAway: number(row.strength_overall_away),
        attackHome: number(row.strength_attack_home),
        attackAway: number(row.strength_attack_away),
        defenceHome: number(row.strength_defence_home),
        defenceAway: number(row.strength_defence_away),
      };
    })
    .filter((row): row is HistoricalTeamStrength => row !== null);
}

function normalizedName(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function mapHistoricalPlayers(currentPlayers: Player[], historicalPlayers: HistoricalPlayerRecord[]): PlayerMapping[] {
  const byCode = new Map(historicalPlayers.filter((player) => player.code !== undefined).map((player) => [player.code, player]));
  const byNameTeam = new Map(historicalPlayers.map((player) => [`${normalizedName(player.displayName)}:${normalizedName(player.teamName ?? "")}`, player]));
  return currentPlayers.map((current) => {
    const exact = current.code === undefined ? undefined : byCode.get(current.code);
    if (exact) return { currentPlayerId: current.id, historicalPlayerId: exact.historicalPlayerId, confidence: "EXACT" };
    const likely = byNameTeam.get(`${normalizedName(current.displayName)}:${normalizedName(current.teamName)}`);
    return likely
      ? { currentPlayerId: current.id, historicalPlayerId: likely.historicalPlayerId, confidence: "LIKELY" }
      : { currentPlayerId: current.id, confidence: "UNRESOLVED" };
  });
}

async function download(url: string): Promise<string> {
  const response = await fetch(url, { headers: { Accept: "text/plain" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Historical source returned HTTP ${response.status}: ${url}`);
  return response.text();
}

export interface IngestOptions {
  outputDir?: string;
  seasonPath?: string;
  season?: string;
  includeCurrentMappings?: boolean;
}

export async function ingestHistoricalData(options: IngestOptions = {}): Promise<{
  players: number;
  matchStats: number;
  mappings: number;
  currentDataAvailable: boolean;
}> {
  const seasonPath = options.seasonPath ?? HISTORICAL_REPOSITORY;
  const season = options.season ?? HISTORICAL_SEASON;
  const outputDir = options.outputDir ?? path.join(process.cwd(), "data", "generated");
  const [merged, playersRaw, teams] = await Promise.all([
    download(`${seasonPath}/gws/merged_gw.csv`),
    download(`${seasonPath}/players_raw.csv`),
    download(`${seasonPath}/teams.csv`),
  ]);
  let currentDataAvailable = false;
  let currentPlayers: Player[] = [];
  if (options.includeCurrentMappings !== false) {
    try {
      const bootstrapResponse = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/", { cache: "no-store" });
      if (bootstrapResponse.ok) {
        const bootstrap = parseExternal(FplBootstrapSchema, await bootstrapResponse.json(), "bootstrap-static");
        currentPlayers = normalizeBootstrap(bootstrap).players;
        currentDataAvailable = true;
      }
    } catch {
      // Historical files remain useful without a live player universe; mappings stay empty.
    }
  }
  const historicalPlayers = aggregateHistoricalPlayers(merged, playersRaw, season);
  const matchStats = normalizeHistoricalMatchStats(merged);
  const teamStrength = normalizeTeamStrength(teams);
  const playerMappings = mapHistoricalPlayers(currentPlayers, historicalPlayers);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "historical-players.json"), JSON.stringify(historicalPlayers)),
    writeFile(path.join(outputDir, "historical-match-stats.json"), JSON.stringify(matchStats)),
    writeFile(path.join(outputDir, "team-strength.json"), JSON.stringify(teamStrength)),
    writeFile(path.join(outputDir, "player-mappings.json"), JSON.stringify(playerMappings)),
  ]);
  return { players: historicalPlayers.length, matchStats: matchStats.length, mappings: playerMappings.length, currentDataAvailable };
}
