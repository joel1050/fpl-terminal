"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { BottomTabBar } from "@/components/shell/BottomTabBar";
import { MoreSheet } from "@/components/shell/MoreSheet";
import { TopBar } from "@/components/shell/TopBar";
import { exportState, importState, resetTerminalState } from "@/components/shell/stateFile";
import type { NailedRating, Player, PlayerFixture, PlayerMatchPerformance, PlayerProfileData, PlayerSelection, Position, SelectionEvidence, SimulationResult, SingleTransferSuggestion, SquadState, TransferBaseline, WeeklyLineupPlan } from "@/types";
import { simulateChange as simulateSquadChange } from "@/lib/analysis/simulateChange";
import { effectiveBudgetTenths, explainIllegalSelection, maxSafePriceForPosition } from "@/lib/squad/budget";
import { CAPTAIN_BENCH_REASON, checkLineupMove, FORMATION_REASON } from "@/lib/squad/lineupMoves";
import { pickWeeklyTeam, projectWeeklyLineupHorizons, scoreLineupWithChip, weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import { ChipSelector, ChipStrategyPanel, usePlanningWeekFinance } from "@/components/terminal/ChipPanels";
import { availabilityOf, type Availability } from "@/lib/availability/status";
import { chipLabel } from "@/lib/chips/seasonPolicy";
import type { ChipKind } from "@/types/chips";
import type { OptimizerResult } from "@/lib/optimizer/optimizer";
import { projectPlayer, projectedPointsForGameweeks } from "@/lib/projections/projectPlayer";
import { valuePerMillion } from "@/lib/projections/metrics";
import { BREAKDOWN_COMPONENT_KEYS, gameweekBreakdown } from "@/lib/projections/breakdown";
import { cacheBootstrapData, peekBootstrapData, readBootstrapData } from "@/lib/fpl/browserBootstrapCache";
import {
  exportTerminalState,
  parseSavedStateResult,
  savedStateRefusalNotice,
  deriveStartingXI,
  useTerminalStore,
  type ApplyLineupInput,
  type DesktopPanel,
  type TerminalFilters,
  type TerminalMode,
  type SortKey,
} from "@/store/terminalStore";
import { PitchToken, captainMultiplier, pitchXp } from "@/components/terminal/squad/PitchToken";
import { PlayerActions } from "@/components/terminal/squad/PlayerActions";
import { SquadKpis } from "@/components/terminal/squad/SquadKpis";
import { SquadPitch } from "@/components/terminal/squad/SquadPitch";
import { SquadTable } from "@/components/terminal/squad/SquadTable";
import { AlertsSection } from "@/components/terminal/rail/AlertsSection";
import { CaptainSection } from "@/components/terminal/rail/CaptainSection";
import { DecisionRail, RailSection } from "@/components/terminal/rail/DecisionRail";
import { squadAlerts } from "@/lib/analysis/squadAlerts";
import { money, points } from "@/lib/display/format";
import { ColumnsMenu } from "@/components/terminal/players/ColumnsMenu";
import { PlayersTable, type TerminalPlayer } from "@/components/terminal/players/PlayersTable";
import { PlayerList, PlayerSortLine } from "@/components/terminal/players/PlayerList";
import { FilterSheet } from "@/components/terminal/players/FilterSheet";
import { ActiveFilters } from "@/components/terminal/players/ActiveFilters";
import { countActiveFilters } from "@/lib/display/filterCount";
import { expectedInvolvementPer90 } from "@/lib/analysis/expectedInvolvement";
import { universeWeekFor, type UniverseWeekMetrics } from "@/lib/analysis/universeWeek";
import { startChanceOf } from "@/lib/availability/startChance";

// The deadline formatter moved with the top bar; the Planner's tests still import it from here.
export { formatDeadlineCountdown } from "@/components/shell/deadline";

type UnknownRecord = Record<string, unknown>;
type DataState = "SYNCING" | "LIVE" | "SNAPSHOT" | "STALE" | "EMPTY" | "ERROR";

const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];
const DRAFT_XI_COUNTS: Record<Position, number> = { GK: 1, DEF: 3, MID: 4, FWD: 3 };
const DESKTOP_PANELS: DesktopPanel[] = ["market", "squad"];
const PANEL_LABELS: Record<DesktopPanel, string> = { market: "Player universe", squad: "Squad builder and analysis" };

type ResizeState = {
  panel: DesktopPanel;
  neighbor: DesktopPanel;
  direction: 1 | -1;
  startX: number;
  currentWidth: number;
  neighborWidth: number;
  availableWidth: number;
  ratios: Record<DesktopPanel, number>;
};

type Bootstrap = {
  players: TerminalPlayer[];
  gameweek: number | null;
  deadline: string | null;
  source: string | null;
  freshness: "LIVE" | "SNAPSHOT" | "STALE";
  fetchedAt: string | null;
};

export interface DataAgeAnchor {
  ageMs: number;
  receivedAt: number;
}

export function computeDataAgeMs(now: number, anchor: DataAgeAnchor | null, fetchedAt: string | null): number | null {
  if (anchor) return Math.max(0, anchor.ageMs + (now - anchor.receivedAt));
  if (!fetchedAt) return null;
  const parsed = Date.parse(fetchedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

export function formatDataAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 60) return "";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function objectOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function firstObject(...values: unknown[]): UnknownRecord {
  for (const value of values) {
    const record = objectOf(value);
    if (record) return record;
  }
  return {};
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function selectionConfidence(value: unknown): PlayerSelection["confidence"] {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized === "HIGH" ? "HIGH" : normalized === "MEDIUM" ? "MEDIUM" : "LOW";
}

/**
 * Reads a typed bank figure as integer tenths, or null when the text is not a
 * figure yet.
 *
 * Null is the important case. Typing "12.5" passes through "1" and "12", and a
 * person may clear the field first; committing on every keystroke would
 * rewrite the box under them and leave "" reading as zero. Null means the
 * draft stands and nothing is written.
 *
 * It accepts the shapes people actually write, ".8" and "12." among them.
 * Refusing those was worse than it sounds: the field falls back to the figure
 * it held before, so a refusal reads as the app changing the number to
 * something else rather than declining to take it.
 */
export function parseBankInput(text: string): number | null {
  const trimmed = text.trim().replace(/^£/, "");
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const pounds = Number(trimmed);
  if (!Number.isFinite(pounds) || pounds < 0) return null;
  const tenths = Math.round(pounds * 10);
  return Number.isSafeInteger(tenths) ? tenths : null;
}

/**
 * Nudges a bank figure by whole tenths, working from the text on screen so a
 * half-typed figure steps from what the typist can see rather than from the
 * last committed value. Text that is not a figure counts as nothing, and the
 * bank stops at zero.
 */
export function steppedBankText(text: string, deltaTenths: number): string {
  const current = parseBankInput(text) ?? 0;
  const next = Math.max(0, current + Math.trunc(deltaTenths));
  return (next / 10).toFixed(1);
}

function selectionSource(value: unknown): SelectionEvidence["source"] | undefined {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (normalized === "PREDICTED_XI" || normalized === "PREDICTEDXI" || normalized === "PREDICTED_STARTING_XI") return "PREDICTED_XI";
  if (normalized === "TEAM_NEWS" || normalized === "TEAMNEWS") return "TEAM_NEWS";
  if (normalized === "HISTORICAL_STARTS" || normalized === "HISTORICALSTARTS") return "HISTORICAL_STARTS";
  if (normalized === "CURRENT_SEASON" || normalized === "CURRENTSEASON") return "CURRENT_SEASON";
  if (normalized === "FPL_STATUS" || normalized === "FPLSTATUS") return "FPL_STATUS";
  return undefined;
}

function selectionEvidence(value: unknown): SelectionEvidence[] {
  return arrayOf(value).flatMap((item) => {
    const evidence = objectOf(item);
    const source = selectionSource(readField(evidence, "source", "type"));
    const detail = stringOf(readField(evidence, "detail", "description", "text"));
    return source && detail ? [{ source, detail }] : [];
  });
}

/** Parses the optional raw API selection block without letting malformed data break the terminal. */
export function parsePlayerSelection(value: unknown): PlayerSelection | undefined {
  const raw = objectOf(value);
  if (!raw) return undefined;
  const startRaw = numberOf(readField(raw, "startProbability", "start_probability", "pStart", "p_start"));
  const cameoRaw = numberOf(readField(raw, "cameoProbability", "cameo_probability", "pCameo", "p_cameo"));
  const noAppearanceRaw = numberOf(readField(raw, "noAppearanceProbability", "no_appearance_probability", "pNoAppearance", "p_no_appearance"));
  const expectedMinutesRaw = numberOf(readField(raw, "expectedMinutes", "expected_minutes"));
  const expectedStartMinutesRaw = numberOf(readField(raw, "expectedStartMinutes", "expected_start_minutes"));
  const expectedCameoMinutesRaw = numberOf(readField(raw, "expectedCameoMinutes", "expected_cameo_minutes"));
  const ratingRaw = numberOf(readField(raw, "nailedRating", "nailed_rating", "rating"));
  const evidence = selectionEvidence(readField(raw, "evidence", "evidenceLines", "evidence_lines"));
  const hasSignal = [startRaw, cameoRaw, noAppearanceRaw, expectedMinutesRaw, ratingRaw].some((item) => item !== undefined) || evidence.length > 0;
  if (!hasSignal) return undefined;
  const startProbability = clamp(startRaw ?? 0, 0, 1);
  const cameoProbability = clamp(cameoRaw ?? 0, 0, 1);
  const noAppearanceProbability = clamp(noAppearanceRaw ?? (1 - startProbability - cameoProbability), 0, 1);
  const nailedRating = clamp(Math.round(ratingRaw ?? 1), 1, 5) as NailedRating;
  return {
    startProbability,
    cameoProbability,
    noAppearanceProbability,
    expectedMinutes: clamp(expectedMinutesRaw ?? 0, 0, 90),
    expectedStartMinutes: expectedStartMinutesRaw === undefined ? undefined : clamp(expectedStartMinutesRaw, 60, 90),
    expectedCameoMinutes: expectedCameoMinutesRaw === undefined ? undefined : clamp(expectedCameoMinutesRaw, 1, 45),
    nailedRating,
    confidence: selectionConfidence(readField(raw, "confidence")),
    updatedAt: stringOf(readField(raw, "updatedAt", "updated_at", "generatedAt", "generated_at")) ?? "",
    evidence,
  };
}

function readField(record: UnknownRecord | null | undefined, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
}

/**
 * The packed points breakdown is positional, so a list of the wrong length has
 * no safe reading: the values would be attributed to the wrong rows. Anything
 * but a full list of numbers is dropped rather than padded.
 */
function normalizePackedComponents(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== BREAKDOWN_COMPONENT_KEYS.length) return undefined;
  const packed = value.map((entry) => numberOf(entry));
  return packed.every((entry): entry is number => entry !== undefined) ? packed : undefined;
}

/** One fixture row, from a player, a team schedule, or a projection entry. */
function normalizeFixtureRow(value: unknown): PlayerFixture | null {
  const fixture = objectOf(value);
  const gameweek = numberOf(readField(fixture, "gameweek", "event"));
  const opponentTeamId = numberOf(readField(fixture, "opponentTeamId", "opponent_team_id"));
  const opponentShortName = stringOf(readField(fixture, "opponentShortName", "opponent_short_name"));
  const isHome = readField(fixture, "isHome", "is_home");
  if (gameweek === undefined || opponentTeamId === undefined || !opponentShortName || typeof isHome !== "boolean") return null;
  return {
    fixtureId: numberOf(readField(fixture, "fixtureId", "fixture_id", "id")),
    gameweek,
    opponentTeamId,
    opponentShortName,
    isHome,
    difficulty: numberOf(readField(fixture, "difficulty")),
  };
}

/**
 * The season's fixtures per team id. The bootstrap ships one schedule per team
 * rather than a copy per player, and every player on a team reads the same rows
 * back out of here.
 */
function parseTeamFixtures(value: unknown): Map<number, PlayerFixture[]> {
  const record = objectOf(value);
  const schedules = new Map<number, PlayerFixture[]>();
  if (!record) return schedules;
  for (const [key, rows] of Object.entries(record)) {
    const teamId = numberOf(key);
    if (teamId === undefined) continue;
    schedules.set(teamId, arrayOf(rows).flatMap((row) => normalizeFixtureRow(row) ?? []));
  }
  return schedules;
}

/**
 * Puts each projection entry back beside its fixture.
 *
 * The entry carries a `fixtureId` and the numbers; the opponent comes from the
 * team's schedule. Matching by id rather than by gameweek is what keeps a
 * double gameweek's two entries on the right fixtures. An older payload that
 * still embeds `fixture` is read as it stands.
 *
 * An entry whose fixture cannot be found keeps its points: the expected points
 * drive the squad's weekly total, while the fixture only labels the row.
 */
function normalizeProjectionFixtures(
  value: unknown,
  schedule: readonly PlayerFixture[] = [],
): NonNullable<Player["projection"]>["fixtures"] {
  const byFixtureId = new Map(schedule.flatMap((row) => (row.fixtureId === undefined ? [] : [[row.fixtureId, row] as const])));
  return arrayOf(value).flatMap((item) => {
    const projection = objectOf(item);
    const embedded = normalizeFixtureRow(readField(projection, "fixture"));
    const gameweek = numberOf(readField(projection, "gameweek", "event")) ?? embedded?.gameweek;
    const expectedPoints = numberOf(readField(projection, "expectedPoints", "expected_points"));
    const expectedMinutes = numberOf(readField(projection, "expectedMinutes", "expected_minutes"));
    if (gameweek === undefined || expectedPoints === undefined || expectedMinutes === undefined) return [];
    const fixtureId = numberOf(readField(projection, "fixtureId", "fixture_id"));
    const matched = embedded
      ?? (fixtureId === undefined ? undefined : byFixtureId.get(fixtureId))
      ?? schedule.find((row) => row.gameweek === gameweek);
    return [{
      gameweek,
      expectedPoints,
      expectedMinutes,
      fixture: matched ?? { gameweek, opponentTeamId: 0, opponentShortName: "—", isHome: false },
      packedComponents: normalizePackedComponents(readField(projection, "packedComponents", "packed_components")),
    }];
  });
}

function normalizePlayer(
  value: unknown,
  index: number,
  teamFixtures: Map<number, PlayerFixture[]> = new Map(),
): TerminalPlayer | null {
  const raw = objectOf(value);
  if (!raw) return null;
  const id = numberOf(readField(raw, "id", "playerId"));
  if (id === undefined) return null;
  const firstName = stringOf(readField(raw, "firstName", "first_name")) ?? "";
  const lastName = stringOf(readField(raw, "lastName", "second_name", "last_name")) ?? `Player ${index + 1}`;
  const displayName = stringOf(readField(raw, "displayName", "web_name", "name")) ?? `${firstName} ${lastName}`.trim();
  const team = objectOf(readField(raw, "team"));
  const positionRaw = String(readField(raw, "position", "element_type", "positionCode") ?? "").toUpperCase();
  const position: Position = positionRaw === "1" || positionRaw === "GK" || positionRaw === "GKP" ? "GK"
    : positionRaw === "2" || positionRaw === "DEF" || positionRaw === "DEFENDER" ? "DEF"
      : positionRaw === "3" || positionRaw === "MID" || positionRaw === "MIDFIELDER" ? "MID" : "FWD";
  const priceTenthsField = numberOf(readField(raw, "priceTenths"));
  const nowCostField = numberOf(readField(raw, "now_cost"));
  const priceField = numberOf(readField(raw, "price"));
  const priceTenths = priceTenthsField ?? nowCostField ?? (priceField === undefined ? 0 : priceField > 100 ? priceField : Math.round(priceField * 10));
  const currentRaw = firstObject(readField(raw, "current"), raw);
  const historical = objectOf(readField(raw, "historical")) ?? undefined;
  const selection = parsePlayerSelection(readField(raw, "selection"));
  const projectionRaw = firstObject(readField(raw, "projection"), readField(raw, "projections"));
  const teamId = numberOf(readField(raw, "teamId", "team", "team_id")) ?? numberOf(readField(team, "id")) ?? 0;
  const schedule = teamFixtures.get(teamId) ?? [];
  const projection = {
    playerId: id,
    fixtures: normalizeProjectionFixtures(readField(projectionRaw, "fixtures"), schedule),
    nextGW: numberOf(readField(projectionRaw, "nextGW", "next_gw", "gw1")) ?? numberOf(readField(raw, "nextGW", "expected_points_next")) ?? 0,
    next3: numberOf(readField(projectionRaw, "next3", "next_3")) ?? 0,
    next5: numberOf(readField(projectionRaw, "next5", "next_5")) ?? 0,
    next10: numberOf(readField(projectionRaw, "next10", "next_10")) ?? 0,
    expectedMinutes: numberOf(readField(projectionRaw, "expectedMinutes", "expected_minutes")) ?? 0,
    valueNext5: numberOf(readField(projectionRaw, "valueNext5", "value_next_5", "value")) ?? 0,
    riskScore: numberOf(readField(projectionRaw, "riskScore", "risk_score", "risk")) ?? 0,
    confidence: (String(readField(projectionRaw, "confidence") ?? "LOW").toUpperCase() === "HIGH" ? "HIGH" : String(readField(projectionRaw, "confidence") ?? "").toUpperCase() === "MEDIUM" ? "MEDIUM" : "LOW") as "HIGH" | "MEDIUM" | "LOW",
    factors: [],
  };
  // The bootstrap sends the schedule once per team; an older payload, a saved
  // squad or a test fixture may still carry a copy on the player.
  const own = arrayOf(readField(raw, "fixtures")).flatMap((value) => normalizeFixtureRow(value) ?? []);
  const fixtures: PlayerFixture[] = own.length ? own : [...schedule];
  return {
    id,
    firstName,
    lastName,
    displayName,
    teamId,
    teamName: stringOf(readField(raw, "teamName", "team_name")) ?? stringOf(readField(team, "name")) ?? "—",
    teamShortName: stringOf(readField(raw, "teamShortName", "team_short_name", "team_code")) ?? stringOf(readField(team, "shortName", "short_name")) ?? "—",
    position,
    priceTenths,
    ownership: numberOf(readField(raw, "ownership", "selected_by_percent", "ownershipPercent")) ?? 0,
    status: stringOf(readField(raw, "status", "status_code")) ?? "a",
    news: stringOf(readField(raw, "news")),
    chanceOfPlaying: numberOf(readField(raw, "chanceOfPlaying", "chance_of_playing_next_round")),
    current: {
      totalPoints: numberOf(readField(currentRaw, "totalPoints", "total_points")) ?? 0,
      pointsPer90: numberOf(readField(currentRaw, "pointsPer90", "points_per_90")),
      form: numberOf(readField(currentRaw, "form")),
      goals: numberOf(readField(currentRaw, "goals", "goals_scored")) ?? 0,
      assists: numberOf(readField(currentRaw, "assists", "assists")) ?? 0,
      cleanSheets: numberOf(readField(currentRaw, "cleanSheets", "clean_sheets")) ?? 0,
      bonus: numberOf(readField(currentRaw, "bonus")) ?? 0,
      minutes: numberOf(readField(currentRaw, "minutes")) ?? 0,
      saves: numberOf(readField(currentRaw, "saves")),
      expectedGoals: numberOf(readField(currentRaw, "expectedGoals", "expected_goals", "xG")),
      expectedAssists: numberOf(readField(currentRaw, "expectedAssists", "expected_assists", "xA")),
      // Quoted as evidence under the xP breakdown rows they feed.
      expectedGoalsConceded: numberOf(readField(currentRaw, "expectedGoalsConceded", "expected_goals_conceded", "xGC")),
      goalsConceded: numberOf(readField(currentRaw, "goalsConceded", "goals_conceded")),
      defensiveContribution: numberOf(readField(currentRaw, "defensiveContribution", "defensive_contribution")),
      yellowCards: numberOf(readField(currentRaw, "yellowCards", "yellow_cards")),
    },
    historical: historical as Player["historical"],
    selection,
    fixtures,
    projection,
  };
}

export function normalizeBootstrap(value: unknown): Bootstrap {
  const root = firstObject(value);
  const data = firstObject(root.data, root.payload, root.bootstrap);
  const metadata = firstObject(root.metadata, data.metadata);
  const playersRaw = arrayOf(readField(root, "players", "elements"));
  const dataPlayers = arrayOf(readField(data, "players", "elements"));
  const teamFixtures = parseTeamFixtures(readField(data, "teamFixtures", "team_fixtures") ?? readField(root, "teamFixtures", "team_fixtures"));
  const players = (playersRaw.length ? playersRaw : dataPlayers)
    .map((player, index) => normalizePlayer(player, index, teamFixtures))
    .filter((player): player is TerminalPlayer => player !== null)
    .map((player) => ({ ...player, projection: player.projection && (player.projection.nextGW || player.projection.next3 || player.projection.next5 || player.projection.next10) ? player.projection : projectPlayer(player, { currentGameweek: 1, horizon: 5 }) }));
  const events = arrayOf(readField(root, "events", "event")).length ? arrayOf(readField(root, "events", "event")) : arrayOf(readField(data, "events", "event"));
  const currentEvent = events.map(objectOf).find((event): event is UnknownRecord => Boolean(event && (event.isCurrent === true || event.is_current === true || event.isNext === true || event.is_next === true)));
  const gameweek = numberOf(readField(root, "gameweek", "currentGameweek", "current_gameweek")) ?? numberOf(readField(data, "gameweek", "currentGameweek", "current_gameweek")) ?? numberOf(readField(metadata, "currentGameweek", "current_gameweek", "gameweek")) ?? numberOf(currentEvent ? readField(currentEvent, "id", "event") : undefined) ?? null;
  const deadline = stringOf(readField(root, "deadline", "deadlineTime", "nextDeadline", "next_deadline")) ?? stringOf(readField(data, "deadline", "deadlineTime", "nextDeadline")) ?? stringOf(currentEvent ? readField(currentEvent, "deadlineTime", "deadline_time") : undefined) ?? null;
  return { players, gameweek, deadline, source: stringOf(readField(root, "source", "dataSource")) ?? stringOf(readField(data, "source")) ?? null, freshness: "LIVE", fetchedAt: null };
}

function confidenceOf(player: TerminalPlayer): TerminalFilters["confidence"] {
  const confidence = player.selection?.confidence ?? player.projection?.confidence;
  return confidence === "HIGH" || confidence === "MEDIUM" || confidence === "LOW" ? confidence : "LOW";
}

function riskBandOf(player: TerminalPlayer): Exclude<TerminalFilters["risk"], "ALL"> | undefined {
  const score = player.projection?.riskScore;
  if (score === undefined || !Number.isFinite(score)) return undefined;
  return score >= 60 ? "HIGH" : score >= 30 ? "MEDIUM" : "LOW";
}

function aggregateWeeklyProjection(players: readonly TerminalPlayer[], gameweek: number): { nextGW: number; next3: number; next5: number; next10: number } {
  const totals = Array.from({ length: 10 }, (_, index) => players.reduce((sum, player) => sum + weeklyPlayerMetrics(player, gameweek + index).points, 0));
  return {
    nextGW: totals[0] ?? 0,
    next3: totals.slice(0, 3).reduce((sum, value) => sum + value, 0),
    next5: totals.slice(0, 5).reduce((sum, value) => sum + value, 0),
    next10: totals.reduce((sum, value) => sum + value, 0),
  };
}

function formationLabel(plan: WeeklyLineupPlan): string {
  return plan.formation || "—";
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function classifyFreshness({ stale, source, errors = [] }: { stale?: unknown; source?: unknown; errors?: string[] }): Bootstrap["freshness"] {
  const staleFlag = booleanOf(stale) === true;
  const sourceText = typeof source === "string" ? source.toLowerCase() : "";
  if (staleFlag || errors.some((error) => /stale/i.test(error))) return "STALE";
  if (sourceText.includes("snapshot") || errors.some((error) => /snapshot/i.test(error))) return "SNAPSHOT";
  return "LIVE";
}

function useBootstrap() {
  const [refreshCount, setRefreshCount] = useState(0);
  const [state, setState] = useState<{ data: Bootstrap; status: DataState; message?: string; ageAnchor: DataAgeAnchor | null; refresh: () => void }>(() => {
    const cached = normalizeBootstrap(peekBootstrapData());
    return {
      data: cached.players.length ? { ...cached, freshness: "STALE" } : cached,
      status: cached.players.length ? "STALE" : "SYNCING",
      ageAnchor: null,
      refresh: () => setRefreshCount((value) => value + 1),
    };
  });
  useEffect(() => {
    const controller = new AbortController();
    let networkSettled = false;
    void readBootstrapData().then((cached) => {
      if (controller.signal.aborted || networkSettled) return;
      const data = normalizeBootstrap(cached);
      if (data.players.length) setState((current) => ({ ...current, data: { ...data, freshness: "STALE" }, status: "STALE" }));
    });
    fetch(`/api/fpl/bootstrap${refreshCount ? "?refresh=1" : ""}`, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`FPL sync returned ${response.status}`);
        const payload: unknown = await response.json();
        const root = firstObject(payload);
        const freshnessRoot = firstObject(root.freshness);
        const freshness = firstObject(freshnessRoot.bootstrap, freshnessRoot.fpl, freshnessRoot);
        const fetchedAt = stringOf(readField(freshness, "fetchedAt", "fetched_at", "updatedAt", "updated_at")) ?? null;
        const ageSeconds = numberOf(readField(freshness, "ageSeconds", "age_seconds"));
        const ageAnchor: DataAgeAnchor | null = ageSeconds !== undefined && ageSeconds >= 0 ? { ageMs: ageSeconds * 1000, receivedAt: Date.now() } : null;
        const normalized = normalizeBootstrap(payload);
        cacheBootstrapData(firstObject(payload).data ?? payload);
        const errors = arrayOf(root.errors).filter((error): error is string => typeof error === "string");
        const freshnessLabel = classifyFreshness({
          stale: readField(freshness, "stale", "isStale"),
          source: [stringOf(readField(freshness, "source", "dataSource")), normalized.source].filter(Boolean).join(" "),
          errors,
        });
        return { data: { ...normalized, freshness: freshnessLabel, fetchedAt }, errors, ageAnchor };
      })
      .then(({ data, errors, ageAnchor }) => {
        networkSettled = true;
        setState((current) => ({ ...current, data, status: data.players.length ? data.freshness : "EMPTY", message: errors[0] ?? (data.players.length ? undefined : "The FPL response contained no player records."), ageAnchor }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        networkSettled = true;
        setState((current) => ({ ...current, status: current.data.players.length ? "STALE" : "ERROR", message: error instanceof Error ? error.message : "FPL data is unavailable.", ageAnchor: null }));
      });
    return () => controller.abort();
  }, [refreshCount]);

  return state;
}

function usePlayerProfile(playerId: number) {
  const [state, setState] = useState<{ data?: PlayerProfileData; status: "LOADING" | "READY" | "ERROR"; message?: string }>({ status: "LOADING" });
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/fpl/player/${playerId}`, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        const body = await response.json() as { data?: PlayerProfileData | null; errors?: string[] };
        if (!response.ok || !body.data) throw new Error(body.errors?.[0] ?? "Player match history is unavailable.");
        return body.data;
      })
      .then((data) => setState({ data, status: "READY" }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "ERROR", message: error instanceof Error ? error.message : "Player match history is unavailable." });
      });
    return () => controller.abort();
  }, [playerId]);
  return state;
}

function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export default function TerminalApp() {
  const bootstrap = useBootstrap();
  const store = useTerminalStore();
  const [notice, setNoticeState] = useState<string | null>(null);
  const savedStateNotice = useTerminalStore((state) => state.savedStateNotice);
  const [noticeMinimized, setNoticeMinimized] = useState(false);

  const setNotice = useCallback((text: string | null) => {
    setNoticeState(text);
    if (text) setNoticeMinimized(false);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNoticeState(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [optimizing, setOptimizing] = useState(false);
  const [reverseBusy, setReverseBusy] = useState(false);
  const [transferSearch, setTransferSearch] = useState<{ key: string; suggestions: SingleTransferSuggestion[]; state: "READY" | "ERROR"; message: string | null }>({ key: "", suggestions: [], state: "READY", message: null });
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [simulationMoves, setSimulationMoves] = useState<Array<{ outId: number; inId: number; cashReleasedTenths?: number }> | null>(null);
  // The result sits over the squad column, which may be above the rail the user opened it from.
  const simulationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (simulation) simulationRef.current?.scrollIntoView({ block: "nearest" });
  }, [simulation]);
  const simulationMove = simulationMoves?.[0] ?? null;
  const [gwSwapSelection, setGWSwapSelection] = useState<{ starterId?: number; benchId?: number }>({});
  const [actionPlayerId, setActionPlayerId] = useState<number | null>(null);
  const isMobileLineup = useMatchMedia("(max-width: 900px)");
  // The token or table button that opened the action popover; it opens beside this element.
  const actionAnchor = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const [collapsedPanels, setCollapsedPanels] = useState<Record<DesktopPanel, boolean>>({ market: false, squad: false });
  const { data, status, message, refresh, ageAnchor } = bootstrap;
  const liveCurrentGW = clamp(Math.round(data.gameweek ?? store.currentGameweek ?? 1), 1, 38);
  const initializeGameweek = store.initializeGameweek;

  const togglePanel = (panel: DesktopPanel) => setCollapsedPanels((current) => ({ ...current, [panel]: !current[panel] }));

  const ratioPercent = (width: number, available: number) => Math.round((width / available) * 100);

  const beginPanelResize = (panel: DesktopPanel, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (window.innerWidth <= 900 || collapsedPanels[panel]) return;
    const handle = event.currentTarget;
    const section = handle.closest<HTMLElement>("[data-panel]");
    const grid = handle.closest<HTMLElement>(".terminal-grid");
    const panelIndex = DESKTOP_PANELS.indexOf(panel);
    const neighborIndex = panelIndex === DESKTOP_PANELS.length - 1 ? panelIndex - 1 : panelIndex + 1;
    const neighbor = DESKTOP_PANELS[neighborIndex];
    if (!section || !grid || !neighbor || collapsedPanels[neighbor]) return;
    const neighborSection = grid.querySelector<HTMLElement>(`[data-panel="${neighbor}"]`);
    if (!neighborSection) return;
    // Read the grid tracks, not the sections: at 901–1399px the squad section sits in a scrolling stack, and its scrollbar would narrow the box.
    const tracks = getComputedStyle(grid).gridTemplateColumns.split(" ").map((track) => parseFloat(track) || 0);
    const widths = DESKTOP_PANELS.map((_, index) => tracks[index] ?? 0);
    // The divider shares the market and squad tracks only. The rail is a third column and is not part of the split.
    const availableWidth = widths.reduce((sum, width) => sum + width, 0);
    if (availableWidth <= 0 || widths.some((width) => width <= 0)) return;
    const ratios = Object.fromEntries(DESKTOP_PANELS.map((name, index) => [name, ratioPercent(widths[index], availableWidth)])) as Record<DesktopPanel, number>;
    resizeRef.current = { panel, neighbor, direction: panelIndex === DESKTOP_PANELS.length - 1 ? -1 : 1, startX: event.clientX, currentWidth: widths[panelIndex], neighborWidth: widths[neighborIndex], availableWidth, ratios };
    useTerminalStore.getState().setPanelRatios(ratios);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.preventDefault();
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      const delta = clamp((event.clientX - resize.startX) * resize.direction, 260 - resize.currentWidth, resize.neighborWidth - 260);
      useTerminalStore.getState().setPanelRatios({ ...resize.ratios, [resize.panel]: ratioPercent(resize.currentWidth + delta, resize.availableWidth), [resize.neighbor]: ratioPercent(resize.neighborWidth - delta, resize.availableWidth) });
    };
    const onPointerUp = () => {
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => () => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    const raw = window.localStorage.getItem("fpl-terminal-state");
    const result = parseSavedStateResult(raw);
    useTerminalStore.getState().hydrate(
      result.status === "accepted" ? result.state : null,
      { persistenceBlocked: result.status === "refused", savedStateNotice: result.status === "refused" ? savedStateRefusalNotice(result) : null },
    );
  }, []);

  useEffect(() => {
    if (!store.isHydrated || data.gameweek === null) return;
    initializeGameweek(liveCurrentGW);
  }, [data.gameweek, initializeGameweek, liveCurrentGW, store.isHydrated]);

  useEffect(() => {
    const state = useTerminalStore.getState();
    if (!state.isHydrated || state.persistenceBlocked) return;
    window.localStorage.setItem("fpl-terminal-state", JSON.stringify(exportTerminalState(state)));
  }, [store.gameweekPlans, store.planningGameweek, store.currentGameweek, store.isHydrated, store.persistenceBlocked, store.mode, store.entryId, store.budgetTenths, store.playerIds, store.byPosition, store.benchGoalkeeperId, store.benchOrder, store.lineupGameweek, store.lineupProjectionFingerprint, store.lockedPlayerIds, store.captainId, store.viceCaptainId, store.horizon, store.transferHorizon, store.riskMode, store.benchStrategy, store.panelRatios, store.squadView, store.playerColumns, store.dismissedTransferKeys, store.chip, store.plannedTransfers, store.permanentSquad, store.transferBaseline, store.usedChips]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") store.setSelectedPlayer(undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  const planningGameweek = clamp(Math.round(store.planningGameweek ?? liveCurrentGW), liveCurrentGW, 38);
  const selected = useMemo(() => data.players.filter((player) => store.playerIds.includes(player.id)), [data.players, store.playerIds]);
  const playerById = useMemo(() => new Map(data.players.map((player) => [player.id, player])), [data.players]);
  const marketPriceById = useMemo(() => new Map(data.players.map((player) => [player.id, player.priceTenths])), [data.players]);
  const spent = useMemo(() => selected.reduce((sum, player) => sum + player.priceTenths, 0), [selected]);
  // The bank comes from the finance replay, which knows real purchase prices
  // and the official selling rule. It is null until a squad exists.
  const weekFinance = usePlanningWeekFinance(data.players, planningGameweek);
  const bankTenths = weekFinance?.bankTenths ?? store.budgetTenths - spent;
  const budgetForAdds = effectiveBudgetTenths(bankTenths, selected);
  const slotMaxPrices = useMemo(() => POSITIONS.reduce((result, position) => {
    result[position] = maxSafePriceForPosition(position, selected, data.players, { constraints: { budgetTenths: budgetForAdds } });
    return result;
  }, {} as Record<Position, number>), [data.players, selected, budgetForAdds]);
  const weeklyEnginePlan = useMemo(() => pickWeeklyTeam({
    squad: selected,
    gameweek: planningGameweek,
    riskMode: store.riskMode,
    chip: store.chip,
  }), [planningGameweek, selected, store.riskMode, store.chip]);
  const lineupApplied = store.lineupGameweek === planningGameweek && store.lineupProjectionFingerprint !== undefined;
  const currentGWPlan = useMemo<WeeklyLineupPlan | null>(() => {
    if (selected.length !== 15) return weeklyEnginePlan.starterIds.length === 11 ? weeklyEnginePlan : null;
    const saved = lineupApplied && store.benchGoalkeeperId !== undefined && store.benchOrder.length === 3 && store.captainId !== undefined && store.viceCaptainId !== undefined
      ? { starterIds: deriveStartingXI(store.playerIds, store.benchGoalkeeperId, store.benchOrder), benchGoalkeeperId: store.benchGoalkeeperId, benchOrder: store.benchOrder, captainId: store.captainId, viceCaptainId: store.viceCaptainId }
      : undefined;
    if (!saved) {
      return weeklyEnginePlan.starterIds.length === 11 ? weeklyEnginePlan : null;
    }
    const plan = scoreLineupWithChip(selected, planningGameweek, store.riskMode, store.chip, saved);
    return plan.starterIds.length === 11 ? plan : null;
  }, [selected, planningGameweek, store.riskMode, store.chip, lineupApplied, store.benchGoalkeeperId, store.benchOrder, store.captainId, store.playerIds, store.viceCaptainId, weeklyEnginePlan]);
  const lineupStale = lineupApplied && (store.lineupGameweek !== weeklyEnginePlan.gameweek || store.lineupProjectionFingerprint !== weeklyEnginePlan.projectionFingerprint);
  const chipNetXp = useMemo(() => {
    if (!currentGWPlan) return undefined;
    return currentGWPlan.projectedTotal;
  }, [currentGWPlan]);
  // Alerts follow the same lineup the pitch shows, so a benched player is listed with the bench slot the pitch shows.
  const planAlerts = useMemo(() => currentGWPlan
    ? squadAlerts({ squad: selected, starterIds: currentGWPlan.starterIds, benchOrder: [...currentGWPlan.benchOrder], benchGoalkeeperId: currentGWPlan.benchGoalkeeperId, gameweek: planningGameweek })
    : [], [currentGWPlan, planningGameweek, selected]);
  const projected = useMemo<{ nextGW?: number; next3?: number; next5?: number; next10?: number }>(() => {
    if (!selected.length) return {};
    if (weeklyEnginePlan.starterIds.length !== 11) return aggregateWeeklyProjection(selected, planningGameweek);
    return projectWeeklyLineupHorizons({
      squad: selected,
      gameweek: planningGameweek,
      riskMode: store.riskMode,
    }, !lineupStale ? currentGWPlan ?? undefined : undefined);
  }, [currentGWPlan, lineupStale, planningGameweek, selected, store.riskMode, weeklyEnginePlan.starterIds.length]);
  const bestXIKey = `${planningGameweek}|${store.budgetTenths}`;
  const [bestPossibleXI, setBestPossibleXI] = useState<{ key: string; projectedTotal: number } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/best-xi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ gameweek: planningGameweek, budgetTenths: store.budgetTenths }),
    }).then(async (response) => {
      const body = await response.json() as { projectedTotal?: number; error?: string };
      if (!response.ok || typeof body.projectedTotal !== "number" || !Number.isFinite(body.projectedTotal)) {
        throw new Error(body.error ?? "Best possible XI unavailable");
      }
      setBestPossibleXI({ key: bestXIKey, projectedTotal: body.projectedTotal });
    }).catch(() => {
      if (!controller.signal.aborted) setBestPossibleXI(null);
    });
    return () => controller.abort();
  }, [bestXIKey, planningGameweek, store.budgetTenths]);
  const teamRating = useMemo(() => {
    if (!currentGWPlan || currentGWPlan.starterIds.length !== 11) return undefined;
    if (!bestPossibleXI || bestPossibleXI.key !== bestXIKey || bestPossibleXI.projectedTotal <= 0) return undefined;
    const lineupXp = currentGWPlan.projectedXI + currentGWPlan.captainBonus;
    return clamp(Math.round(lineupXp / bestPossibleXI.projectedTotal * 100), 0, 100);
  }, [bestPossibleXI, bestXIKey, currentGWPlan]);
  const purchasePricesTenths = weekFinance?.purchasePricesTenths ?? store.transferBaseline?.purchasePricesTenths;
  const [bankedTransfersChoice, setBankedTransfersChoice] = useState<number | null>(null);
  const defaultBankedTransfers = clamp(weekFinance?.freeTransfersBefore ?? 1, 1, 5);
  const bankedTransfers = bankedTransfersChoice ?? defaultBankedTransfers;

  const purchaseLedgerKey = useMemo(() => {
    if (!purchasePricesTenths) return "";
    return Object.entries(purchasePricesTenths).sort(([a], [b]) => Number(a) - Number(b)).map(([k, v]) => `${k}:${v}`).join(",");
  }, [purchasePricesTenths]);

  const transferRequestKey = selected.length === 15
    ? `${store.playerIds.join(",")}|${store.lockedPlayerIds.join(",")}|${store.budgetTenths}|${bankTenths}|${purchaseLedgerKey}|${store.transferHorizon}|${store.riskMode}|${planningGameweek}|${bankedTransfers}`
    : "";
  useEffect(() => {
    if (!transferRequestKey) return;
    const controller = new AbortController();
    void fetch("/api/transfer-suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        squad: store.playerIds,
        lockedPlayerIds: store.lockedPlayerIds,
        budgetTenths: store.budgetTenths,
        bankTenths,
        purchasePricesTenths,
        horizon: store.transferHorizon,
        risk: store.riskMode,
        gameweek: planningGameweek,
        maxTransfers: bankedTransfers,
      }),
    }).then(async (response) => {
      const body = await response.json() as { suggestions?: SingleTransferSuggestion[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Exact transfer search failed");
      setTransferSearch({ key: transferRequestKey, suggestions: Array.isArray(body.suggestions) ? body.suggestions.slice(0, 5) : [], state: "READY", message: null });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setTransferSearch({ key: transferRequestKey, suggestions: [], state: "ERROR", message: error instanceof Error ? error.message : "Exact transfer search failed" });
    });
    return () => controller.abort();
  }, [planningGameweek, store.budgetTenths, bankTenths, purchasePricesTenths, store.transferHorizon, store.lockedPlayerIds, store.playerIds, store.riskMode, transferRequestKey, bankedTransfers]);
  const dismissedTransferKeys = new Set(store.dismissedTransferKeys);
  const transferSuggestions = transferRequestKey && transferSearch.key === transferRequestKey
    ? transferSearch.suggestions
        .filter((move) => {
          if (move.projectedDelta <= 0) return false;
          if (move.moves && move.moves.length > 0) {
            return !move.moves.some((m) => dismissedTransferKeys.has(`${m.outgoingPlayerId}:${m.incomingPlayerId}`));
          }
          return !dismissedTransferKeys.has(`${move.outgoingPlayerId}:${move.incomingPlayerId}`);
        })
        .sort((a, b) => b.projectedDelta - a.projectedDelta)
    : [];
  const transferSuggestionState: "INCOMPLETE" | "LOADING" | "READY" | "ERROR" = !transferRequestKey ? "INCOMPLETE" : transferSearch.key === transferRequestKey ? transferSearch.state : "LOADING";
  const transferSuggestionMessage = transferSearch.key === transferRequestKey ? transferSearch.message : null;

  const universeWeeks = useMemo(() => {
    const byId = new Map<number, UniverseWeekMetrics>();
    for (const player of data.players) byId.set(player.id, universeWeekFor(player, planningGameweek));
    return byId;
  }, [data.players, planningGameweek]);

  const inSquadIds = useMemo(() => new Set(store.playerIds), [store.playerIds]);
  const clubs = useMemo(() => [...new Set(data.players.map((player) => player.teamShortName).filter((club) => club !== "—"))].sort(), [data.players]);
  const activeFilterCount = countActiveFilters(store.filters);

  const filteredPlayers = useMemo(() => {
    const query = normalizeName(store.search);
    const filters = store.filters;
    const rows = data.players.filter((player) => {
      const queryMatch = !query || normalizeName(player.displayName).includes(query) || normalizeName(player.lastName).includes(query) || normalizeName(player.teamName).includes(query);
      const price = player.priceTenths / 10;
      const min = Number(filters.minPrice);
      const max = Number(filters.maxPrice);
      const minOwnership = Number(filters.minOwnership);
      const maxOwnership = Number(filters.maxOwnership);
      const quickMatch = filters.quick === "ALL"
        || (filters.quick === "PREMIUM" && price >= 9.5)
        || (filters.quick === "CHEAP" && price <= 5.5)
        || (filters.quick === "DIFFERENTIAL" && player.ownership < 10)
        || (filters.quick === "NAILED" && (player.selection?.nailedRating ?? 0) >= 4)
        || (filters.quick === "VALUE" && (universeWeeks.get(player.id)?.value ?? 0) >= 2.5);
      return queryMatch
        && (filters.position === "ALL" || player.position === filters.position)
        && (!filters.club || player.teamShortName.toLowerCase() === filters.club.toLowerCase())
        && (!filters.minPrice || price >= min)
        && (!filters.maxPrice || price <= max)
        && (!filters.minOwnership || player.ownership >= minOwnership)
        && (!filters.maxOwnership || player.ownership <= maxOwnership)
        && (filters.availability === "ALL" || availabilityOf(player) === filters.availability)
        && (filters.confidence === "ALL" || confidenceOf(player) === filters.confidence)
        && (filters.risk === "ALL" || riskBandOf(player) === filters.risk)
        && (!filters.affordableOnly || player.priceTenths <= bankTenths)
        && (!filters.excludeSelected || !store.playerIds.includes(player.id))
        && quickMatch;
    });
    return rows.sort((a, b) => {
      const week = (player: TerminalPlayer) => universeWeeks.get(player.id);
      const values: Record<SortKey, (player: TerminalPlayer) => number | string> = {
        name: (player) => player.displayName,
        price: (player) => player.priceTenths,
        nextGW: (player) => week(player)?.xp ?? 0,
        form: (player) => player.current.form ?? 0,
        next3: (player) => week(player)?.next3 ?? 0,
        next5: (player) => week(player)?.next5 ?? 0,
        value: (player) => week(player)?.value ?? 0,
        next10: (player) => week(player)?.next10 ?? 0,
        value10: (player) => week(player)?.value10 ?? 0,
        xgi: (player) => expectedInvolvementPer90(player) ?? 0,
        start: (player) => startChanceOf(player) ?? 0,
        ownership: (player) => player.ownership,
      };
      const left = values[store.sortKey](a);
      const right = values[store.sortKey](b);
      const result = typeof left === "string" && typeof right === "string" ? left.localeCompare(right) : Number(left) - Number(right);
      return store.sortDirection === "asc" ? result : -result;
    });
  }, [bankTenths, data.players, store.filters, store.playerIds, store.search, store.sortDirection, store.sortKey, universeWeeks]);

  const addPlayer = useCallback((player: TerminalPlayer) => {
    const explanation = explainIllegalSelection(player, selected, data.players, { constraints: { budgetTenths: budgetForAdds } });
    if (!explanation.legal) {
      // A squad the manager already owns can cost more than a new entry's
      // budget, so a refusal about money needs to name the way through.
      const wayOut = explanation.reason !== "BUDGET" ? ""
        : store.entryId === undefined
          ? " If you already own this squad, import your team, or type your real bank into the ITB field."
          : " If your bank is wrong, correct it in the ITB field.";
      setNotice(`${explanation.message}${wayOut}`);
      return;
    }
    if (useTerminalStore.getState().addPlayer(player.id, player.position)) {
      useTerminalStore.getState().setSelectedPlayer(undefined);
      setNotice(`${player.displayName} added to ${player.position}.`);
    } else {
      setNotice(`No open ${player.position} slot, or the squad already contains this player.`);
    }
  }, [budgetForAdds, data.players, selected, setNotice, store.entryId]);

  const runOptimize = async (complete: boolean) => {
    if (!data.players.length) {
      setNotice("Optimization needs a live player universe.");
      return;
    }
    if (store.playerIds.length === 15 && store.playerIds.every((id) => store.lockedPlayerIds.includes(id))) {
      setNotice("Unlock players to get the optimized lineup.");
      return;
    }
    setOptimizing(true);
    setNotice("Running exact optimizer…");
    try {
      const response = await fetch("/api/optimizer", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          mode: complete ? "COMPLETE" : "OPTIMIZE",
          squad: store.playerIds,
          lockedPlayerIds: store.lockedPlayerIds,
          budgetTenths: store.budgetTenths,
          bankTenths: weekFinance?.bankTenths,
          purchasePricesTenths: weekFinance?.purchasePricesTenths,
          gameweek: planningGameweek,
          horizon: store.horizon,
          bench: store.benchStrategy,
        }),
      });
      const result = await response.json() as OptimizerResult & { error?: string };
      if (!response.ok || !result.legal || !result.squad) {
        setNotice(result.errors?.[0] ?? result.error ?? "No legal squad could be found with the current locks and budget.");
        return;
      }
      const applied = store.applyOptimizerResult({
        gameweek: planningGameweek,
        squad: result.squad,
      });
      setNotice(applied ? (complete ? "Exact optimizer completed the remaining squad." : "Exact optimizer applied the selected bench strategy.") : "The optimized squad could not be applied to the saved plans.");
    } catch {
      setNotice("Exact optimizer unavailable. Try again.");
    } finally {
      setOptimizing(false);
    }
  };

  const applyWeeklyPlan = (plan: WeeklyLineupPlan) => store.applyLineup({
    gameweek: plan.gameweek,
    lineupProjectionFingerprint: plan.projectionFingerprint,
    benchGoalkeeperId: plan.benchGoalkeeperId,
    benchOrder: [...plan.benchOrder],
    captainId: plan.captainId,
    viceCaptainId: plan.viceCaptainId,
  });

  const pickGWTeam = () => {
    if (weeklyEnginePlan.starterIds.length !== 11 || weeklyEnginePlan.benchOrder.length !== 3 || weeklyEnginePlan.benchGoalkeeperId === 0) {
      setNotice("Complete a legal 15-player squad before picking a team.");
      return;
    }
    const applied = applyWeeklyPlan(weeklyEnginePlan);
    if (!applied) {
      setNotice("The weekly pick failed the squad rules. Check the squad and try again.");
      return;
    }
    setGWSwapSelection({});
    setNotice("Team picked and saved for this Gameweek.");
  };

  const selectGWSwapPlayer = (role: "starter" | "bench", id: number) => {
    if (!currentGWPlan) {
      setNotice("Pick a team before changing starters and substitutes.");
      return;
    }
    if (!lineupApplied && !applyWeeklyPlan(currentGWPlan)) return;
    const nextSelection = role === "starter" ? { ...gwSwapSelection, starterId: id } : { ...gwSwapSelection, benchId: id };
    const starterId = nextSelection.starterId;
    const benchId = nextSelection.benchId;
    if (starterId === undefined || benchId === undefined) {
      setGWSwapSelection(nextSelection);
      setNotice(`Select a ${role === "starter" ? "substitute" : "starter"} to complete the swap.`);
      return;
    }
    swapGW(starterId, benchId);
  };

  /** Swap a starter with a bench player through the store, with a notice. Shared by tap and drag. */
  const swapGW = (starterId: number, benchId: number) => {
    if (currentGWPlan?.captainId === starterId || currentGWPlan?.viceCaptainId === starterId) {
      setNotice(CAPTAIN_BENCH_REASON);
      setGWSwapSelection({});
      return;
    }
    if (!store.swapStarterBench(starterId, benchId)) {
      setNotice(FORMATION_REASON);
      setGWSwapSelection({});
      return;
    }
    setGWSwapSelection({});
    setNotice(`${playerById.get(benchId)?.displayName ?? "Player"} moved into the starting XI.`);
  };

  const moveGWBench = (id: number, direction: -1 | 1) => {
    if (!currentGWPlan) return;
    const currentOrder = lineupApplied && store.benchOrder.length === 3 ? store.benchOrder : currentGWPlan.benchOrder;
    if (!lineupApplied && !applyWeeklyPlan(currentGWPlan)) return;
    const index = currentOrder.indexOf(id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= currentOrder.length) return;
    const bench = [...currentOrder];
    [bench[index], bench[nextIndex]] = [bench[nextIndex], bench[index]];
    if (store.reorderBench(bench)) setNotice("Bench order updated.");
  };

  /** Swap two outfield substitutes' places in the bench order. */
  const swapBenchPlaces = (aId: number, bId: number) => {
    if (!currentGWPlan) return;
    const currentOrder = lineupApplied && store.benchOrder.length === 3 ? store.benchOrder : currentGWPlan.benchOrder;
    const order = [...currentOrder];
    const a = order.indexOf(aId);
    const b = order.indexOf(bId);
    if (a < 0 || b < 0) return;
    if (!lineupApplied && !applyWeeklyPlan(currentGWPlan)) return;
    [order[a], order[b]] = [order[b], order[a]];
    if (store.reorderBench(order)) setNotice("Bench order updated.");
  };

  const dragLineup = currentGWPlan
    ? { starterIds: currentGWPlan.starterIds, benchGoalkeeperId: currentGWPlan.benchGoalkeeperId, benchOrder: currentGWPlan.benchOrder, captainId: currentGWPlan.captainId, viceCaptainId: currentGWPlan.viceCaptainId }
    : null;
  const positionOfPlayer = (id: number) => playerById.get(id)?.position;
  const pitchDrag = dragLineup ? {
    canDrop: (sourceId: number, targetId: number) => {
      const move = checkLineupMove(dragLineup, sourceId, targetId, positionOfPlayer);
      return { legal: move.legal, reason: move.legal ? null : move.reason };
    },
    onDrop: (sourceId: number, targetId: number) => {
      const move = checkLineupMove(dragLineup, sourceId, targetId, positionOfPlayer);
      if (!move.legal || !currentGWPlan) return;
      if (!lineupApplied && !applyWeeklyPlan(currentGWPlan)) return;
      if (move.kind === "swap") swapGW(move.starterId, move.benchId);
      else swapBenchPlaces(sourceId, targetId);
    },
    onReject: (reason: string) => setNotice(reason),
  } : undefined;

  const applyCaptaincy = (captainId: number, viceCaptainId: number) => {
    if (!currentGWPlan || captainId === viceCaptainId) return false;
    const applied = store.applyLineup({
      gameweek: lineupApplied ? store.lineupGameweek ?? currentGWPlan.gameweek : currentGWPlan.gameweek,
      lineupProjectionFingerprint: lineupApplied ? store.lineupProjectionFingerprint ?? currentGWPlan.projectionFingerprint : currentGWPlan.projectionFingerprint,
      benchGoalkeeperId: lineupApplied ? store.benchGoalkeeperId ?? currentGWPlan.benchGoalkeeperId : currentGWPlan.benchGoalkeeperId,
      benchOrder: lineupApplied && store.benchOrder.length === 3 ? [...store.benchOrder] : [...currentGWPlan.benchOrder],
      captainId,
      viceCaptainId,
    });
    if (applied) setNotice("Captaincy updated.");
    else setNotice("Captain and vice-captain must be different starters.");
    return applied;
  };

  const makeGWCaptain = (id: number) => {
    if (!currentGWPlan || currentGWPlan.viceCaptainId === 0) return;
    const viceCaptainId = currentGWPlan.viceCaptainId === id ? currentGWPlan.captainId : currentGWPlan.viceCaptainId;
    applyCaptaincy(id, viceCaptainId);
  };

  const makeGWViceCaptain = (id: number) => {
    if (!currentGWPlan || currentGWPlan.captainId === 0) return;
    const captainId = currentGWPlan.captainId === id ? currentGWPlan.viceCaptainId : currentGWPlan.captainId;
    applyCaptaincy(captainId, id);
  };

  const simulateSuggestion = (suggestion: SingleTransferSuggestion) => {
    const moves = suggestion.moves && suggestion.moves.length > 0
      ? suggestion.moves.map((m) => ({
          outId: m.outgoingPlayerId,
          inId: m.incomingPlayerId,
          cashReleasedTenths: m.cashReleasedTenths,
        }))
      : [{
          outId: suggestion.outgoingPlayerId,
          inId: suggestion.incomingPlayerId,
          cashReleasedTenths: suggestion.cashReleasedTenths,
        }];
    const result = simulateSquadChange({
      squad: store.playerIds,
      players: data.players,
      moves,
      gameweek: planningGameweek,
      horizon: store.transferHorizon,
      risk: store.riskMode,
      bench: store.benchStrategy,
      budgetTenths: store.budgetTenths,
      bankTenths,
      purchasePricesTenths,
    });
    setSimulationMoves(moves);
    setSimulation(result);
  };

  const simulateMove = (outId: number, inId: number) => {
    const moves = [{ outId, inId }];
    const result = simulateSquadChange({
      squad: store.playerIds,
      players: data.players,
      moves,
      gameweek: planningGameweek,
      horizon: store.transferHorizon,
      risk: store.riskMode,
      bench: store.benchStrategy,
      budgetTenths: store.budgetTenths,
      bankTenths,
      purchasePricesTenths,
    });
    setSimulationMoves(moves);
    setSimulation(result);
  };

  const dismissSuggestion = (suggestion: SingleTransferSuggestion) => {
    if (suggestion.moves && suggestion.moves.length > 0) {
      for (const m of suggestion.moves) {
        store.dismissTransferSuggestion(m.outgoingPlayerId, m.incomingPlayerId);
      }
    } else {
      store.dismissTransferSuggestion(suggestion.outgoingPlayerId, suggestion.incomingPlayerId);
    }
  };

  const applySimulation = () => {
    if (!simulationMoves || simulationMoves.length === 0) return;
    for (const move of simulationMoves) {
      if (store.lockedPlayerIds.includes(move.outId)) {
        setNotice("That move cannot be applied while an outgoing player is locked.");
        return;
      }
    }
    // Always execute cash-releasing transfers first so intermediate bank balance never blocks a transfer
    const sortedMoves = [...simulationMoves].sort((a, b) => (b.cashReleasedTenths ?? 0) - (a.cashReleasedTenths ?? 0));
    let appliedCount = 0;
    const descriptions: string[] = [];
    for (const move of sortedMoves) {
      const outgoing = playerById.get(move.outId);
      const incoming = playerById.get(move.inId);
      if (!incoming || !outgoing) continue;
      const ok = store.replacePlayer(move.outId, move.inId, incoming.position);
      if (ok) {
        appliedCount++;
        descriptions.push(`${outgoing.displayName} → ${incoming.displayName}`);
      }
    }
    if (appliedCount === 0) {
      setNotice("That transfer is no longer legal for the current squad.");
      return;
    }
    store.setSelectedPlayer(undefined);
    setSimulation(null);
    setSimulationMoves(null);
    setNotice(`${descriptions.join(", ")} applied.`);
  };

  const changePlanningGameweek = (target: number) => {
    const bounded = clamp(Math.round(target), liveCurrentGW, 38);
    if (bounded === planningGameweek) return;
    if (store.switchGameweek(bounded) === false) return;
    setGWSwapSelection({});
    setSimulation(null);
    setSimulationMoves(null);
  };

  const reverseAllChanges = async () => {
    const entryId = store.entryId;
    if (!entryId) {
      setNotice("Reverse all changes is available after importing an FPL team.");
      return;
    }
    if (!window.confirm(`Reverse all changes and restore the official Gameweek ${liveCurrentGW} squad?`)) return;
    setReverseBusy(true);
    try {
      const response = await fetch(`/api/fpl/entry/${entryId}?gameweek=${liveCurrentGW}`, { headers: { accept: "application/json" } });
      const body = await response.json() as { data?: ImportedTeam; errors?: string[] };
      if (!response.ok || !body.data?.squad || !body.data.lineup) throw new Error(body.errors?.[0] ?? "Official FPL squad restore failed.");
      const known = new Set(data.players.map((player) => player.id));
      if (body.data.squad.playerIds.some((playerId) => !known.has(playerId))) throw new Error("The official squad contains players missing from the current FPL player data. Refresh and try again.");
      const importedPlayers = data.players.filter((player) => body.data!.squad.playerIds.includes(player.id));
      const fingerprint = pickWeeklyTeam({ squad: importedPlayers, gameweek: liveCurrentGW, riskMode: store.riskMode, chip: body.data.chip ?? null }).projectionFingerprint;
      if (!fingerprint || !store.replaceSquad(body.data.squad, { ...body.data.lineup, lineupProjectionFingerprint: fingerprint }, entryId, body.data.budgetTenths, { transferBaseline: body.data.transferBaseline ?? null, usedChips: body.data.usedChips ?? [], chip: body.data.chip ?? null })) throw new Error("FPL returned an invalid 15-player squad.");
      store.switchGameweek(liveCurrentGW);
      setGWSwapSelection({});
      setSimulation(null);
      setSimulationMoves(null);
      setNotice(`Official Gameweek ${liveCurrentGW} squad restored. Future plans cleared.`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Official FPL squad restore failed.");
    } finally {
      setReverseBusy(false);
    }
  };

  const reset = () => {
    if (window.confirm("Reset the current squad and saved terminal state?")) {
      resetTerminalState(store);
      setNotice("Terminal state reset.");
    }
  };

  if (!store.isHydrated) return <main className="mode-screen" aria-busy="true" />;
  if (store.mode === null) {
    return <ModeChooser status={status} message={message} gameweek={data.gameweek} notice={savedStateNotice} onChoose={store.setMode} />;
  }
  if (store.mode === "ANALYZE" && !store.entryId) {
    return <TeamImportScreen
      players={data.players}
      gameweek={liveCurrentGW}
      notice={savedStateNotice}
      onBack={() => store.setMode(null)}
      onImport={(result) => {
        const importedPlayers = data.players.filter((player) => result.squad.playerIds.includes(player.id));
        const fingerprint = pickWeeklyTeam({ squad: importedPlayers, gameweek: result.lineup.gameweek, riskMode: store.riskMode, chip: result.chip ?? null }).projectionFingerprint;
        if (!store.replaceSquad(result.squad, { ...result.lineup, lineupProjectionFingerprint: fingerprint }, result.entryId, result.budgetTenths, { transferBaseline: result.transferBaseline ?? null, usedChips: result.usedChips ?? [], chip: result.chip ?? null })) return false;
        if (result.importWarnings?.length) setNotice(result.importWarnings[0]);
        else setNotice(`Imported ${result.teamName || result.managerName || `FPL team ${result.entryId}`}${result.chip ? ` (${chipLabel(result.chip)} active)` : ""}.`);
        return true;
      }}
    />;
  }

  const selectedPlayer = store.selectedPlayerId ? playerById.get(store.selectedPlayerId) : undefined;
  const gridStyle = Object.fromEntries(DESKTOP_PANELS.flatMap((panel) => {
    const value = collapsedPanels[panel] ? "52px" : store.panelRatios[panel] ? `${store.panelRatios[panel]}fr` : undefined;
    return value ? [[`--${panel}-column`, value]] : [];
  })) as CSSProperties;
  // Search is not a filter here: it stays in the search box, so resetting the filters leaves it alone.
  const resetFilters = () => {
    store.setFilters({ position: "ALL", club: "", minPrice: "", maxPrice: "", minOwnership: "", maxOwnership: "", availability: "ALL", confidence: "ALL", risk: "ALL", affordableOnly: false, excludeSelected: false, quick: "ALL" });
  };
  const openPlayer = (playerId: number) => {
    store.setMobileTab("MARKET");
    store.setSelectedPlayer(playerId);
  };
  const removeSquadPlayer = (player: TerminalPlayer) => {
    if (store.lockedPlayerIds.includes(player.id)) {
      setNotice(`${player.displayName} is locked. Unlock them before removing.`);
      return false;
    }
    return store.removePlayer(player.id);
  };
  // A pending swap holds one side; the next tap on the other side completes it from that side's sheet.
  const pendingStarterId = gwSwapSelection.starterId !== undefined && gwSwapSelection.benchId === undefined ? gwSwapSelection.starterId : undefined;
  const pendingBenchId = gwSwapSelection.benchId !== undefined && gwSwapSelection.starterId === undefined ? gwSwapSelection.benchId : undefined;
  /** Opens the action sheet. Rail and alert taps pass no element, so the pitch token or table button is looked up. */
  const openActions = (playerId: number, anchor?: HTMLElement) => {
    const name = playerById.get(playerId)?.displayName ?? "";
    actionAnchor.current = anchor
      ?? document.querySelector<HTMLElement>(`.pitch-token[data-player-id="${playerId}"]`)
      ?? Array.from(document.querySelectorAll<HTMLElement>('table[aria-label="Squad table"] tr[data-player] .sq-row-button')).find((button) => button.closest("tr")?.dataset.player === name)
      ?? null;
    setActionPlayerId(playerId);
  };
  const renderSquadPlayer = (player: Player, role: "starter" | "bench", benchLabel?: string) => <PitchToken
    key={player.id}
    player={player}
    gameweek={planningGameweek}
    role={role}
    benchLabel={benchLabel}
    captain={(lineupApplied ? store.captainId : currentGWPlan?.captainId) === player.id}
    vice={(lineupApplied ? store.viceCaptainId : currentGWPlan?.viceCaptainId) === player.id}
    locked={store.lockedPlayerIds.includes(player.id)}
    chip={store.chip}
    selected={actionPlayerId === player.id || gwSwapSelection.starterId === player.id || gwSwapSelection.benchId === player.id}
    swapTarget={Boolean(currentGWPlan) && (pendingStarterId !== undefined ? role === "bench" : pendingBenchId !== undefined && role === "starter")}
    showRun
    onOpen={(anchor) => openActions(player.id, anchor)}
    onToggleLock={() => store.toggleLock(player.id)}
  />;
  const choosePlayer = (position: Position) => {
    const maxPriceTenths = slotMaxPrices[position];
    store.setFilters({ position, maxPrice: (maxPriceTenths / 10).toFixed(1) });
    store.setMobileTab("MARKET");
    searchRef.current?.focus();
  };
  const draftBenchSlots: Array<{ id?: number; position: Position; label: string }> = [
    { id: store.byPosition.GK[1], position: "GK", label: "GK" },
    { id: store.byPosition.DEF[3], position: "DEF", label: "B1" },
    { id: store.byPosition.DEF[4], position: "DEF", label: "B2" },
    { id: store.byPosition.MID[4], position: "MID", label: "B3" },
  ];
  const benchSlots = currentGWPlan
    ? [currentGWPlan.benchGoalkeeperId, ...currentGWPlan.benchOrder].map((id, index) => ({ id, position: playerById.get(id)?.position ?? (index === 0 ? "GK" : "DEF"), label: index === 0 ? "GK" : `B${index}` } as const))
    : draftBenchSlots;
  const draftStarterCount = POSITIONS.reduce((sum, position) => sum + Math.min(store.byPosition[position].length, DRAFT_XI_COUNTS[position]), 0);
  const actionPlayer = actionPlayerId === null ? undefined : playerById.get(actionPlayerId);
  const actionBenchSlot = actionPlayer ? benchSlots.find((slot) => slot.id === actionPlayer.id) : undefined;
  const actionStarter = actionPlayer ? !actionBenchSlot && (currentGWPlan ? currentGWPlan.starterIds.includes(actionPlayer.id) : true) : false;
  const actionBenchIndex = actionPlayer ? (lineupApplied && store.benchOrder.length === 3 ? store.benchOrder : currentGWPlan?.benchOrder ?? []).indexOf(actionPlayer.id) : -1;
  const pendingSwapPlayer = playerById.get(pendingStarterId ?? pendingBenchId ?? -1);
  const swapHint = pendingSwapPlayer && currentGWPlan ? `Tap a ${pendingStarterId !== undefined ? "bench player" : "starter"} to swap with ${pendingSwapPlayer.displayName}` : undefined;
  const pitchRows = POSITIONS.map((position) => {
    const players = currentGWPlan
      ? currentGWPlan.starterIds.map((id) => playerById.get(id)).filter((player): player is TerminalPlayer => player?.position === position)
      : store.byPosition[position].slice(0, DRAFT_XI_COUNTS[position]).map((id) => playerById.get(id)).filter((player): player is TerminalPlayer => Boolean(player));
    return { position, players, slotCount: currentGWPlan ? players.length : DRAFT_XI_COUNTS[position] };
  });
  const pitchCaptain = playerById.get((lineupApplied ? store.captainId : currentGWPlan?.captainId) ?? -1);
  const captainCaption = pitchCaptain
    ? `Captain counts ${captainMultiplier(true, store.chip) === 3 ? "triple" : "double"}: ${pitchCaptain.displayName} ${points(pitchXp(pitchCaptain, planningGameweek, false))} → ${points(pitchXp(pitchCaptain, planningGameweek, true, store.chip))}`
    : undefined;
  const allSquadPlayersLocked = store.playerIds.length > 0 && store.playerIds.every((id) => store.lockedPlayerIds.includes(id));
  return (
    <main className="terminal-app">
      <TopBar
        planningGameweek={planningGameweek}
        liveGameweek={liveCurrentGW}
        onGameweek={changePlanningGameweek}
        deadline={data.deadline}
        statusSlot={<DataStatusCell status={status} ageAnchor={ageAnchor} fetchedAt={data.fetchedAt} />}
        onRefresh={refresh}
        more={<button type="button" aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen(true)}>More</button>}
      />
      <input ref={importRef} type="file" accept="application/json" hidden onChange={(event) => importState(event, store, setNotice)} />
      {savedStateNotice && <p className="live-notice" role="alert">{savedStateNotice}</p>}

      <div className="terminal-grid" style={gridStyle}>
        <section id="terminal-panel-market" data-panel="market" className={`market-column ${collapsedPanels.market ? "panel-collapsed" : ""} ${store.activeMobileTab === "MARKET" ? "mobile-visible" : ""}`} aria-label="Player universe">
          <div className="panel-header"><div><span className="panel-title">Players</span><span className="panel-count">{data.players.length || "—"} records</span></div><div className="header-actions"><ColumnsMenu columns={store.playerColumns} onChange={store.setPlayerColumns} />{status !== "LIVE" && <span className={`data-badge ${status.toLowerCase()}`}>{status === "SYNCING" ? "Syncing" : "No live data"}</span>}<PanelToggle panel="market" collapsed={collapsedPanels.market} onToggle={() => togglePanel("market")} /></div></div>
          <div className="market-filters">
            <div className="market-search-row">
              <div className="search-wrap"><span aria-hidden="true">/</span><input ref={searchRef} value={store.search} onChange={(event) => store.setSearch(event.target.value)} placeholder="Search player, club..." aria-label="Search players" /><kbd>/</kbd></div>
              <button ref={filtersButton} type="button" className="filters-button" aria-haspopup="dialog" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(true)}>Filters · {activeFilterCount}</button>
            </div>
            <div className="market-filter-row">
              <div className="position-filter" role="group" aria-label="Filter by position">
                {(["ALL", ...POSITIONS] as const).map((position) => <button type="button" key={position} aria-pressed={store.filters.position === position} onClick={() => store.setFilters({ position })}>{position === "ALL" ? "All" : position}</button>)}
              </div>
              {!isMobileLineup && <div className="filter-desktop">
                <select className="filter-control" value={store.filters.club} onChange={(event) => store.setFilters({ club: event.target.value })} aria-label="Filter by club"><option value="">All clubs</option>{clubs.map((club) => <option value={club} key={club}>{club}</option>)}</select>
                <input className="filter-control" inputMode="decimal" value={store.filters.maxPrice} onChange={(event) => store.setFilters({ maxPrice: event.target.value })} placeholder="Max £" aria-label="Maximum price" />
              </div>}
            </div>
            <ActiveFilters filters={store.filters} setFilters={store.setFilters} />
            {isMobileLineup && <PlayerSortLine sortKey={store.sortKey} sortDirection={store.sortDirection} onSort={store.setSort} />}
          </div>
          <FilterSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} variant={isMobileLineup ? "bottom" : "popover"} anchor={filtersButton} rowHoldsClubAndMaxPrice={!isMobileLineup} filters={store.filters} setFilters={store.setFilters} clubs={clubs} onReset={resetFilters} />
          <div className="table-wrap">{isMobileLineup
            ? <PlayerList rows={filteredPlayers.slice(0, 250)} weeks={universeWeeks} gameweek={planningGameweek} inSquadIds={inSquadIds} onOpen={openPlayer} onAdd={addPlayer} />
            : <PlayersTable rows={filteredPlayers.slice(0, 250)} weeks={universeWeeks} gameweek={planningGameweek} columns={store.playerColumns} sortKey={store.sortKey} sortDirection={store.sortDirection} onSort={store.setSort} inSquadIds={inSquadIds} onOpen={openPlayer} onAdd={addPlayer} />}{status === "SYNCING" && <div className="empty-state">Loading players…</div>}{status !== "SYNCING" && filteredPlayers.length === 0 && <div className="empty-state">{data.players.length ? "No players match these filters." : message ?? "FPL data is unavailable."}</div>}</div>
          {selectedPlayer && <PlayerDetail key={selectedPlayer.id} player={selectedPlayer} gameweek={planningGameweek} inSquad={store.playerIds.includes(selectedPlayer.id)} locked={store.lockedPlayerIds.includes(selectedPlayer.id)} onClose={() => store.setSelectedPlayer(undefined)} onAdd={() => addPlayer(selectedPlayer)} onToggleLock={() => store.toggleLock(selectedPlayer.id)} />}
          <PanelResizer panel="market" onResizeStart={beginPanelResize} />
        </section>

        <div className="squad-stack">
          <section id="terminal-panel-squad" data-panel="squad" className={`squad-column ${collapsedPanels.squad ? "panel-collapsed" : ""} ${store.activeMobileTab === "SQUAD" ? "mobile-visible" : ""}`} aria-label="Squad builder and analysis">
            <div className="panel-header"><div><span className="panel-title">Squad</span><span className="panel-count">{selected.length}/15 selected</span></div><div className="header-actions"><div className="squad-view-switch" role="group" aria-label="Squad view"><button type="button" aria-pressed={store.squadView === "PITCH"} onClick={() => store.setSquadView("PITCH")}>Pitch</button><button type="button" aria-pressed={store.squadView === "TABLE"} onClick={() => store.setSquadView("TABLE")}>Table</button></div><button type="button" className="compact-action squad-lock-all" disabled={store.playerIds.length === 0} aria-label={`${allSquadPlayersLocked ? "Unlock" : "Lock"} all squad players`} aria-pressed={allSquadPlayersLocked} title={`${allSquadPlayersLocked ? "Unlock" : "Lock"} all squad players`} onClick={store.toggleAllLocks}><svg className="lock-icon" viewBox="0 0 16 16" aria-hidden="true"><path className="lock-shackle" d={allSquadPlayersLocked ? "M4 7V5a4 4 0 0 1 8 0v2" : "M12 7V5a4 4 0 0 0-7.7-1.5"} /><rect className="lock-body" x="2.5" y="7" width="11" height="7" /></svg></button><button type="button" className={`compact-action pick-team-action ${lineupStale ? "stale" : ""}`} onClick={pickGWTeam}>{lineupStale ? "Pick team · outdated" : "Pick team"}</button><button type="button" className="compact-action primary-action" disabled={optimizing} aria-label={!optimizing && selected.length < 15 ? "Complete squad" : undefined} title={!optimizing && selected.length < 15 ? "Fill the empty slots with the best legal picks" : undefined} onClick={() => void runOptimize(selected.length < 15)}>{optimizing ? "Optimizing…" : selected.length < 15 ? "Complete" : "Optimize"}</button><PanelToggle panel="squad" collapsed={collapsedPanels.squad} onToggle={() => togglePanel("squad")} /></div></div>
            <div className="squad-body">
              <SquadKpis
                projected={chipNetXp ?? projected.nextGW}
                gameweek={planningGameweek}
                value={(store.entryId === undefined ? undefined : weekFinance?.squadSellingValueTenths) ?? spent}
                valueLabel={store.entryId === undefined ? "COST" : "VALUE"}
                bankSlot={<BankMetric bankTenths={bankTenths} confidence={weekFinance?.confidence ?? "ESTIMATED"} handBuilt={store.entryId === undefined} onBankChange={(tenths) => store.setBankTenths(tenths, { spentTenths: spent, priceById: marketPriceById })} />}
                freeTransfers={weekFinance?.freeTransfersBefore}
                rating={teamRating}
              />
              {store.planNotice && <div className="plan-notice" role="status"><span>{store.planNotice}</span><button type="button" className="toast-button" aria-label="Dismiss plan notice" onClick={() => store.clearPlanNotice()}>×</button></div>}
              {store.squadView === "TABLE" ? <>
                {swapHint && <p className="swap-hint">{swapHint}</p>}
                <SquadTable
                  starters={pitchRows.flatMap((row) => row.players)}
                  bench={benchSlots.map((slot) => ({ player: slot.id ? playerById.get(slot.id) : undefined, label: slot.label }))}
                  gameweek={planningGameweek}
                  captainId={lineupApplied ? store.captainId : currentGWPlan?.captainId}
                  viceCaptainId={lineupApplied ? store.viceCaptainId : currentGWPlan?.viceCaptainId}
                  chip={store.chip}
                  onOpen={(player) => openActions(player.id)}
                />
              </> : <SquadPitch
                startingMeta={`${currentGWPlan ? formationLabel(currentGWPlan) : "3-4-3"} · ${currentGWPlan ? 11 : draftStarterCount}/11`}
                captainCaption={captainCaption}
                rows={pitchRows}
                bench={benchSlots.map((slot) => ({ player: slot.id ? playerById.get(slot.id) : undefined, position: slot.position, label: slot.label }))}
                hint={swapHint}
                renderPlayer={renderSquadPlayer}
                drag={pitchDrag}
                renderEmpty={(position, key) => <EmptySlot key={key} position={position} maxPriceTenths={slotMaxPrices[position]} onChoose={() => choosePlayer(position)} />}
              />}
            </div>
            {simulation && simulationMoves && simulationMoves.length > 0 && <div className="squad-overlay" ref={simulationRef}><SimulationPanel result={simulation} moves={simulationMoves} playerById={playerById} onApply={applySimulation} onDiscard={() => { setSimulation(null); setSimulationMoves(null); }} /></div>}
            <PanelResizer panel="squad" onResizeStart={beginPanelResize} />
          </section>

          <DecisionRail
            mobileVisible={store.activeMobileTab === "SQUAD"}
            captain={<CaptainSection
              starters={pitchRows.flatMap((row) => row.players)}
              gameweek={planningGameweek}
              captainId={lineupApplied ? store.captainId : currentGWPlan?.captainId}
              viceCaptainId={lineupApplied ? store.viceCaptainId : currentGWPlan?.viceCaptainId}
              onOpen={(playerId) => openActions(playerId)}
            />}
            alerts={<AlertsSection alerts={planAlerts} onOpen={(playerId) => openActions(playerId)} />}
            transfers={<TransferSuggestionsPanel suggestions={transferSuggestions} state={transferSuggestionState} message={transferSuggestionMessage} horizon={store.transferHorizon} onHorizon={(transferHorizon) => store.setStrategy({ transferHorizon })} bankedTransfers={bankedTransfers} onBankedTransfers={setBankedTransfersChoice} playerById={playerById} onSimulate={simulateSuggestion} onDismiss={dismissSuggestion} />}
            chips={<RailSection title="Chips">
              <ChipSelector gameweek={planningGameweek} onNotice={setNotice} />
              <ChipStrategyPanel players={data.players} planningGameweek={planningGameweek} onNotice={setNotice} />
            </RailSection>}
          />
        </div>

      </div>
      {notice && (noticeMinimized
        ? <button type="button" className="toast toast-pill" aria-label="Show notification" onClick={() => setNoticeMinimized(false)}>{notice}</button>
        : <div className="toast" role="status"><span className="toast-message">{notice}</span><span className="toast-actions"><button type="button" className="toast-button" aria-label="Minimize" onClick={() => setNoticeMinimized(true)}>–</button><button type="button" className="toast-button" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button></span></div>)}
      {actionPlayer && <PlayerActions
        player={actionPlayer}
        starter={actionStarter}
        benchLabel={actionBenchSlot?.label}
        benchIndex={actionBenchIndex}
        captain={(lineupApplied ? store.captainId : currentGWPlan?.captainId) === actionPlayer.id}
        vice={(lineupApplied ? store.viceCaptainId : currentGWPlan?.viceCaptainId) === actionPlayer.id}
        locked={store.lockedPlayerIds.includes(actionPlayer.id)}
        lineupActive={Boolean(currentGWPlan)}
        sellingPriceTenths={store.entryId !== undefined ? weekFinance?.sellingPricesTenths[actionPlayer.id] : undefined}
        gameweek={planningGameweek}
        chip={store.chip}
        variant={isMobileLineup ? "bottom" : "popover"}
        anchor={actionAnchor}
        onClose={() => setActionPlayerId(null)}
        onInfo={() => openPlayer(actionPlayer.id)}
        onCaptain={() => makeGWCaptain(actionPlayer.id)}
        onViceCaptain={() => makeGWViceCaptain(actionPlayer.id)}
        onSwap={() => selectGWSwapPlayer(actionStarter ? "starter" : "bench", actionPlayer.id)}
        onMoveBench={(direction) => moveGWBench(actionPlayer.id, direction)}
        onToggleLock={() => store.toggleLock(actionPlayer.id)}
        onRemove={() => removeSquadPlayer(actionPlayer)}
      />}
      <BottomTabBar active={store.activeMobileTab === "MARKET" ? "PLAYERS" : "SQUAD"} onSquad={() => store.setMobileTab("SQUAD")} onPlayers={() => store.setMobileTab("MARKET")} onMore={() => setMoreOpen(true)} />
      <MoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        onRefresh={refresh}
        onExport={() => exportState(store)}
        onImportClick={() => importRef.current?.click()}
        onReset={reset}
        onReverse={() => void reverseAllChanges()}
        reverseBusy={reverseBusy}
        reverseDisabled={!store.entryId}
        settings={<StrategyControls horizon={store.horizon} benchStrategy={store.benchStrategy} setStrategy={store.setStrategy} />}
        onModeChooser={() => store.setMode(null)}
      />
    </main>
  );
}

function ModeChooser({ status, message, gameweek, notice, onChoose }: { status: DataState; message?: string; gameweek: number | null; notice?: string | null; onChoose: (mode: TerminalMode) => void }) {
  return <main className="mode-screen"><div className="mode-brand"><span className="brand-mark">FPL</span><span className="brand-name">Terminal</span></div><p className="mode-tagline">Expected points, an exact squad optimizer and live mini-leagues.</p>{notice && <p className="live-notice" role="alert">{notice}</p>}<div className="mode-grid"><button className="mode-card" onClick={() => onChoose("BUILD")}><span className="mode-index">Mode A</span><strong>Build from scratch</strong><span>Start with £100.0m and construct your squad player by player, with live projections reacting to every pick.</span></button><button className="mode-card" onClick={() => onChoose("ANALYZE")}><span className="mode-index">Mode B · recommended</span><strong>Import a team</strong><span>Enter an existing 15-player squad and get immediate analysis: weakest links, budget inefficiencies, and upgrade opportunities.</span></button></div><p className="mode-leagues-link"><Link href="/leagues" prefetch={false}>Track a mini-league live →</Link></p><div className="mode-footer"><span className={`status-pip ${status.toLowerCase()}`} />{status === "LIVE" ? `Live FPL data · Gameweek ${gameweek ?? "—"}` : status === "SNAPSHOT" ? `Snapshot data · Gameweek ${gameweek ?? "—"}` : status === "STALE" ? `Stale data · Gameweek ${gameweek ?? "—"}` : status === "SYNCING" ? "Loading FPL data…" : message ?? "FPL data is unavailable."}</div><p className="mode-disclaimer">Not affiliated with, endorsed by, or connected to the Premier League or Fantasy Premier League. Player data comes from public FPL endpoints; projections are estimates, not advice.</p></main>;
}

type ImportedTeam = { entryId: number; budgetTenths: number; teamName?: string; managerName?: string; squad: SquadState; lineup: Omit<ApplyLineupInput, "lineupProjectionFingerprint">; transferBaseline?: TransferBaseline | null; usedChips?: Array<{ kind: ChipKind; gameweek: number }>; financialConfidence?: "EXACT" | "ESTIMATED"; importWarnings?: string[]; chip?: ChipKind | null };

function TeamImportScreen({ players, gameweek, notice, onImport, onBack }: { players: TerminalPlayer[]; gameweek: number; notice?: string | null; onImport: (result: ImportedTeam) => boolean; onBack: () => void }) {
  const [entryId, setEntryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = entryId.trim();
    if (!/^\d+$/.test(id) || Number(id) < 1) return setError("Enter a valid FPL team ID.");
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/fpl/entry/${id}?gameweek=${gameweek}`, { headers: { accept: "application/json" } });
      const body = await response.json() as { data?: ImportedTeam; errors?: string[] };
      if (!response.ok || !body.data?.squad || !body.data.lineup) throw new Error(body.errors?.[0] ?? "FPL team import failed.");
      const known = new Set(players.map((player) => player.id));
      if (body.data.squad.playerIds.some((playerId) => !known.has(playerId))) throw new Error("This team contains players missing from the current FPL player data. Refresh and try again.");
      if (!onImport(body.data)) throw new Error("FPL returned an invalid 15-player squad.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "FPL team import failed.");
    } finally {
      setBusy(false);
    }
  };
  return <main className="mode-screen import-screen"><button type="button" className="import-back" onClick={onBack}>← Back</button><div className="mode-brand"><span className="brand-mark">FPL</span><span className="brand-name">Terminal</span></div><p className="mode-tagline">Import your FPL team</p>{notice && <p className="live-notice" role="alert">{notice}</p>}<form className="import-card" onSubmit={submit}><label htmlFor="fpl-entry-id">Enter FPL ID</label><div className="import-controls"><input id="fpl-entry-id" inputMode="numeric" pattern="[0-9]*" autoFocus value={entryId} onChange={(event) => setEntryId(event.target.value)} placeholder="4827193" /><button className="primary-button" type="submit" disabled={busy || !players.length}>{busy ? "Importing…" : "Import team"}</button></div><p>We’ll load Gameweek {gameweek} picks from the official FPL API and fill all 15 squad positions.</p><details className="import-guide"><summary>Where do I get my Team ID?</summary><ol><li>Sign in at <a href="https://fantasy.premierleague.com/" target="_blank" rel="noreferrer">Fantasy Premier League</a>.</li><li>Open your Points page.</li><li>Find <code>/entry/1234567/event/3</code> in the address bar. Your Team ID is the number after <code>/entry/</code>.</li><li>Paste that number above and select Import Team.</li></ol></details>{!players.length && <span className="import-error" role="status">Waiting for the FPL player list…</span>}{error && <span className="import-error" role="alert">{error}</span>}</form></main>;
}

function DataStatusCell({ status, ageAnchor, fetchedAt }: { status: DataState; ageAnchor: DataAgeAnchor | null; fetchedAt: string | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const value = status === "LIVE" ? "Live data" : status === "SNAPSHOT" ? "Snapshot data" : status === "STALE" ? "Stale data" : status === "SYNCING" ? "Syncing" : "Offline";
  const ageMs = computeDataAgeMs(now, ageAnchor, fetchedAt);
  const ageText = ageMs !== null ? formatDataAge(ageMs) : "";
  const tone = status === "LIVE" ? "live" : status === "ERROR" ? "error" : "stale";
  return <div className={`status-cell data-status ${tone}`}><i aria-hidden="true" /><strong>{value}</strong>{ageText && <span>· {ageText}</span>}</div>;
}

function PanelToggle({ panel, collapsed, onToggle }: { panel: DesktopPanel; collapsed: boolean; onToggle: () => void }) {
  return <button type="button" className="panel-collapse" aria-expanded={!collapsed} aria-controls={`terminal-panel-${panel}`} aria-label={`${collapsed ? "Expand" : "Minimize"} ${PANEL_LABELS[panel]}`} onClick={onToggle}>{collapsed ? "+" : "−"}</button>;
}

function PanelResizer({ panel, onResizeStart }: { panel: DesktopPanel; onResizeStart: (panel: DesktopPanel, event: ReactPointerEvent<HTMLButtonElement>) => void }) {
  return <button type="button" className="panel-resizer" role="separator" aria-orientation="vertical" aria-label={`Resize ${PANEL_LABELS[panel]}`} onPointerDown={(event) => onResizeStart(panel, event)} />;
}

function PlayerDetail({ player, gameweek, inSquad, locked, onClose, onAdd, onToggleLock }: { player: TerminalPlayer; gameweek: number; inSquad: boolean; locked: boolean; onClose: () => void; onAdd: () => void; onToggleLock: () => void }) {
  const profile = usePlayerProfile(player.id);
  const profileData = profile.data;
  const current = profileData?.player.current ?? player.current;
  const selection = player.selection;
  const weekMetrics = weeklyPlayerMetrics(player, gameweek);
  const expectedMinutes = weekMetrics.minutes;
  const projectedFixtures = player.projection?.fixtures ?? [];
  const next3 = projectedPointsForGameweeks(projectedFixtures, gameweek, 3);
  const next5 = projectedPointsForGameweeks(projectedFixtures, gameweek, 5);
  const expectedGoalInvolvements = profileXgi(current);
  const recentMatches = profileData?.history.slice(-6).reverse() ?? [];
  const upcomingFixtures = (profileData?.fixtures.length ? profileData.fixtures : player.fixtures).filter((fixture) => fixture.gameweek >= gameweek).slice(0, 5);
  const availability = availabilityOf(player);
  const titleId = `player-profile-${player.id}`;

  const coreSeasonStats = [
    ["Starts", formatProfileStat(current.starts)],
    ["Minutes", formatProfileStat(current.minutes)],
    ["Goals", formatProfileStat(current.goals)],
    ["Assists", formatProfileStat(current.assists)],
    ["Clean sheets", formatProfileStat(current.cleanSheets)],
    ["Bonus", formatProfileStat(current.bonus)],
    ["BPS", formatProfileStat(current.bps)],
    ["xG", formatProfileStat(current.expectedGoals, 2)],
    ["xA", formatProfileStat(current.expectedAssists, 2)],
    ["xGI", formatProfileStat(expectedGoalInvolvements, 2)],
    ["xGC", formatProfileStat(current.expectedGoalsConceded, 2)],
    ["Def contribution", formatProfileStat(current.defensiveContribution)],
  ] as const;

  const advancedSeasonStats = [
    ["Goals conceded", formatProfileStat(current.goalsConceded)],
    ["CBI", formatProfileStat(current.clearancesBlocksInterceptions)],
    ["Recoveries", formatProfileStat(current.recoveries)],
    ["Tackles", formatProfileStat(current.tackles)],
    ["Saves", formatProfileStat(current.saves)],
    ["Penalties saved", formatProfileStat(current.penaltiesSaved)],
    ["Influence", formatProfileStat(current.influence, 1)],
    ["Creativity", formatProfileStat(current.creativity, 1)],
    ["Threat", formatProfileStat(current.threat, 1)],
    ["ICT index", formatProfileStat(current.ictIndex, 1)],
    ["Yellow cards", formatProfileStat(current.yellowCards)],
    ["Red cards", formatProfileStat(current.redCards)],
  ] as const;

  return <dialog
    open
    className="detail-panel"
    aria-labelledby={titleId}
    aria-modal="false"
  >
    <div className="detail-frame">
      <header className="detail-head">
        <div className="detail-identity">
          <div className="detail-title-line"><h2 id={titleId}>{player.displayName}</h2><span className={`pos-tag ${player.position.toLowerCase()}`}>{player.position}</span></div>
          <p>{player.teamName} · {money(player.priceTenths)} · {player.ownership.toFixed(1)}% owned</p>
          {player.news && <p className="detail-news">{player.news}</p>}
        </div>
        <div className="detail-head-actions">
          <span className={`profile-status ${availability.toLowerCase()}`}>{profileAvailabilityLabel(availability)}</span>
          <button className="icon-button" autoFocus onClick={onClose} aria-label="Close player detail">×</button>
        </div>
      </header>

      <div className="detail-scroll">
        <section className="profile-hero" aria-label={`${player.displayName} headline statistics`}>
          <div className="profile-points"><span>Season points</span><strong>{formatProfileStat(current.totalPoints)}</strong><small>{formatProfileStat(current.pointsPerGame, 1)} per game</small></div>
          <div className="profile-hero-metrics">
            <Metric label="Form" value={formatProfileStat(current.form, 1)} tone="amber" />
            <Metric label="Points / 90" value={formatProfileStat(current.pointsPer90 ?? per90(current.totalPoints, current.minutes), 2)} />
            <Metric label="xGI / 90" value={formatProfileStat(per90(expectedGoalInvolvements, current.minutes), 2)} />
            <Metric label={`GW ${gameweek} xP`} value={points(weekMetrics.points)} tone="cyan" />
          </div>
        </section>

        <PointsBreakdown player={player} gameweek={gameweek} />

        <section className="profile-section" aria-labelledby="recent-matches-heading">
          <div className="profile-section-head"><div><h3 id="recent-matches-heading">Recent matches</h3><p>Latest FPL performances, newest first</p></div><span className="data-badge live">Live FPL</span></div>
          {profile.status === "LOADING" && <div className="profile-loading" role="status">Loading match history…</div>}
          {profile.status === "ERROR" && <div className="profile-error" role="status">{profile.message}</div>}
          {profile.status === "READY" && !recentMatches.length && <div className="profile-empty">No current-season appearances yet.</div>}
          {recentMatches.length > 0 && <div className="recent-match-list">{recentMatches.map((match) => <RecentMatchRow key={match.fixtureId ?? `${match.gameweek}-${match.opponentTeamId}`} match={match} teamShortName={player.teamShortName} />)}</div>}
        </section>

        <section className="profile-section" aria-labelledby="season-output-heading">
          <div className="profile-section-head"><div><h3 id="season-output-heading">Current season output</h3><p>Official totals from the FPL player feed</p></div><span className="profile-record-count">{formatProfileStat(current.starts)} starts · {formatProfileStat(current.minutes)} min</span></div>
          <div className="current-stat-grid">{coreSeasonStats.map(([label, value]) => <Metric key={label} label={label} value={value} />)}</div>
          <details className="advanced-stat-disclosure">
            <summary><span>Advanced stats</span><span>{advancedSeasonStats.length} metrics</span></summary>
            <div className="current-stat-grid">{advancedSeasonStats.map(([label, value]) => <Metric key={label} label={label} value={value} />)}</div>
          </details>
        </section>

        <div className="profile-split">
          <section className="profile-section profile-model" aria-labelledby="selection-model-heading">
            <div className="profile-section-head"><div><h3 id="selection-model-heading">Selection and projection</h3><p>Estimated availability and forward output</p></div><span className="data-badge model">Model</span></div>
            <div className="profile-model-grid">
              <Metric label="Start" value={selection ? probability(selection.startProbability) : "—"} tone="cyan" />
              <Metric label="Cameo" value={selection ? probability(selection.cameoProbability) : "—"} />
              <Metric label="DNP" value={selection ? probability(selection.noAppearanceProbability) : "—"} />
              <Metric label="Expected min" value={expectedMinutes ? `${Math.round(expectedMinutes)}′` : "—"} />
              <Metric label="Nailed / 5" value={selection ? String(selection.nailedRating) : "—"} tone="amber" />
              <Metric label="Confidence" value={selection?.confidence ?? player.projection?.confidence ?? "—"} />
              <Metric label="Risk / 100" value={formatProfileStat(player.projection?.riskScore)} />
              <Metric label="3GW xP" value={points(next3)} />
              <Metric label="5GW xP" value={points(next5)} />
              <Metric label="xP / £" value={formatProfileStat(valuePerMillion(next5, player.priceTenths), 2)} />
            </div>
          </section>

          <section className="profile-section profile-fixtures" aria-labelledby="upcoming-fixtures-heading">
            <div className="profile-section-head"><div><h3 id="upcoming-fixtures-heading">Upcoming fixtures</h3><p>Next five scheduled matches</p></div></div>
            <div className="profile-fixture-list">{upcomingFixtures.length ? upcomingFixtures.map((fixture) => <div className="profile-fixture" key={fixture.fixtureId ?? `${fixture.gameweek}-${fixture.opponentTeamId}`}><span>GW {fixture.gameweek || "—"}</span><strong>{fixture.opponentShortName} <small>{fixture.isHome ? "H" : "A"}</small></strong><time dateTime={fixture.kickoffTime}>{formatProfileDate(fixture.kickoffTime)}</time><em className={`fdr-${fixture.difficulty ?? 3}`}>FDR {fixture.difficulty ?? "—"}</em></div>) : <div className="profile-empty">No scheduled fixtures.</div>}</div>
          </section>
        </div>

        <section className="profile-section" aria-labelledby="previous-seasons-heading">
          <div className="profile-section-head"><div><h3 id="previous-seasons-heading">Previous seasons</h3><p>Full FPL history, with per-90 rates derived from official totals</p></div><span className="profile-record-count">{profileData?.historyPast.length ?? 0} seasons</span></div>
          {profile.status === "LOADING" && <div className="profile-loading" role="status">Loading season history…</div>}
          {profile.status === "ERROR" && <div className="profile-error">Season history is unavailable.</div>}
          {profile.status === "READY" && profileData && <PreviousSeasonsTable seasons={profileData.historyPast} />}
        </section>
      </div>

      <footer className="detail-footer">
        <div className="detail-actions"><button className="primary-button" disabled={inSquad} onClick={onAdd}>{inSquad ? "In squad" : "Add to squad"}</button><button className={`secondary-button ${locked ? "locked" : ""}`} onClick={onToggleLock}>{locked ? "Unlock player" : "Lock player"}</button></div>
        <p className="provenance"><span className="data-badge live">Live</span> Current and historical results come from FPL. <span className="data-badge model">Model</span> xP, minutes, risk and selection probabilities are estimates.</p>
      </footer>
    </div>
  </dialog>;
}

/** Explains the gameweek xP shown in the hero, one row per way points are earned. */
function PointsBreakdown({ player, gameweek }: { player: TerminalPlayer; gameweek: number }) {
  const breakdown = gameweekBreakdown(player, gameweek);
  const widest = breakdown ? Math.max(...breakdown.rows.map((row) => Math.abs(row.points)), 0.01) : 1;
  return <section className="profile-section" aria-labelledby="points-breakdown-heading">
    <div className="profile-section-head">
      <div>
        <h3 id="points-breakdown-heading">xP breakdown</h3>
        <p>An average over every way the match could go, not a forecast of one scoreline. The figures under each row are the record behind it, not the sum that produced it — the model weighs them against position averages and the opponent.</p>
      </div>
      <span className="data-badge model">Model</span>
    </div>
    {!breakdown
      ? <div className="profile-empty">No match to break down in gameweek {gameweek}.</div>
      : <div className="breakdown-rows">
        {breakdown.rows.map((row) => <div className="breakdown-row" key={row.key}>
          <span className="breakdown-label">
            <strong>{row.label}</strong>
            {row.note && <small>{row.note}</small>}
            <small className="breakdown-evidence">{row.metric && <em>{row.metric}</em>}{row.evidence.map((entry) => <span key={entry.label}><i>{entry.label}</i> {entry.value}</span>)}</small>
          </span>
          <span className="breakdown-bar" aria-hidden="true"><i className={row.deduction ? "minus" : ""} style={{ width: `${Math.min(100, (Math.abs(row.points) / widest) * 100)}%` }} /></span>
          <strong className={`breakdown-points ${row.deduction ? "minus" : ""}`}>{row.points.toFixed(2)}</strong>
        </div>)}
        <div className="breakdown-row breakdown-total">
          <span className="breakdown-label"><strong>Gameweek {gameweek} total</strong>{breakdown.matches > 1 && <small>Both matches of a double gameweek, added together</small>}</span>
          <span className="breakdown-bar" aria-hidden="true" />
          <strong className="breakdown-points">{breakdown.total.toFixed(2)}</strong>
        </div>
      </div>}
  </section>;
}

function RecentMatchRow({ match, teamShortName }: { match: PlayerMatchPerformance; teamShortName: string }) {
  const xgi = profileXgi(match.stats);
  const outcome = matchOutcome(match);
  const pointsTone = match.stats.totalPoints >= 8 ? "haul" : match.stats.totalPoints >= 5 ? "return" : match.stats.totalPoints <= 1 ? "blank" : "steady";
  return <details className={`recent-match-row ${pointsTone}`}>
    <summary aria-label={`Gameweek ${match.gameweek}, ${match.opponentShortName}, ${match.stats.totalPoints} points`}>
      <span className="recent-match-gw">GW {match.gameweek || "—"}</span>
      <span className="recent-match-opponent"><strong>{match.opponentShortName} <small>{match.isHome ? "H" : "A"}</small></strong><span><em className={outcome ? `outcome-${outcome.toLowerCase()}` : ""}>{outcome || "—"}</em>{matchScoreline(match, teamShortName)}</span></span>
      <time dateTime={match.kickoffTime}>{formatProfileDate(match.kickoffTime)}</time>
      <strong className="recent-row-points">{match.stats.totalPoints}<small> pts</small></strong>
    </summary>
    <div className="recent-match-expanded">
      <dl className="recent-match-stats">
        <div><dt>Min</dt><dd>{match.stats.minutes}</dd></div><div><dt>G</dt><dd>{match.stats.goals}</dd></div><div><dt>A</dt><dd>{match.stats.assists}</dd></div>
        <div><dt>xG</dt><dd>{formatProfileStat(match.stats.expectedGoals, 2)}</dd></div><div><dt>xA</dt><dd>{formatProfileStat(match.stats.expectedAssists, 2)}</dd></div><div><dt>CS</dt><dd>{match.stats.cleanSheets}</dd></div>
        <div><dt>Bon</dt><dd>{match.stats.bonus}</dd></div><div><dt>BPS</dt><dd>{match.stats.bps}</dd></div><div><dt>Def</dt><dd>{formatProfileStat(match.stats.defensiveContribution)}</dd></div>
      </dl>
      <div className="recent-match-foot"><span>xGI {formatProfileStat(xgi, 2)}</span><span>{match.stats.saves ? `${match.stats.saves} saves` : `${match.stats.yellowCards} YC · ${match.stats.redCards} RC`}</span></div>
    </div>
  </details>;
}

function PreviousSeasonsTable({ seasons }: { seasons: PlayerProfileData["historyPast"] }) {
  if (!seasons.length) return <div className="profile-empty">No previous FPL seasons for this player.</div>;
  return <div className="profile-history-wrap"><table className="profile-history-table" aria-label="Previous FPL season statistics"><thead><tr><th>Season</th><th>Pts</th><th>Starts</th><th>Min</th><th>Pts/90</th><th>G</th><th>A</th><th>CS</th><th>xG</th><th>xA</th><th>xGI/90</th><th>Def</th><th>BPS</th><th>Bonus</th><th>Saves</th><th>ICT</th><th>YC</th><th>RC</th><th>Start £</th><th>End £</th></tr></thead><tbody>{[...seasons].reverse().map((season) => {
    const xgi = profileXgi(season.stats);
    return <tr key={season.season}><th scope="row">{season.season}</th><td className="history-points">{season.stats.totalPoints}</td><td>{season.stats.starts}</td><td>{season.stats.minutes}</td><td>{formatProfileStat(per90(season.stats.totalPoints, season.stats.minutes), 2)}</td><td>{season.stats.goals}</td><td>{season.stats.assists}</td><td>{season.stats.cleanSheets}</td><td>{formatProfileStat(season.stats.expectedGoals, 2)}</td><td>{formatProfileStat(season.stats.expectedAssists, 2)}</td><td>{formatProfileStat(per90(xgi, season.stats.minutes), 2)}</td><td>{formatProfileStat(season.stats.defensiveContribution)}</td><td>{season.stats.bps}</td><td>{season.stats.bonus}</td><td>{season.stats.saves}</td><td>{formatProfileStat(season.stats.ictIndex, 1)}</td><td>{season.stats.yellowCards}</td><td>{season.stats.redCards}</td><td>{money(season.startPriceTenths)}</td><td>{money(season.endPriceTenths)}</td></tr>;
  })}</tbody></table></div>;
}

function Metric({ label, value, tone, title }: { label: string; value: string; tone?: string; title?: string }) { return <div title={title}><span>{label}</span><strong className={tone ?? ""}>{value}</strong></div>; }

function EmptySlot({ position, maxPriceTenths, onChoose }: { position: Position; maxPriceTenths: number; onChoose: () => void }) { return <button type="button" className="pitch-empty" onClick={onChoose}><span className="empty-plus" aria-hidden="true">+</span><span className="token-name">Open {position}</span><span className="empty-max">Max {money(maxPriceTenths)}</span><span className="suggest-label">Suggest →</span></button>; }

/**
 * Cash in the bank, editable.
 *
 * The text being typed lives here rather than in the store. A person typing
 * "12.5" passes through "1", "12" and "12.", none of which is a figure to
 * commit; writing each one back and re-rendering the box from the store would
 * overwrite the keystrokes as they arrive. The draft holds until they leave
 * the field or press Enter, and Escape abandons it.
 */
function BankMetric({ bankTenths, confidence, handBuilt, onBankChange }: { bankTenths: number; confidence: "EXACT" | "ESTIMATED"; handBuilt: boolean; onBankChange: (tenths: number) => boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const shown = draft ?? (bankTenths / 10).toFixed(1);
  const commit = (text: string) => {
    const tenths = parseBankInput(text);
    if (tenths !== null) onBankChange(tenths);
    setDraft(null);
  };
  // Stepping keeps the field in hand: it moves the draft and leaves focus
  // where it was, so several nudges are one edit, committed like any other.
  const step = (deltaTenths: number) => setDraft(steppedBankText(shown, deltaTenths));
  const stepper = (deltaTenths: number, label: string, glyph: string) => <button
    type="button"
    className="metric-step"
    aria-label={label}
    tabIndex={-1}
    disabled={deltaTenths < 0 && (parseBankInput(shown) ?? 0) === 0}
    // Taking focus would blur the field, committing and closing the edit
    // before the click landed.
    onMouseDown={(event) => event.preventDefault()}
    onClick={() => step(deltaTenths)}
  >{glyph}</button>;
  return <div className={editing ? "metric-editable editing" : "metric-editable"}>
    <span>Bank</span>
    <span className="metric-money">
      <span aria-hidden="true">£</span>
      <input
        className="metric-input"
        type="text"
        inputMode="decimal"
        value={shown}
        aria-label="Cash in the bank in millions"
        title={handBuilt
          ? "Type what you have left to spend. It sets the budget, so the optimizer and team rating follow it."
          : confidence === "ESTIMATED"
            ? "Estimated. Type the value your FPL team page shows."
            : "From your FPL entry. Editing this overrides the imported figure."}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={(event) => { setEditing(false); commit(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget.value);
          else if (event.key === "Escape") setDraft(null);
          else if (event.key === "ArrowUp") { event.preventDefault(); step(1); }
          else if (event.key === "ArrowDown") { event.preventDefault(); step(-1); }
        }}
      />
      {editing && <span className="metric-steppers">
        {stepper(-1, "Lower the bank by £0.1m", "−")}
        {stepper(1, "Raise the bank by £0.1m", "+")}
      </span>}
    </span>
  </div>;
}

const BENCH_STRATEGY_LABELS = { CHEAP: "Cheap", BALANCED: "Balanced", STRONG: "Strong" } as const;

function StrategyControls({ horizon, benchStrategy, setStrategy }: { horizon: 1 | 3 | 5 | 10; benchStrategy: "CHEAP" | "BALANCED" | "STRONG"; setStrategy: (strategy: { horizon?: 1 | 3 | 5 | 10; benchStrategy?: "CHEAP" | "BALANCED" | "STRONG" }) => void }) { return <div className="strategy-panel"><span className="strategy-title">Optimizer settings</span><div><span className="strategy-label">Horizon</span><div className="segmented">{([1, 3, 5, 10] as const).map((value) => <button type="button" key={value} className={horizon === value ? "active" : ""} aria-pressed={horizon === value} onClick={() => setStrategy({ horizon: value })}>{value} GW</button>)}</div></div><div><span className="strategy-label">Bench</span><div className="segmented">{(["CHEAP", "BALANCED", "STRONG"] as const).map((value) => <button type="button" key={value} className={benchStrategy === value ? "active" : ""} aria-pressed={benchStrategy === value} onClick={() => setStrategy({ benchStrategy: value })}>{BENCH_STRATEGY_LABELS[value]}</button>)}</div></div></div>; }

function TransferSuggestionsPanel({
  suggestions,
  state,
  message,
  horizon,
  onHorizon,
  bankedTransfers,
  onBankedTransfers,
  playerById,
  onSimulate,
  onDismiss,
}: {
  suggestions: SingleTransferSuggestion[];
  state: "INCOMPLETE" | "LOADING" | "READY" | "ERROR";
  message: string | null;
  horizon: 1 | 3 | 5 | 10;
  onHorizon: (horizon: 1 | 3 | 5 | 10) => void;
  bankedTransfers: number;
  onBankedTransfers: (banked: number) => void;
  playerById: Map<number, TerminalPlayer>;
  onSimulate: (suggestion: SingleTransferSuggestion) => void;
  onDismiss: (suggestion: SingleTransferSuggestion) => void;
}) {
  const name = (id: number) => playerById.get(id)?.displayName ?? `Player ${id}`;
  const signedMoney = (tenths: number) => `${tenths >= 0 ? "+" : "−"}${money(Math.abs(tenths))}`;
  return (
    <section className="replacement-panel unified-replacements" aria-label="Transfer suggestions">
      <div className="rail-head">
        <h2>Transfers</h2>
        <span className="panel-count">{suggestions.length ? `${suggestions.length} found` : "Exact search"}</span>
      </div>
      <div className="transfer-controls">
        <label className="banked-transfers">
          <span>Free transfers</span>
          <select value={bankedTransfers} onChange={(e) => onBankedTransfers(Number(e.target.value))} aria-label="Banked transfers">
            {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <div className="segmented transfer-horizon" role="group" aria-label="Transfer suggestion horizon">
          {([1, 3, 5, 10] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={horizon === value ? "active" : ""}
              aria-pressed={horizon === value}
              onClick={() => onHorizon(value)}
            >
              {value} GW
            </button>
          ))}
        </div>
      </div>
      <div className="replacement-scroll">
        {suggestions.length ? (
          suggestions.map((suggestion, sIdx) => {
            const moves = suggestion.moves && suggestion.moves.length > 1 ? suggestion.moves : undefined;
            const kind = suggestion.kind === "BOTH" ? "More xP and cash" : "More xP";
            const rowKey = moves
              ? moves.map((m) => `${m.outgoingPlayerId}-${m.incomingPlayerId}`).join("_")
              : `${suggestion.outgoingPlayerId}-${suggestion.incomingPlayerId}`;
            const incoming = playerById.get(suggestion.incomingPlayerId);
            return (
              <div className="replacement-row" key={`${rowKey}-${sIdx}`}>
                <div className="transfer-moves">
                  {moves ? (
                    <>
                      {moves.map((m, mIdx) => (
                        <div key={mIdx} className="transfer-step">
                          <span className="transfer-step-index">{mIdx + 1}</span>
                          <strong>{name(m.outgoingPlayerId)} → {name(m.incomingPlayerId)}</strong>
                          {m.cashReleasedTenths !== undefined && <small>{signedMoney(m.cashReleasedTenths)}</small>}
                        </div>
                      ))}
                      <small>{suggestion.transfersCount ?? moves.length} transfers · {kind}</small>
                    </>
                  ) : (
                    <>
                      <strong>{name(suggestion.outgoingPlayerId)} → {name(suggestion.incomingPlayerId)}</strong>
                      <small>{kind} · {incoming?.teamShortName ?? "—"} · {incoming ? money(incoming.priceTenths) : "—"}</small>
                    </>
                  )}
                </div>
                <div className="transfer-effects">
                  <span className="green">+{suggestion.projectedDelta.toFixed(1)} xP</span>
                  <span>{signedMoney(suggestion.cashReleasedTenths)} bank</span>
                </div>
                <div className="transfer-actions">
                  <button type="button" className="compact-action" onClick={() => onSimulate(suggestion)}>Simulate</button>
                  <button type="button" className="transfer-dismiss" aria-label="Dismiss suggestion" title="Dismiss suggestion" onClick={() => onDismiss(suggestion)}>×</button>
                </div>
              </div>
            );
          })
        ) : (
          <p className="rail-empty">
            {state === "LOADING"
              ? "Searching for legal transfers that raise xP…"
              : state === "INCOMPLETE"
              ? "Complete a legal 15-player squad to see exact transfers."
              : state === "ERROR"
              ? message ?? "Exact transfer search is unavailable."
              : `No legal ${bankedTransfers > 1 ? `${bankedTransfers}-transfer chain` : "single transfer"} raises your best lineup's xP.`}
          </p>
        )}
      </div>
    </section>
  );
}

function SimulationPanel({
  result,
  moves,
  playerById,
  onApply,
  onDiscard,
}: {
  result: SimulationResult;
  moves: Array<{ outId: number; inId: number; cashReleasedTenths?: number }>;
  playerById: Map<number, TerminalPlayer>;
  onApply: () => void;
  onDiscard: () => void;
}) {
  return (
    <section className="panel simulation-panel">
      <div className="panel-header">
        <div>
          <span className="panel-title">Simulation</span>
          <span className="panel-count">{result.legal ? "Legal squad" : "Check squad rules"}</span>
        </div>
        <button className="icon-button" onClick={onDiscard} aria-label="Close simulation">
          ×
        </button>
      </div>
      <div className="simulation-move" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        {moves.map((m, idx) => (
          <div key={idx} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span className="fs-small" style={{ color: "var(--muted)", minWidth: "14px" }}>{idx + 1}.</span>
            <span>{playerById.get(m.outId)?.displayName ?? "Outgoing"}</span>
            <span>→</span>
            <span>{playerById.get(m.inId)?.displayName ?? "Incoming"}</span>
            {m.cashReleasedTenths !== undefined && (
              <small className="fs-small" style={{ color: "var(--muted)" }}>
                ({m.cashReleasedTenths >= 0 ? `+${money(m.cashReleasedTenths)}` : `−${money(Math.abs(m.cashReleasedTenths))}`})
              </small>
            )}
          </div>
        ))}
      </div>
      <div className="simulation-grid">
        <div>
          <span>Now, {result.horizon} GW xP</span>
          <strong>{points(result.optimizedBeforeXp)}</strong>
        </div>
        <div>
          <span>After, {result.horizon} GW xP</span>
          <strong>{points(result.optimizedAfterXp)}</strong>
        </div>
        <div>
          <span>Bank</span>
          <strong className={(result.cashReleasedTenths ?? -result.priceDeltaTenths) >= 0 ? "green" : ""}>
            {(result.cashReleasedTenths ?? -result.priceDeltaTenths) >= 0 ? "+" : "−"}
            {money(Math.abs(result.cashReleasedTenths ?? -result.priceDeltaTenths))}
          </strong>
        </div>
        <div>
          <span>xP change</span>
          <strong className={result.projectedDelta >= 0 ? "green" : "red"}>
            {result.projectedDelta >= 0 ? "+" : ""}
            {result.projectedDelta.toFixed(1)} xP
          </strong>
        </div>
      </div>
      <p className="simulation-note">
        {result.explanationFactors[0] ?? "Model comparison complete."}
        {!result.legal && " The current selection still has a squad-rules issue."}
      </p>
      <div className="simulation-actions">
        <button type="button" className="primary-button" onClick={onApply}>
          Apply changes
        </button>
        <button type="button" className="secondary-button" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </section>
  );
}

function probability(value: number): string { return `${Math.round(clamp(value, 0, 1) * 100)}%`; }
function formatProfileStat(value: number | undefined, digits = 0): string { return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits); }
function per90(value: number | undefined, minutes: number | undefined): number | undefined { return value === undefined || minutes === undefined || minutes <= 0 ? undefined : value / minutes * 90; }
function profileXgi(stats: Player["current"]): number | undefined {
  if (stats.expectedGoalInvolvements !== undefined) return stats.expectedGoalInvolvements;
  if (stats.expectedGoals === undefined && stats.expectedAssists === undefined) return undefined;
  return (stats.expectedGoals ?? 0) + (stats.expectedAssists ?? 0);
}
function profileAvailabilityLabel(value: Availability): string { return value === "AVAILABLE" ? "Available" : value === "DOUBTFUL" ? "Doubtful" : "Unavailable"; }
function formatProfileDate(value: string | undefined): string {
  if (!value) return "Date TBC";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function matchOutcome(match: PlayerMatchPerformance): "W" | "D" | "L" | "" {
  if (match.teamHomeScore === undefined || match.teamAwayScore === undefined) return "";
  const playerScore = match.isHome ? match.teamHomeScore : match.teamAwayScore;
  const opponentScore = match.isHome ? match.teamAwayScore : match.teamHomeScore;
  return playerScore > opponentScore ? "W" : playerScore < opponentScore ? "L" : "D";
}
function matchScoreline(match: PlayerMatchPerformance, teamShortName: string): string {
  if (match.teamHomeScore === undefined || match.teamAwayScore === undefined) return `${teamShortName} — ${match.opponentShortName}`;
  return match.isHome
    ? `${teamShortName} ${match.teamHomeScore}–${match.teamAwayScore} ${match.opponentShortName}`
    : `${match.opponentShortName} ${match.teamHomeScore}–${match.teamAwayScore} ${teamShortName}`;
}

export function ModeChooserPreview() { return null; }
