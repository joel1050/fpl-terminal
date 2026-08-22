import type {
  HistoricalStats,
  NailedRating,
  Player,
  PlayerSelection,
  ProjectionConfidence,
  SelectionEvidence,
} from "@/types/player";
import type { HistoricalBundle, HistoricalMatchStat } from "@/lib/historical/types";
import type { RotowireMappedRecord } from "./rotowireMapping";
import { groupCurrentMatchStats, type CurrentMatchStat } from "./currentMatchStats";

export interface RotowireSelectionSource {
  snapshot?: { fetchedAt?: string } | null;
  mappings: readonly RotowireMappedRecord[];
}

export interface PlayerSelectionOptions {
  rotowire?: RotowireSelectionSource | null;
  historical?: Pick<HistoricalBundle, "players" | "matchStats" | "playerMappings" | "generatedAt"> | null;
  historicalMatchStats?: readonly HistoricalMatchStat[];
  historicalStats?: ReadonlyMap<number, HistoricalStats> | Readonly<Record<number, HistoricalStats>>;
  /** This season's completed matches, keyed by current player id. */
  currentMatchStats?: readonly CurrentMatchStat[];
  updatedAt?: string;
}

interface HistoricalSignal {
  stats?: HistoricalStats;
  /** Every match behind the estimate, this season and last. */
  matches: number;
  historicalMatches: number;
  currentMatches: number;
  appearances: number;
  starts: number;
  startRate: number;
  cameoRate: number;
  startMinutes?: number;
  cameoMinutes?: number;
}

interface RotowireSignal {
  starter: boolean;
  confirmed: boolean;
  availability?: "QUES" | "OUT" | "SUS";
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/**
 * A match this season counts half as much as the one four matches later. Team
 * selection is a decision somebody makes each week, so recent matches say more
 * about a player's role than old ones do. Production rates behave the other way
 * round and stay on a flat average in the projection model.
 */
const ROLE_HALF_LIFE_MATCHES = 4;
/**
 * Last season enters as a flat rate worth a match and a half, not as a decayed
 * tail. Decaying across the summer would rest a player's whole role on the
 * run-in, and the run-in is no more predictive than any other stretch.
 *
 * The anchor steadies a short current-season sample and then fades on its own,
 * because this season's weight grows toward six matches: it holds about three
 * quarters of the estimate in August, a quarter by October and a fifth by
 * midwinter. Anything from 1.5 to 3 measured the same on 2025/26, so the low
 * end is chosen: that backtest has no summer in it, and a transfer window can
 * only make last season count for less.
 */
const PREVIOUS_SEASON_ANCHOR_MATCHES = 1.5;
/** A match's worth of prior, so two starts in a row do not read as certainty. */
const ROLE_PRIOR_MATCHES = 1;
const ROLE_PRIOR_START_RATE = 0.35;
const ROLE_PRIOR_CAMEO_RATE = 0.15;

const START_MINUTES: Record<Player["position"], number> = { GK: 90, DEF: 84, MID: 79, FWD: 78 };
const CAMEO_MINUTES: Record<Player["position"], number> = { GK: 5, DEF: 14, MID: 20, FWD: 20 };

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function mapValue<T>(map: ReadonlyMap<number, T> | Readonly<Record<number, T>> | undefined, key: number): T | undefined {
  if (!map) return undefined;
  return typeof (map as ReadonlyMap<number, T>).get === "function"
    ? (map as ReadonlyMap<number, T>).get(key)
    : (map as Readonly<Record<number, T>>)[key];
}

/**
 * Reads a role from this season's matches, weighted by how recent they are,
 * anchored on last season's flat rate and a small prior.
 */
function roleRates(
  currentRows: readonly CurrentMatchStat[],
  previousStartRate: number,
  previousCameoRate: number,
  previousMatches: number,
): { startRate: number; cameoRate: number } {
  const ordered = [...currentRows].sort((a, b) => b.gameweek - a.gameweek);
  let weight = 0;
  let starts = 0;
  let cameos = 0;
  ordered.forEach((row, index) => {
    const share = Math.pow(0.5, index / ROLE_HALF_LIFE_MATCHES);
    weight += share;
    if (row.minutes >= 60) starts += share;
    else if (row.minutes > 0) cameos += share;
  });
  const anchor = previousMatches > 0
    ? Math.min(PREVIOUS_SEASON_ANCHOR_MATCHES, previousMatches)
    : 0;
  const total = weight + anchor + ROLE_PRIOR_MATCHES;
  const startRate = clamp(
    (starts + anchor * previousStartRate + ROLE_PRIOR_MATCHES * ROLE_PRIOR_START_RATE) / total,
    0,
    1,
  );
  const cameoRate = clamp(
    (cameos + anchor * previousCameoRate + ROLE_PRIOR_MATCHES * ROLE_PRIOR_CAMEO_RATE) / total,
    0,
    1 - startRate,
  );
  return { startRate, cameoRate };
}

function historicalSignal(
  player: Player,
  options: PlayerSelectionOptions,
  historicalId: number | undefined,
  currentRows: readonly CurrentMatchStat[],
): HistoricalSignal {
  const stats = mapValue(options.historicalStats, player.id) ??
    (historicalId === undefined ? undefined : options.historical?.players.find((item) => item.historicalPlayerId === historicalId)?.stats);
  const rows = (options.historicalMatchStats ?? options.historical?.matchStats ?? [])
    .filter((row) => historicalId !== undefined && row.historicalPlayerId === historicalId);
  const matches = rows.length;
  const appearances = rows.filter((row) => row.minutes > 0).length;
  const starts = finite(stats?.starts)
    ? Math.max(0, stats.starts)
    : rows.filter((row) => row.minutes >= 60).length;
  const sample = Math.max(matches, starts, stats?.minutes ? Math.ceil(stats.minutes / 90) : 0);
  const previousStartRate = sample > 0 ? clamp(starts / sample, 0, 1) : 0;
  const previousCameoRate = sample > 0
    ? clamp(Math.max(0, appearances - starts) / sample, 0, 1 - previousStartRate)
    : 0;
  const { startRate, cameoRate } = roleRates(currentRows, previousStartRate, previousCameoRate, sample);
  const appearanceMinutes = rows
    .filter((row) => row.minutes > 0)
    .map((row) => row.minutes)
    .sort((a, b) => b - a);
  const startCount = Math.min(appearanceMinutes.length, Math.round(starts));
  const startRows = appearanceMinutes.slice(0, startCount);
  const cameoRows = appearanceMinutes.slice(startCount);
  const average = (values: number[]): number | undefined => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;
  return {
    stats,
    matches: sample + currentRows.length,
    historicalMatches: sample,
    currentMatches: currentRows.length,
    appearances,
    starts,
    startRate,
    cameoRate,
    startMinutes: average(startRows),
    cameoMinutes: average(cameoRows),
  };
}

function fallbackStartRate(player: Player): number {
  if (player.current.minutes <= 0) return 0.15;
  return clamp(0.1 + player.current.minutes / 1800, 0.15, 0.8);
}

function fallbackCameoRate(player: Player): number {
  return player.current.minutes > 0 ? 0.12 : 0.08;
}

function rotowireSignals(source: RotowireSelectionSource | null | undefined): Map<number, RotowireSignal> {
  const signals = new Map<number, RotowireSignal>();
  for (const record of source?.mappings ?? []) {
    const signal = signals.get(record.playerId) ?? { starter: false, confirmed: false };
    if (record.source === "STARTER") {
      signal.starter = true;
      signal.confirmed ||= record.lineupStatus === "CONFIRMED";
    } else {
      const status = record.availabilityStatus?.toUpperCase();
      if (status === "OUT" || status === "SUS" || status === "QUES") {
        const priority = { QUES: 1, SUS: 2, OUT: 3 } as const;
        const current = signal.availability ? priority[signal.availability] : 0;
        if (priority[status] > current) signal.availability = status;
      }
    }
    signals.set(record.playerId, signal);
  }
  return signals;
}

function rotowireCoveredTeams(
  source: RotowireSelectionSource | null | undefined,
  players: readonly Player[],
): Set<number> {
  const playerTeams = new Map(players.map((player) => [player.id, player.teamId]));
  return new Set(
    (source?.mappings ?? [])
      .map((record) => playerTeams.get(record.playerId))
      .filter((teamId): teamId is number => teamId !== undefined),
  );
}

function officialAvailability(player: Player): { factor: number; unavailable: boolean } {
  const status = player.status.trim().toLowerCase();
  let factor = 1;
  const unavailable = ["i", "u", "n", "s"].includes(status) || /injur|suspend|unavail|out|red|not.?squad/.test(status);
  if (unavailable) factor = 0.01;
  else if (status === "d" || /doubt|knock|ill/.test(status)) factor = 0.7;
  if (typeof player.chanceOfPlaying === "number") factor *= clamp(player.chanceOfPlaying, 0, 100) / 100;
  return { factor: clamp(factor, 0, 1), unavailable };
}

function rating(startProbability: number): NailedRating {
  if (startProbability >= 0.85) return 5;
  if (startProbability >= 0.7) return 4;
  if (startProbability >= 0.45) return 3;
  if (startProbability >= 0.15) return 2;
  return 1;
}

function confidence(
  signal: RotowireSignal | undefined,
  teamCovered: boolean,
  history: HistoricalSignal,
  player: Player,
): ProjectionConfidence {
  if (signal || teamCovered || history.matches >= 10) return "HIGH";
  if (history.matches > 0 || player.current.minutes > 0 || (player.chanceOfPlaying !== null && player.chanceOfPlaying !== undefined)) return "MEDIUM";
  return "LOW";
}

function evidenceFor(
  player: Player,
  signal: RotowireSignal | undefined,
  teamCovered: boolean,
  history: HistoricalSignal,
): SelectionEvidence[] {
  const evidence: SelectionEvidence[] = [];
  if (signal?.starter) {
    evidence.push({ source: "ROTOWIRE_XI", detail: signal.confirmed ? "RotoWire confirmed starter" : "RotoWire predicted starter" });
  } else if (teamCovered) {
    evidence.push({ source: "ROTOWIRE_XI", detail: "Not in the RotoWire predicted XI" });
  }
  if (signal?.availability) {
    evidence.push({ source: "ROTOWIRE_AVAILABILITY", detail: `RotoWire availability: ${signal.availability}` });
  }
  if (history.historicalMatches > 0) {
    evidence.push({ source: "HISTORICAL_STARTS", detail: `${history.starts} starts across ${history.historicalMatches} matches last season` });
  }
  if (history.currentMatches > 0) {
    evidence.push({ source: "CURRENT_SEASON", detail: `${history.currentMatches} matches this season, recent ones weighted highest` });
  } else if (player.current.minutes > 0) {
    evidence.push({ source: "CURRENT_SEASON", detail: `${player.current.minutes} current-season minutes` });
  }
  const status = player.chanceOfPlaying === null || player.chanceOfPlaying === undefined
    ? player.status
    : `${player.status}, ${player.chanceOfPlaying}% chance`;
  evidence.push({ source: "FPL_STATUS", detail: `FPL status: ${status}` });
  return evidence;
}

function normalizeScenarios(start: number, cameo: number): Pick<PlayerSelection, "startProbability" | "cameoProbability" | "noAppearanceProbability"> {
  const total = start + cameo;
  if (total <= 1) {
    return {
      startProbability: rounded(clamp(start, 0, 1)),
      cameoProbability: rounded(clamp(cameo, 0, 1 - start)),
      noAppearanceProbability: rounded(clamp(1 - total, 0, 1)),
    };
  }
  return {
    startProbability: rounded(start / total),
    cameoProbability: rounded(cameo / total),
    noAppearanceProbability: 0,
  };
}

function adjustRounding(
  scenarios: Pick<PlayerSelection, "startProbability" | "cameoProbability" | "noAppearanceProbability">,
): Pick<PlayerSelection, "startProbability" | "cameoProbability" | "noAppearanceProbability"> {
  const noAppearanceProbability = rounded(clamp(1 - scenarios.startProbability - scenarios.cameoProbability, 0, 1));
  return { ...scenarios, noAppearanceProbability: rounded(noAppearanceProbability + (1 - scenarios.startProbability - scenarios.cameoProbability - noAppearanceProbability)) };
}

export function buildPlayerSelections(
  players: readonly Player[],
  options: PlayerSelectionOptions = {},
): Map<number, PlayerSelection> {
  const mappings = new Map((options.historical?.playerMappings ?? []).map((mapping) => [mapping.currentPlayerId, mapping.historicalPlayerId]));
  const rwSignals = rotowireSignals(options.rotowire);
  const currentByPlayer = groupCurrentMatchStats(options.currentMatchStats ?? []);
  const coveredTeams = rotowireCoveredTeams(options.rotowire, players);
  const updatedAt = options.updatedAt ?? options.rotowire?.snapshot?.fetchedAt ?? options.historical?.generatedAt ?? "";
  return new Map(players.map((player) => {
    const currentRows = currentByPlayer.get(player.id) ?? [];
    const history = historicalSignal(player, options, mappings.get(player.id), currentRows);
    const signal = rwSignals.get(player.id);
    // With real matches behind it the timeline stands on its own; the minutes
    // formula is only there for a player nobody has a match record for.
    const measured = history.matches > 0;
    const historicalStart = measured ? history.startRate : fallbackStartRate(player);
    const historicalCameo = measured ? history.cameoRate : fallbackCameoRate(player);
    let start = historicalStart;
    let cameo = historicalCameo;
    const teamCovered = coveredTeams.has(player.teamId);
    if (teamCovered) {
      const rotowireStart = signal?.starter ? (signal.confirmed ? 0.96 : 0.9) : 0.1;
      const rotowireCameo = signal?.starter ? 0.05 : 0.12;
      start = rotowireStart * 0.75 + historicalStart * 0.25;
      cameo = rotowireCameo * 0.75 + historicalCameo * 0.25;
    }
    if (signal?.availability) {
      start *= signal.availability === "QUES" ? 0.65 : 0.01;
      cameo *= signal.availability === "QUES" ? 0.75 : 0.01;
    }
    const official = officialAvailability(player);
    if (official.unavailable) {
      start = Math.min(start, 0.01);
      cameo = Math.min(cameo, 0.01);
    } else {
      start *= official.factor;
      cameo *= official.factor;
    }
    const scenarios = adjustRounding(normalizeScenarios(start, cameo));
    const expectedStartMinutes = rounded(clamp(history.startMinutes ?? START_MINUTES[player.position], 60, 90));
    const expectedCameoMinutes = rounded(clamp(history.cameoMinutes ?? CAMEO_MINUTES[player.position], 1, 45));
    const expectedMinutes = rounded(clamp(
      scenarios.startProbability * expectedStartMinutes + scenarios.cameoProbability * expectedCameoMinutes,
      0,
      90,
    ));
    return [player.id, {
      ...scenarios,
      expectedMinutes,
      expectedStartMinutes,
      expectedCameoMinutes,
      nailedRating: rating(scenarios.startProbability),
      confidence: confidence(signal, teamCovered, history, player),
      updatedAt,
      evidence: evidenceFor(player, signal, teamCovered, history),
    }];
  }));
}

export const buildSelections = buildPlayerSelections;
