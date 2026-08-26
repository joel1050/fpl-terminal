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

export interface RotowireSelectionSource {
  snapshot?: { fetchedAt?: string } | null;
  mappings: readonly RotowireMappedRecord[];
}

export interface PlayerSelectionOptions {
  rotowire?: RotowireSelectionSource | null;
  historical?: Pick<HistoricalBundle, "players" | "matchStats" | "playerMappings" | "generatedAt"> | null;
  historicalMatchStats?: readonly HistoricalMatchStat[];
  historicalStats?: ReadonlyMap<number, HistoricalStats> | Readonly<Record<number, HistoricalStats>>;
  updatedAt?: string;
}

interface HistoricalSignal {
  stats?: HistoricalStats;
  matches: number;
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

function historicalSignal(
  player: Player,
  options: PlayerSelectionOptions,
  historicalId: number | undefined,
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
  const startRate = sample > 0 ? clamp(starts / sample, 0, 1) : 0;
  const cameoRate = sample > 0 ? clamp(Math.max(0, appearances - starts) / sample, 0, 1 - startRate) : 0;
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
    matches: sample,
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
  // player.status is always FPL's short code (i, d, s, u, n, ...), never
  // descriptive text, so a text-pattern fallback here can never fire against
  // real data.
  const status = player.status.trim().toLowerCase();
  const unavailable = ["i", "u", "n", "s"].includes(status);
  const chance = typeof player.chanceOfPlaying === "number" ? clamp(player.chanceOfPlaying, 0, 100) / 100 : undefined;
  let factor = 1;
  if (unavailable) {
    factor = 0.01;
    if (chance !== undefined) factor *= chance;
  } else if (status === "d") {
    // chanceOfPlaying is already FPL's specific estimate for this doubtful
    // player; use it directly rather than stacking a generic discount on
    // top of an already-specific number. Fall back to a flat discount only
    // when FPL hasn't supplied a percentage for this player.
    factor = chance ?? 0.7;
  }
  return { factor: clamp(factor, 0, 1), unavailable };
}

/**
 * How far a doubtful flag may pull down a player RotoWire still names in the
 * XI. A predicted lineup is published after the injury news and already prices
 * it in, so the two signals are not independent evidence. These floors keep a
 * named starter above the "probably rotated" band without ignoring the doubt:
 * a predicted starter on FPL's 75% flag settles near 0.62 rather than 0.67
 * unchecked or 0.43 with both discounts stacked.
 *
 * A confirmed lineup is a team sheet, not a forecast, so it holds a higher
 * floor. Neither floor applies when FPL rules the player out entirely - that
 * path returns above, before any of this.
 */
const ROTOWIRE_PREDICTED_FLOOR = 0.62;
const ROTOWIRE_CONFIRMED_FLOOR = 0.8;

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
  if (history.matches > 0) {
    evidence.push({ source: "HISTORICAL_STARTS", detail: `${history.starts} starts across ${history.matches} historical matches` });
  }
  if (player.current.minutes > 0) {
    evidence.push({ source: "CURRENT_SEASON", detail: `${player.current.minutes} current-season minutes` });
  }
  const status = player.chanceOfPlaying === null || player.chanceOfPlaying === undefined
    ? player.status
    : `${player.status}, ${player.chanceOfPlaying}% chance`;
  evidence.push({ source: "FPL_STATUS", detail: `FPL status: ${status}` });
  if (player.news) {
    evidence.push({ source: "FPL_STATUS", detail: `FPL news: ${player.news}` });
  }
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
  const coveredTeams = rotowireCoveredTeams(options.rotowire, players);
  const updatedAt = options.updatedAt ?? options.rotowire?.snapshot?.fetchedAt ?? options.historical?.generatedAt ?? "";
  return new Map(players.map((player) => {
    const history = historicalSignal(player, options, mappings.get(player.id));
    const signal = rwSignals.get(player.id);
    const historicalStart = history.matches > 0 ? history.startRate : fallbackStartRate(player);
    const historicalCameo = history.matches > 0 ? history.cameoRate : fallbackCameoRate(player);
    let start = historicalStart * 0.75 + fallbackStartRate(player) * 0.25;
    let cameo = historicalCameo * 0.75 + fallbackCameoRate(player) * 0.25;
    const teamCovered = coveredTeams.has(player.teamId);
    if (teamCovered) {
      const rotowireStart = signal?.starter ? (signal.confirmed ? 0.96 : 0.9) : 0.1;
      const rotowireCameo = signal?.starter ? 0.05 : 0.12;
      start = rotowireStart * 0.75 + historicalStart * 0.25;
      cameo = rotowireCameo * 0.75 + historicalCameo * 0.25;
    }
    const official = officialAvailability(player);
    // RotoWire OUT and SUS are rulings, not doubts, and gate as hard as FPL's
    // own unavailable codes. Only QUES is soft enough to trade off below.
    const rotowireRulesOut = signal?.availability === "OUT" || signal?.availability === "SUS";
    if (official.unavailable || rotowireRulesOut) {
      // The hard gate, and the one place a predicted XI never wins. A lineup is
      // a forecast made before the news: on a recent snapshot, 53 of 310
      // RotoWire starters were players FPL had already ruled out with a 0%
      // chance of playing. Whatever the lineup says, they do not play.
      start = Math.min(start, 0.01);
      cameo = Math.min(cameo, 0.01);
    } else {
      // RotoWire's QUES flag and FPL's doubtful status are usually the same
      // injury reported twice. Multiplying both discounts counted one knock as
      // two: a predicted starter carrying both landed near 0.43, which reads as
      // a rotation risk rather than the likely starter RotoWire called him.
      // Take the single most severe discount instead of the product.
      const rotowireFactor = signal?.availability === "QUES" ? { start: 0.65, cameo: 0.75 } : undefined;
      const startFactor = Math.min(rotowireFactor?.start ?? 1, official.factor);
      const cameoFactor = Math.min(rotowireFactor?.cameo ?? 1, official.factor);
      if (signal?.starter) {
        // RotoWire published a lineup after the news and still picked him. That
        // is the later and more specific judgement, so let it set a floor
        // rather than being multiplied away by the more general one.
        const floor = signal.confirmed ? ROTOWIRE_CONFIRMED_FLOOR : ROTOWIRE_PREDICTED_FLOOR;
        start = Math.max(start * startFactor, Math.min(start, floor));
        cameo *= cameoFactor;
      } else {
        start *= startFactor;
        cameo *= cameoFactor;
      }
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
