"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import WorkspaceSwitcher from "@/components/terminal/WorkspaceSwitcher";
import type { NailedRating, Player, PlayerFixture, PlayerMatchPerformance, PlayerProfileData, PlayerSelection, Position, SelectionEvidence, SimulationResult, SingleTransferSuggestion, SquadState, TransferBaseline, WeeklyLineupPlan } from "@/types";
import { simulateChange as simulateSquadChange } from "@/lib/analysis/simulateChange";
import { explainIllegalSelection, maxSafePriceForPosition } from "@/lib/squad/budget";
import { expectedAutosubValue, pickWeeklyTeam, projectWeeklyLineupHorizons, scoreLineupWithChip, weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import { ChipSelector, ChipStrategyPanel, usePlanningWeekFinance } from "@/components/terminal/ChipPanels";
import type { ChipKind } from "@/types/chips";
import type { OptimizerResult } from "@/lib/optimizer/optimizer";
import { projectPlayer, projectedPointsForGameweeks } from "@/lib/projections/projectPlayer";
import { valuePerMillion } from "@/lib/projections/metrics";
import {
  exportTerminalState,
  parseSavedState,
  deriveStartingXI,
  useTerminalStore,
  type ApplyLineupInput,
  type DesktopPanel,
  type TerminalFilters,
  type TerminalMode,
  type SortKey,
} from "@/store/terminalStore";

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

type TerminalPlayer = Player & {
  projection: NonNullable<Player["projection"]>;
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

function normalizeProjectionFixtures(value: unknown): NonNullable<Player["projection"]>["fixtures"] {
  return arrayOf(value).flatMap((item) => {
    const projection = objectOf(item);
    const fixture = objectOf(readField(projection, "fixture"));
    const gameweek = numberOf(readField(projection, "gameweek", "event")) ?? numberOf(readField(fixture, "gameweek", "event"));
    const expectedPoints = numberOf(readField(projection, "expectedPoints", "expected_points"));
    const expectedMinutes = numberOf(readField(projection, "expectedMinutes", "expected_minutes"));
    const opponentTeamId = numberOf(readField(fixture, "opponentTeamId", "opponent_team_id"));
    const opponentShortName = stringOf(readField(fixture, "opponentShortName", "opponent_short_name"));
    const isHome = readField(fixture, "isHome", "is_home");
    if (gameweek === undefined || expectedPoints === undefined || expectedMinutes === undefined || opponentTeamId === undefined || !opponentShortName || typeof isHome !== "boolean") return [];
    return [{
      gameweek,
      expectedPoints,
      expectedMinutes,
      fixture: { gameweek, opponentTeamId, opponentShortName, isHome, difficulty: numberOf(readField(fixture, "difficulty")) },
    }];
  });
}

function normalizePlayer(value: unknown, index: number): TerminalPlayer | null {
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
  const projection = {
    playerId: id,
    fixtures: normalizeProjectionFixtures(readField(projectionRaw, "fixtures")),
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
  const fixtures: PlayerFixture[] = arrayOf(readField(raw, "fixtures")).flatMap((value) => {
    const fixture = objectOf(value);
    const gameweek = numberOf(readField(fixture, "gameweek", "event"));
    const opponentTeamId = numberOf(readField(fixture, "opponentTeamId", "opponent_team_id"));
    const opponentShortName = stringOf(readField(fixture, "opponentShortName", "opponent_short_name"));
    const isHome = readField(fixture, "isHome", "is_home");
    return gameweek !== undefined && opponentTeamId !== undefined && opponentShortName && typeof isHome === "boolean"
      ? [{ gameweek, opponentTeamId, opponentShortName, isHome, difficulty: numberOf(readField(fixture, "difficulty")) }]
      : [];
  });
  return {
    id,
    firstName,
    lastName,
    displayName,
    teamId: numberOf(readField(raw, "teamId", "team", "team_id")) ?? numberOf(readField(team, "id")) ?? 0,
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
  const players = (playersRaw.length ? playersRaw : dataPlayers)
    .map(normalizePlayer)
    .filter((player): player is TerminalPlayer => player !== null)
    .map((player) => ({ ...player, projection: player.projection && (player.projection.nextGW || player.projection.next3 || player.projection.next5 || player.projection.next10) ? player.projection : projectPlayer(player, { currentGameweek: 1, horizon: 5 }) }));
  const events = arrayOf(readField(root, "events", "event")).length ? arrayOf(readField(root, "events", "event")) : arrayOf(readField(data, "events", "event"));
  const currentEvent = events.map(objectOf).find((event): event is UnknownRecord => Boolean(event && (event.isCurrent === true || event.is_current === true || event.isNext === true || event.is_next === true)));
  const gameweek = numberOf(readField(root, "gameweek", "currentGameweek", "current_gameweek")) ?? numberOf(readField(data, "gameweek", "currentGameweek", "current_gameweek")) ?? numberOf(readField(metadata, "currentGameweek", "current_gameweek", "gameweek")) ?? numberOf(currentEvent ? readField(currentEvent, "id", "event") : undefined) ?? null;
  const deadline = stringOf(readField(root, "deadline", "deadlineTime", "nextDeadline", "next_deadline")) ?? stringOf(readField(data, "deadline", "deadlineTime", "nextDeadline")) ?? stringOf(currentEvent ? readField(currentEvent, "deadlineTime", "deadline_time") : undefined) ?? null;
  return { players, gameweek, deadline, source: stringOf(readField(root, "source", "dataSource")) ?? stringOf(readField(data, "source")) ?? null, freshness: "LIVE", fetchedAt: null };
}

function money(tenths: number | undefined): string {
  return tenths === undefined || !Number.isFinite(tenths) ? "—" : `£${(tenths / 10).toFixed(1)}`;
}

function points(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) || value === 0 ? "—" : value.toFixed(1);
}

function metric(value: number | undefined, suffix = ""): string {
  return value === undefined || !Number.isFinite(value) || value === 0 ? "—" : `${value.toFixed(1)}${suffix}`;
}

function availabilityOf(player: TerminalPlayer): TerminalFilters["availability"] {
  const status = player.status.trim().toLowerCase();
  if (["i", "u", "n", "s"].includes(status)) return "UNAVAILABLE";
  if (status === "d") return "DOUBTFUL";
  if (typeof player.chanceOfPlaying === "number" && player.chanceOfPlaying < 75) return "DOUBTFUL";
  return "AVAILABLE";
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

function expectedInvolvementPer90(player: TerminalPlayer): string {
  const minutes = player.current.minutes;
  const expectedGoals = player.current.expectedGoals;
  const expectedAssists = player.current.expectedAssists;
  if (minutes <= 0 || expectedGoals === undefined || expectedAssists === undefined || !Number.isFinite(expectedGoals + expectedAssists)) {
    const historical = player.historical?.xGIPer90;
    return historical !== undefined && Number.isFinite(historical) ? historical.toFixed(2) : "—";
  }
  return ((expectedGoals + expectedAssists) / minutes * 90).toFixed(2);
}

function FixtureRun({ player, gameweek }: { player: TerminalPlayer; gameweek: number }) {
  const fixtures = player.fixtures.filter((fixture) => fixture.gameweek >= gameweek).slice(0, 12);
  if (!fixtures.length) return <>—</>;
  return <span className="fixture-run">{fixtures.map((fixture) => <span className={(fixture.difficulty ?? 3) <= 2 ? "easy" : (fixture.difficulty ?? 3) >= 4 ? "hard" : ""} key={`${fixture.gameweek}-${fixture.opponentTeamId}`}>{fixture.opponentShortName}({fixture.isHome ? "H" : "A"})</span>)}</span>;
}

type UniverseWeekMetrics = { xp: number; minutes: number; next5: number; value: number };

/** Market metrics for the planning gameweek, derived from the same weekly-lineup engine the squad uses. */
function universeWeekFor(player: TerminalPlayer, gameweek: number): UniverseWeekMetrics {
  const week = weeklyPlayerMetrics(player, gameweek);
  const next5 = projectedPointsForGameweeks(player.projection?.fixtures ?? [], gameweek, 5);
  return { xp: week.points, minutes: week.minutes, next5, value: valuePerMillion(next5, player.priceTenths) };
}

function squadFixturesForGameweek(player: TerminalPlayer, gameweek: number): PlayerFixture[] {
  const projectedFixtures = player.projection?.fixtures ?? [];
  if (projectedFixtures.length) return projectedFixtures.filter((fixture) => fixture.gameweek === gameweek).map((fixture) => fixture.fixture);
  return player.fixtures.filter((fixture) => fixture.gameweek === gameweek);
}

function SquadFixtureBadges({ player, gameweek }: { player: TerminalPlayer; gameweek: number }) {
  const fixtures = squadFixturesForGameweek(player, gameweek);
  return <span className="squad-fixture-badges" aria-label={`Gameweek ${gameweek} fixtures`}>
    {fixtures.length ? fixtures.map((fixture) => <span className={(fixture.difficulty ?? 3) <= 2 ? "easy" : (fixture.difficulty ?? 3) >= 4 ? "hard" : ""} key={`${fixture.gameweek}-${fixture.opponentTeamId}`}>{fixture.opponentShortName}({fixture.isHome ? "H" : "A"})</span>) : <span className="blank">BLANK</span>}
  </span>;
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

function persistedLineupPlan(
  base: WeeklyLineupPlan,
  starters: readonly number[],
  benchGoalkeeperId: number | undefined,
  benchOrder: readonly number[],
  captainId: number | undefined,
  viceCaptainId: number | undefined,
  playerById: Map<number, TerminalPlayer>,
): WeeklyLineupPlan {
  const formation = starters.reduce((result, id) => {
    const position = playerById.get(id)?.position;
    if (position) result[position] += 1;
    return result;
  }, { GK: 0, DEF: 0, MID: 0, FWD: 0 });
  const projectedXI = starters.reduce((sum, id) => {
    const player = playerById.get(id);
    return sum + (player ? weeklyPlayerMetrics(player, base.gameweek).points : 0);
  }, 0);
  const captain = captainId === undefined ? undefined : playerById.get(captainId);
  const captainBonus = captain ? weeklyPlayerMetrics(captain, base.gameweek).points : 0;
  const squadIds = new Set([...starters, benchGoalkeeperId, ...benchOrder]);
  const squad = [...playerById.values()].filter((player) => squadIds.has(player.id));
  const autosubValue = benchGoalkeeperId !== undefined && benchOrder.length === 3
    ? expectedAutosubValue(starters, benchGoalkeeperId, benchOrder, squad, base.gameweek)
    : 0;
  return {
    gameweek: base.gameweek,
    starterIds: [...starters],
    formation: `${formation.DEF}-${formation.MID}-${formation.FWD}`,
    benchGoalkeeperId: benchGoalkeeperId ?? 0,
    benchOrder: [...benchOrder] as [number, number, number],
    captainId: captainId ?? 0,
    viceCaptainId: viceCaptainId ?? 0,
    projectedXI,
    captainBonus,
    projectedTotal: projectedXI + captainBonus + autosubValue,
    autosubValue,
    explanations: base.explanations,
    warnings: base.warnings,
    projectionFingerprint: base.projectionFingerprint,
  };
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
  const [state, setState] = useState<{ data: Bootstrap; status: DataState; message?: string; ageAnchor: DataAgeAnchor | null; refresh: () => void }>({ data: { players: [], gameweek: null, deadline: null, source: null, freshness: "LIVE", fetchedAt: null }, status: "SYNCING", ageAnchor: null, refresh: () => setRefreshCount((value) => value + 1) });
  useEffect(() => {
    const controller = new AbortController();
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
        const errors = arrayOf(root.errors).filter((error): error is string => typeof error === "string");
        const freshnessLabel = classifyFreshness({
          stale: readField(freshness, "stale", "isStale"),
          source: [stringOf(readField(freshness, "source", "dataSource")), normalized.source].filter(Boolean).join(" "),
          errors,
        });
        return { data: { ...normalized, freshness: freshnessLabel, fetchedAt }, errors, ageAnchor };
      })
      .then(({ data, errors, ageAnchor }) => setState((current) => ({ ...current, data, status: data.players.length ? data.freshness : "EMPTY", message: errors[0] ?? (data.players.length ? undefined : "The FPL response contained no player records."), ageAnchor })))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({ ...current, data: { players: [], gameweek: null, deadline: null, source: null, freshness: "LIVE", fetchedAt: null }, status: "ERROR", message: error instanceof Error ? error.message : "FPL data is unavailable.", ageAnchor: null }));
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
  const [simulationMove, setSimulationMove] = useState<{ outId: number; inId: number } | null>(null);
  const [gwSwapSelection, setGWSwapSelection] = useState<{ starterId?: number; benchId?: number }>({});
  const [mobilePickedId, setMobilePickedId] = useState<number | null>(null);
  const isMobileLineup = useMatchMedia("(max-width: 900px)");
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const settingsRef = useRef<HTMLDetailsElement>(null);
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
    const availableWidth = grid.getBoundingClientRect().width - (DESKTOP_PANELS.length - 1);
    const widths = DESKTOP_PANELS.map((name) => grid.querySelector<HTMLElement>(`[data-panel="${name}"]`)?.getBoundingClientRect().width ?? 0);
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
    useTerminalStore.getState().hydrate(raw ? parseSavedState(raw) : null);
  }, []);

  useEffect(() => {
    if (!store.isHydrated || data.gameweek === null) return;
    initializeGameweek(liveCurrentGW);
  }, [data.gameweek, initializeGameweek, liveCurrentGW, store.isHydrated]);

  useEffect(() => {
    const state = useTerminalStore.getState();
    if (!state.isHydrated) return;
    window.localStorage.setItem("fpl-terminal-state", JSON.stringify(exportTerminalState(state)));
  }, [store.gameweekPlans, store.planningGameweek, store.currentGameweek, store.isHydrated, store.mode, store.entryId, store.budgetTenths, store.playerIds, store.byPosition, store.benchGoalkeeperId, store.benchOrder, store.lineupGameweek, store.lineupProjectionFingerprint, store.lockedPlayerIds, store.captainId, store.viceCaptainId, store.horizon, store.transferHorizon, store.riskMode, store.benchStrategy, store.panelRatios, store.dismissedTransferKeys, store.chip, store.plannedTransfers, store.permanentSquad, store.transferBaseline, store.usedChips]);

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
  const spent = useMemo(() => selected.reduce((sum, player) => sum + player.priceTenths, 0), [selected]);
  const bankTenths = store.budgetTenths - spent;
  const slotMaxPrices = useMemo(() => POSITIONS.reduce((result, position) => {
    result[position] = maxSafePriceForPosition(position, selected, data.players);
    return result;
  }, {} as Record<Position, number>), [data.players, selected]);
  const weeklyEnginePlan = useMemo(() => pickWeeklyTeam({
    squad: selected,
    gameweek: planningGameweek,
    riskMode: store.riskMode,
  }), [planningGameweek, selected, store.riskMode]);
  const lineupApplied = store.lineupGameweek === planningGameweek && store.lineupProjectionFingerprint !== undefined;
  const currentGWPlan = useMemo<WeeklyLineupPlan | null>(() => {
    if (!lineupApplied || store.benchGoalkeeperId === undefined || store.benchOrder.length !== 3) {
      return weeklyEnginePlan.starterIds.length === 11 ? weeklyEnginePlan : null;
    }
    const startingXI = deriveStartingXI(store.playerIds, store.benchGoalkeeperId, store.benchOrder);
    return persistedLineupPlan(weeklyEnginePlan, startingXI, store.benchGoalkeeperId, store.benchOrder, store.captainId, store.viceCaptainId, playerById);
  }, [lineupApplied, playerById, store.benchGoalkeeperId, store.benchOrder, store.captainId, store.playerIds, store.viceCaptainId, weeklyEnginePlan]);
  // The chip is part of the projection fingerprint: changing chips makes an
  // applied lineup stale.
  const chipAwareFingerprint = useMemo(() => pickWeeklyTeam({
    squad: selected,
    gameweek: planningGameweek,
    riskMode: store.riskMode,
    chip: store.chip,
  }).projectionFingerprint, [planningGameweek, selected, store.riskMode, store.chip]);
  const lineupStale = lineupApplied && (store.lineupGameweek !== weeklyEnginePlan.gameweek || store.lineupProjectionFingerprint !== chipAwareFingerprint);
  const weekFinance = usePlanningWeekFinance(data.players, planningGameweek);
  const chipNetXp = useMemo(() => {
    if (selected.length !== 15) return undefined;
    const saved = lineupApplied && store.benchGoalkeeperId !== undefined && store.benchOrder.length === 3 && store.captainId !== undefined && store.viceCaptainId !== undefined
      ? { starterIds: deriveStartingXI(store.playerIds, store.benchGoalkeeperId, store.benchOrder), benchGoalkeeperId: store.benchGoalkeeperId, benchOrder: store.benchOrder, captainId: store.captainId, viceCaptainId: store.viceCaptainId }
      : undefined;
    const plan = scoreLineupWithChip(selected, planningGameweek, store.riskMode, store.chip, saved);
    return plan.projectedTotal - (weekFinance?.hitCost ?? 0);
  }, [selected, planningGameweek, store.riskMode, store.chip, lineupApplied, store.playerIds, store.benchGoalkeeperId, store.benchOrder, store.captainId, store.viceCaptainId, weekFinance]);
  const projected = useMemo<{ nextGW?: number; next3?: number; next5?: number; next10?: number }>(() => {
    if (!selected.length) return {};
    if (weeklyEnginePlan.starterIds.length !== 11) return aggregateWeeklyProjection(selected, planningGameweek);
    return projectWeeklyLineupHorizons({
      squad: selected,
      gameweek: planningGameweek,
      riskMode: store.riskMode,
    }, !lineupStale ? currentGWPlan ?? undefined : undefined);
  }, [currentGWPlan, lineupStale, planningGameweek, selected, store.riskMode, weeklyEnginePlan.starterIds.length]);
  const risk = useMemo(() => {
    if (!selected.length) return undefined;
    const values = selected.map((player) => weeklyPlayerMetrics(player, planningGameweek).pDNP);
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) : undefined;
  }, [planningGameweek, selected]);
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
  const transferRequestKey = selected.length === 15
    ? `${store.playerIds.join(",")}|${store.lockedPlayerIds.join(",")}|${store.budgetTenths}|${store.transferHorizon}|${store.riskMode}|${planningGameweek}`
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
        horizon: store.transferHorizon,
        risk: store.riskMode,
        gameweek: planningGameweek,
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
  }, [planningGameweek, store.budgetTenths, store.transferHorizon, store.lockedPlayerIds, store.playerIds, store.riskMode, transferRequestKey]);
  const dismissedTransferKeys = new Set(store.dismissedTransferKeys);
  const transferSuggestions = transferRequestKey && transferSearch.key === transferRequestKey
    ? transferSearch.suggestions.filter((move) => !dismissedTransferKeys.has(`${move.outgoingPlayerId}:${move.incomingPlayerId}`))
    : [];
  const transferSuggestionState: "INCOMPLETE" | "LOADING" | "READY" | "ERROR" = !transferRequestKey ? "INCOMPLETE" : transferSearch.key === transferRequestKey ? transferSearch.state : "LOADING";
  const transferSuggestionMessage = transferSearch.key === transferRequestKey ? transferSearch.message : null;

  const universeWeeks = useMemo(() => {
    const byId = new Map<number, UniverseWeekMetrics>();
    for (const player of data.players) byId.set(player.id, universeWeekFor(player, planningGameweek));
    return byId;
  }, [data.players, planningGameweek]);

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
        next5: (player) => week(player)?.next5 ?? 0,
        value: (player) => week(player)?.value ?? 0,
        ownership: (player) => player.ownership,
        risk: (player) => player.projection?.riskScore ?? 0,
      };
      const left = values[store.sortKey](a);
      const right = values[store.sortKey](b);
      const result = typeof left === "string" && typeof right === "string" ? left.localeCompare(right) : Number(left) - Number(right);
      return store.sortDirection === "asc" ? result : -result;
    });
  }, [bankTenths, data.players, store.filters, store.playerIds, store.search, store.sortDirection, store.sortKey, universeWeeks]);

  const addPlayer = useCallback((player: TerminalPlayer) => {
    const explanation = explainIllegalSelection(player, selected, data.players);
    if (!explanation.legal) {
      setNotice(explanation.message);
      return;
    }
    if (useTerminalStore.getState().addPlayer(player.id, player.position)) {
      useTerminalStore.getState().setSelectedPlayer(undefined);
      setNotice(`${player.displayName} added to ${player.position}.`);
    } else {
      setNotice(`No open ${player.position} slot, or the squad already contains this player.`);
    }
  }, [data.players, selected, setNotice]);

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
          gameweek: planningGameweek,
          horizon: store.horizon,
          risk: store.riskMode,
          bench: store.benchStrategy,
        }),
      });
      const result = await response.json() as OptimizerResult & { error?: string };
      if (!response.ok || !result.legal || !result.squad) {
        setNotice(result.errors?.[0] ?? result.error ?? "No legal squad could be found with the current locks and budget.");
        return;
      }
      store.hydrate({ squad: result.squad, lockedPlayerIds: store.lockedPlayerIds, horizon: store.horizon, riskMode: store.riskMode, benchStrategy: store.benchStrategy });
      setNotice(complete ? "Exact optimizer completed the remaining squad." : "Exact optimizer applied the guaranteed-best legal squad.");
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
    if (store.captainId === starterId || store.viceCaptainId === starterId) {
      setNotice("Choose a different captain or vice-captain before moving that starter to the bench.");
      setGWSwapSelection({});
      return;
    }
    if (!store.swapStarterBench(starterId, benchId)) {
      setNotice("That swap would leave an invalid starting formation. Pick a compatible player.");
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

  const simulateMove = (outId: number, inId: number) => {
    const result = simulateSquadChange({
      squad: store.playerIds,
      players: data.players,
      outId,
      inId,
      gameweek: planningGameweek,
      horizon: store.transferHorizon,
      risk: store.riskMode,
      bench: store.benchStrategy,
      budgetTenths: store.budgetTenths,
    });
    setSimulationMove({ outId, inId });
    setSimulation(result);
  };

  const applySimulation = () => {
    if (!simulationMove) return;
    const outgoing = playerById.get(simulationMove.outId);
    const incoming = playerById.get(simulationMove.inId);
    if (!outgoing || !incoming || store.lockedPlayerIds.includes(outgoing.id)) {
      setNotice("That move cannot be applied while the outgoing player is locked.");
      return;
    }
    const checked = simulateSquadChange({
      squad: store.playerIds,
      players: data.players,
      outId: outgoing.id,
      inId: incoming.id,
      gameweek: planningGameweek,
      horizon: store.transferHorizon,
      risk: store.riskMode,
      bench: store.benchStrategy,
      budgetTenths: store.budgetTenths,
    });
    if (!checked.legal || !store.replacePlayer(outgoing.id, incoming.id, incoming.position)) {
      setNotice("That transfer is no longer legal for the current squad.");
      return;
    }
    store.setSelectedPlayer(undefined);
    setSimulation(null);
    setSimulationMove(null);
    setNotice(`${outgoing.displayName} → ${incoming.displayName} applied.`);
  };

  const changePlanningGameweek = (target: number) => {
    const bounded = clamp(Math.round(target), liveCurrentGW, 38);
    if (bounded === planningGameweek) return;
    if (store.switchGameweek(bounded) === false) return;
    setGWSwapSelection({});
    setSimulation(null);
    setSimulationMove(null);
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
      const fingerprint = pickWeeklyTeam({ squad: importedPlayers, gameweek: liveCurrentGW, riskMode: store.riskMode }).projectionFingerprint;
      if (!fingerprint || !store.replaceSquad(body.data.squad, { ...body.data.lineup, lineupProjectionFingerprint: fingerprint }, entryId, body.data.budgetTenths, { transferBaseline: body.data.transferBaseline ?? null, usedChips: body.data.usedChips ?? [] })) throw new Error("FPL returned an invalid 15-player squad.");
      store.switchGameweek(liveCurrentGW);
      setGWSwapSelection({});
      setSimulation(null);
      setSimulationMove(null);
      setNotice(`Official Gameweek ${liveCurrentGW} squad restored. Future plans cleared.`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Official FPL squad restore failed.");
    } finally {
      setReverseBusy(false);
    }
  };

  const reset = () => {
    if (window.confirm("Reset the current squad and saved terminal state?")) {
      store.reset();
      window.localStorage.removeItem("fpl-terminal-state");
      setNotice("Terminal state reset.");
    }
  };

  if (!store.isHydrated) return <main className="mode-screen" aria-busy="true" />;
  if (store.mode === null) {
    return <ModeChooser status={status} message={message} gameweek={data.gameweek} onChoose={store.setMode} />;
  }
  if (store.mode === "ANALYZE" && !store.entryId) {
    return <TeamImportScreen
      players={data.players}
      gameweek={liveCurrentGW}
      onBack={() => store.setMode(null)}
      onImport={(result) => {
        const importedPlayers = data.players.filter((player) => result.squad.playerIds.includes(player.id));
        const fingerprint = pickWeeklyTeam({ squad: importedPlayers, gameweek: result.lineup.gameweek, riskMode: store.riskMode }).projectionFingerprint;
        if (!store.replaceSquad(result.squad, { ...result.lineup, lineupProjectionFingerprint: fingerprint }, result.entryId, result.budgetTenths, { transferBaseline: result.transferBaseline ?? null, usedChips: result.usedChips ?? [] })) return false;
        if (result.importWarnings?.length) setNotice(result.importWarnings[0]);
        else setNotice(`Imported ${result.teamName || result.managerName || `FPL team ${result.entryId}`}.`);
        return true;
      }}
    />;
  }

  const selectedPlayer = store.selectedPlayerId ? playerById.get(store.selectedPlayerId) : undefined;
  const gridStyle = Object.fromEntries(DESKTOP_PANELS.flatMap((panel) => {
    const value = collapsedPanels[panel] ? "52px" : store.panelRatios[panel] ? `${store.panelRatios[panel]}fr` : undefined;
    return value ? [[`--${panel}-column`, value]] : [];
  })) as CSSProperties;
  const resetFilters = () => {
    store.setSearch("");
    store.setFilters({ position: "ALL", club: "", minPrice: "", maxPrice: "", minOwnership: "", maxOwnership: "", availability: "ALL", confidence: "ALL", risk: "ALL", affordableOnly: false, excludeSelected: false, quick: "ALL" });
  };
  const openPlayer = (playerId: number) => {
    store.setMobileTab("MARKET");
    store.setSelectedPlayer(playerId);
  };
  const activateSquadSlot = (player: TerminalPlayer, starter: boolean) => {
    if (!isMobileLineup) {
      openPlayer(player.id);
      return;
    }
    if (currentGWPlan) {
      if (starter && gwSwapSelection.benchId !== undefined && gwSwapSelection.starterId === undefined) {
        selectGWSwapPlayer("starter", player.id);
        setMobilePickedId(null);
        return;
      }
      if (!starter && gwSwapSelection.starterId !== undefined && gwSwapSelection.benchId === undefined) {
        selectGWSwapPlayer("bench", player.id);
        setMobilePickedId(null);
        return;
      }
    }
    setMobilePickedId((current) => (current === player.id ? null : player.id));
  };
  const removeSquadPlayer = (player: TerminalPlayer) => {
    if (store.lockedPlayerIds.includes(player.id)) {
      setNotice(`${player.displayName} is locked. Unlock them before removing.`);
      return false;
    }
    return store.removePlayer(player.id);
  };
  const renderSquadPlayer = (player: TerminalPlayer, starter: boolean, benchLabel?: string) => {
    const benchIndex = (lineupApplied && store.benchOrder.length === 3 ? store.benchOrder : currentGWPlan?.benchOrder ?? []).indexOf(player.id);
    const swapSelected = benchLabel ? gwSwapSelection.benchId === player.id : gwSwapSelection.starterId === player.id;
    return <SquadSlot key={player.id} player={player} gameweek={planningGameweek} locked={store.lockedPlayerIds.includes(player.id)} captain={(lineupApplied ? store.captainId : currentGWPlan?.captainId) === player.id} vice={(lineupApplied ? store.viceCaptainId : currentGWPlan?.viceCaptainId) === player.id} starter={starter} benchLabel={benchLabel} benchIndex={benchIndex} lineupActive={Boolean(currentGWPlan)} swapSelected={swapSelected} picked={mobilePickedId === player.id} chip={store.chip} onRemove={() => removeSquadPlayer(player)} onToggleLock={() => store.toggleLock(player.id)} onActivate={() => activateSquadSlot(player, starter)} onSwap={() => selectGWSwapPlayer(benchLabel ? "bench" : "starter", player.id)} onCaptain={() => makeGWCaptain(player.id)} onViceCaptain={() => makeGWViceCaptain(player.id)} onMoveBench={(direction) => moveGWBench(player.id, direction)} />;
  };
  const choosePlayer = (position: Position) => {
    const maxPriceTenths = slotMaxPrices[position];
    store.setFilters({ position, maxPrice: (maxPriceTenths / 10).toFixed(1) });
    store.setMobileTab("MARKET");
    searchRef.current?.focus();
  };
  const draftBenchSlots: Array<{ id?: number; position: Position; label: string }> = [
    { id: store.byPosition.GK[1], position: "GK", label: "BGK" },
    { id: store.byPosition.DEF[3], position: "DEF", label: "B1" },
    { id: store.byPosition.DEF[4], position: "DEF", label: "B2" },
    { id: store.byPosition.MID[4], position: "MID", label: "B3" },
  ];
  const benchSlots = currentGWPlan
    ? [currentGWPlan.benchGoalkeeperId, ...currentGWPlan.benchOrder].map((id, index) => ({ id, position: playerById.get(id)?.position ?? (index === 0 ? "GK" : "DEF"), label: index === 0 ? "BGK" : `B${index}` } as const))
    : draftBenchSlots;
  const draftStarterCount = POSITIONS.reduce((sum, position) => sum + Math.min(store.byPosition[position].length, DRAFT_XI_COUNTS[position]), 0);
  const mobilePickedPlayer = mobilePickedId === null ? undefined : playerById.get(mobilePickedId);
  const mobilePickedBenchSlot = mobilePickedPlayer ? benchSlots.find((slot) => slot.id === mobilePickedPlayer.id) : undefined;
  const mobilePickedStarter = mobilePickedPlayer ? !mobilePickedBenchSlot && (currentGWPlan ? currentGWPlan.starterIds.includes(mobilePickedPlayer.id) : true) : false;
  const mobilePickedBenchIndex = mobilePickedPlayer ? (lineupApplied && store.benchOrder.length === 3 ? store.benchOrder : currentGWPlan?.benchOrder ?? []).indexOf(mobilePickedPlayer.id) : -1;
  return (
    <main className="terminal-app">
      <header className="topbar">
        <button className="brand" onClick={() => store.setMode(null)} aria-label="Return to mode chooser"><span className="brand-mark">FPL</span><span>TERMINAL</span></button>
        <WorkspaceSwitcher />
        <div className="topbar-stats" aria-label="Terminal status">
          <StatusCell label="GW" value={data.gameweek ? String(data.gameweek) : "—"} />
          <DeadlineStatus deadline={data.deadline} />
          <DataStatusCell status={status} ageAnchor={ageAnchor} fetchedAt={data.fetchedAt} />
        </div>
        <div className="topbar-actions"><button className="text-button" onClick={refresh}>REFRESH</button><button className="text-button" onClick={() => exportState(store)}>EXPORT</button><button className="text-button" onClick={() => importRef.current?.click()}>IMPORT</button><button className="text-button danger-text" onClick={reset}>RESET</button><input ref={importRef} type="file" accept="application/json" hidden onChange={(event) => importState(event, store)} /></div>
      </header>

      <nav className="mobile-tabs" aria-label="Terminal panels">{(["SQUAD", "MARKET"] as const).map((tab) => <button key={tab} className={store.activeMobileTab === tab ? "active" : ""} onClick={() => store.setMobileTab(tab)}>{tab}</button>)}</nav>

      <div className="terminal-grid" style={gridStyle}>
        <section id="terminal-panel-market" data-panel="market" className={`market-column ${collapsedPanels.market ? "panel-collapsed" : ""} ${store.activeMobileTab === "MARKET" ? "mobile-visible" : ""}`} aria-label="Player universe">
          <div className="panel-header"><div><span className="section-kicker">PLAYER UNIVERSE</span><span className="panel-count">{data.players.length || "—"} records</span></div><div className="header-actions"><span className={`data-badge ${status.toLowerCase()}`}>{status === "LIVE" ? "LIVE FPL" : status === "SYNCING" ? "SYNCING" : "NO LIVE DATA"}</span><PanelToggle panel="market" collapsed={collapsedPanels.market} onToggle={() => togglePanel("market")} /></div></div>
          <div className="search-wrap"><span aria-hidden="true">/</span><input ref={searchRef} value={store.search} onChange={(event) => store.setSearch(event.target.value)} placeholder="Search player, club..." aria-label="Search players" /><kbd>/</kbd></div>
          <FilterBar filters={store.filters} setFilters={store.setFilters} players={data.players} onReset={resetFilters} />
          <div className="table-wrap"><table className="player-table"><thead><tr><SortableHead label="PLAYER" sortKey="name" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><th>POS</th><SortableHead label="PRICE" sortKey="price" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="OWN%" sortKey="ownership" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="FORM" sortKey="form" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="XP GW" sortKey="nextGW" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="XP5" sortKey="next5" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="XP/£" sortKey="value" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><th>EXP MIN</th><th>XGI/90</th><th>RISK</th><th>FIXTURES</th><th>ADD</th></tr></thead><tbody>{filteredPlayers.slice(0, 250).map((player) => <PlayerRow key={player.id} player={player} week={universeWeeks.get(player.id) ?? universeWeekFor(player, planningGameweek)} gameweek={planningGameweek} selected={store.playerIds.includes(player.id)} onSelect={() => openPlayer(player.id)} onAdd={() => addPlayer(player)} />)}</tbody></table>{status === "SYNCING" && <div className="empty-state">SYNCING FPL MARKET…</div>}{status !== "SYNCING" && filteredPlayers.length === 0 && <div className="empty-state">{data.players.length ? "No players match these filters." : message ?? "FPL data is unavailable."}</div>}</div>
          {selectedPlayer && <PlayerDetail key={selectedPlayer.id} player={selectedPlayer} gameweek={planningGameweek} inSquad={store.playerIds.includes(selectedPlayer.id)} locked={store.lockedPlayerIds.includes(selectedPlayer.id)} onClose={() => store.setSelectedPlayer(undefined)} onAdd={() => addPlayer(selectedPlayer)} onToggleLock={() => store.toggleLock(selectedPlayer.id)} />}
          <PanelResizer panel="market" onResizeStart={beginPanelResize} />
        </section>

        <section id="terminal-panel-squad" data-panel="squad" className={`squad-column ${collapsedPanels.squad ? "panel-collapsed" : ""} ${store.activeMobileTab === "SQUAD" ? "mobile-visible" : ""}`} aria-label="Squad builder and analysis">
          <div className="panel-header"><div><span className="section-kicker">SQUAD BUILDER</span><span className="panel-count">{selected.length}/15 selected</span></div><div className="header-actions"><details className="strategy-settings" ref={settingsRef}><summary className="compact-action">SETTINGS</summary><div className="strategy-popover"><button type="button" className="icon-button strategy-close" aria-label="Close optimizer settings" onClick={() => { if (settingsRef.current) settingsRef.current.open = false; }}>×</button><StrategyControls horizon={store.horizon} riskMode={store.riskMode} benchStrategy={store.benchStrategy} setStrategy={store.setStrategy} /><div className="settings-divider" /><button type="button" className="settings-danger" disabled={!store.entryId || reverseBusy} onClick={() => void reverseAllChanges()}>{reverseBusy ? "RESTORING…" : "REVERSE ALL CHANGES"}</button>{!store.entryId && <span className="settings-note">Import an FPL team to restore official picks.</span>}</div></details><button className="compact-action" disabled={optimizing} onClick={() => void runOptimize(selected.length < 15)}>{optimizing ? "OPTIMIZING…" : selected.length < 15 ? "COMPLETE SQUAD" : "OPTIMIZE"}</button><button className={`compact-action pick-team-action ${lineupStale ? "stale" : ""}`} onClick={pickGWTeam}>{lineupStale ? "PICK TEAM · OUTDATED" : "PICK TEAM"}</button><PanelToggle panel="squad" collapsed={collapsedPanels.squad} onToggle={() => togglePanel("squad")} /></div></div>
          <div className="planning-stack">
          <div className="planning-toolbar" aria-label="Squad planning Gameweek"><span className="section-kicker">PLAN</span><div className="planning-switcher" role="group" aria-label="Select planning Gameweek"><button type="button" className="planning-arrow" disabled={planningGameweek <= liveCurrentGW} onClick={() => changePlanningGameweek(planningGameweek - 1)} aria-label="Previous planning Gameweek">←</button><span aria-live="polite">GW {planningGameweek}</span><button type="button" className="planning-arrow" disabled={planningGameweek >= 38} onClick={() => changePlanningGameweek(planningGameweek + 1)} aria-label="Next planning Gameweek">→</button></div><span className="planning-live">LIVE GW {liveCurrentGW}</span><ChipSelector gameweek={planningGameweek} onNotice={setNotice} /></div>
          {store.planNotice && <div className="plan-notice" role="status"><span>{store.planNotice}</span><button type="button" className="toast-button" aria-label="Dismiss plan notice" onClick={() => store.clearPlanNotice()}>×</button></div>}
          </div>
          <div className="squad-sections lineup-roster" data-testid="squad-roster">
            <section className="starting-xi" aria-label="Starting XI"><div className="lineup-roster-heading"><span>STARTING XI</span><span>{currentGWPlan ? formationLabel(currentGWPlan) : "3-4-3"} · {currentGWPlan ? 11 : draftStarterCount}/11</span></div>
              {POSITIONS.map((position) => {
                const players = currentGWPlan
                  ? currentGWPlan.starterIds.map((id) => playerById.get(id)).filter((player): player is TerminalPlayer => player?.position === position)
                  : store.byPosition[position].slice(0, DRAFT_XI_COUNTS[position]).map((id) => playerById.get(id)).filter((player): player is TerminalPlayer => Boolean(player));
                const slotCount = currentGWPlan ? players.length : DRAFT_XI_COUNTS[position];
                return <div className="position-section starting-position" key={position}><div className="position-heading"><span>{position}</span><span>{players.length}/{slotCount}</span></div><div className="slot-grid starting-slot-grid" style={{ "--slot-count": slotCount } as CSSProperties}>{Array.from({ length: slotCount }, (_, index) => players[index] ? renderSquadPlayer(players[index], true) : <EmptySlot key={`${position}-${index}`} position={position} maxPriceTenths={slotMaxPrices[position]} onChoose={() => choosePlayer(position)} />)}</div></div>;
              })}
            </section>
            <section className="bench-section" aria-label="Bench"><div className="lineup-roster-heading"><span>BENCH</span><span>BGK · B1 · B2 · B3</span></div><div className="slot-grid bench-slot-grid">{benchSlots.map((slot) => { const player = slot.id ? playerById.get(slot.id) : undefined; return player ? renderSquadPlayer(player, false, slot.label) : <EmptySlot key={slot.label} position={slot.position} maxPriceTenths={slotMaxPrices[slot.position]} onChoose={() => choosePlayer(slot.position)} />; })}</div></section>
          </div>
          <MetricStrip spent={spent} bankTenths={bankTenths} projected={{ ...projected, nextGW: chipNetXp ?? projected.nextGW }} risk={risk} teamRating={teamRating} />
          <TransferSuggestionsPanel suggestions={transferSuggestions} state={transferSuggestionState} message={transferSuggestionMessage} horizon={store.transferHorizon} onHorizon={(transferHorizon) => store.setStrategy({ transferHorizon })} playerById={playerById} onSimulate={simulateMove} onDismiss={store.dismissTransferSuggestion} />
          <ChipStrategyPanel players={data.players} planningGameweek={planningGameweek} onNotice={setNotice} />
          {isMobileLineup && mobilePickedPlayer && <MobileLineupBar player={mobilePickedPlayer} starter={mobilePickedStarter} benchLabel={mobilePickedBenchSlot?.label} benchIndex={mobilePickedBenchIndex} captain={(lineupApplied ? store.captainId : currentGWPlan?.captainId) === mobilePickedPlayer.id} vice={(lineupApplied ? store.viceCaptainId : currentGWPlan?.viceCaptainId) === mobilePickedPlayer.id} locked={store.lockedPlayerIds.includes(mobilePickedPlayer.id)} lineupActive={Boolean(currentGWPlan)} onClose={() => setMobilePickedId(null)} onInfo={() => openPlayer(mobilePickedPlayer.id)} onCaptain={() => makeGWCaptain(mobilePickedPlayer.id)} onViceCaptain={() => makeGWViceCaptain(mobilePickedPlayer.id)} onSwap={() => selectGWSwapPlayer(mobilePickedStarter ? "starter" : "bench", mobilePickedPlayer.id)} onMoveBench={(direction) => moveGWBench(mobilePickedPlayer.id, direction)} onToggleLock={() => store.toggleLock(mobilePickedPlayer.id)} onRemove={() => { if (removeSquadPlayer(mobilePickedPlayer)) setMobilePickedId(null); }} />}
          {simulation && simulationMove && <div className="squad-overlay"><SimulationPanel result={simulation} move={simulationMove} playerById={playerById} onApply={applySimulation} onDiscard={() => { setSimulation(null); setSimulationMove(null); }} /></div>}
          <PanelResizer panel="squad" onResizeStart={beginPanelResize} />
        </section>

      </div>
      {notice && (noticeMinimized
        ? <button type="button" className="toast toast-pill" aria-label="Show notification" onClick={() => setNoticeMinimized(false)}>{notice}</button>
        : <div className="toast" role="status"><span className="toast-message">{notice}</span><span className="toast-actions"><button type="button" className="toast-button" aria-label="Minimize" onClick={() => setNoticeMinimized(true)}>–</button><button type="button" className="toast-button" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button></span></div>)}
    </main>
  );
}

function ModeChooser({ status, message, gameweek, onChoose }: { status: DataState; message?: string; gameweek: number | null; onChoose: (mode: TerminalMode) => void }) {
  return <main className="mode-screen"><div className="mode-brand"><span className="brand-mark" aria-hidden="true" /><span>FPL TERMINAL</span></div><p className="mode-tagline">QUANTITATIVE FPL SQUAD INTELLIGENCE</p><div className="mode-grid"><button className="mode-card" onClick={() => onChoose("BUILD")}><span className="mode-index">MODE A</span><strong>BUILD FROM SCRATCH</strong><span>Start with £100.0m and construct your squad player by player, with live projections reacting to every pick.</span></button><button className="mode-card" onClick={() => onChoose("ANALYZE")}><span className="mode-index">MODE B</span><strong>ANALYZE A TEAM</strong><span>Enter an existing 15-player squad and get immediate analysis: weakest links, budget inefficiencies, and upgrade opportunities.</span></button></div><div className="mode-footer"><span className={`status-pip ${status.toLowerCase()}`} />{status === "LIVE" ? `LIVE DATA · GAMEWEEK ${gameweek ?? "—"} · MODEL ESTIMATES · SQUAD RULES ENFORCED LOCALLY` : status === "SNAPSHOT" ? `SNAPSHOT DATA · GAMEWEEK ${gameweek ?? "—"}` : status === "STALE" ? `STALE DATA · GAMEWEEK ${gameweek ?? "—"}` : status === "SYNCING" ? "SYNCING FPL MARKET…" : message ?? "FPL data is unavailable."}</div><p className="mode-disclaimer">Not affiliated with, endorsed by, or connected to the Premier League or Fantasy Premier League. Player data comes from public FPL endpoints; projections are estimates, not advice.</p></main>;
}

type ImportedTeam = { entryId: number; budgetTenths: number; teamName?: string; managerName?: string; squad: SquadState; lineup: Omit<ApplyLineupInput, "lineupProjectionFingerprint">; transferBaseline?: TransferBaseline | null; usedChips?: Array<{ kind: ChipKind; gameweek: number }>; financialConfidence?: "EXACT" | "ESTIMATED"; importWarnings?: string[] };

function TeamImportScreen({ players, gameweek, onImport, onBack }: { players: TerminalPlayer[]; gameweek: number; onImport: (result: ImportedTeam) => boolean; onBack: () => void }) {
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
  return <main className="mode-screen import-screen"><button type="button" className="import-back" onClick={onBack}>← BACK</button><div className="mode-brand"><span className="brand-mark" aria-hidden="true" /><span>FPL TERMINAL</span></div><p className="mode-tagline">IMPORT YOUR OFFICIAL FPL TEAM</p><form className="import-card" onSubmit={submit}><label htmlFor="fpl-entry-id">ENTER FPL ID</label><div className="import-controls"><input id="fpl-entry-id" inputMode="numeric" pattern="[0-9]*" autoFocus value={entryId} onChange={(event) => setEntryId(event.target.value)} placeholder="4827193" /><button className="primary-button" type="submit" disabled={busy || !players.length}>{busy ? "IMPORTING…" : "IMPORT TEAM"}</button></div><p>We’ll load Gameweek {gameweek} picks from the official FPL API and fill all 15 squad positions.</p>{!players.length && <span className="import-error" role="status">Waiting for the FPL player list…</span>}{error && <span className="import-error" role="alert">{error}</span>}</form></main>;
}

function StatusCell({ label, value, tone }: { label: string; value: string; tone?: "amber" | "green" | "red" | "cyan" }) { return <div className="status-cell"><span>{label}</span><strong className={tone ?? ""}>{value}</strong></div>; }

function DataStatusCell({ status, ageAnchor, fetchedAt }: { status: DataState; ageAnchor: DataAgeAnchor | null; fetchedAt: string | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const value = status === "LIVE" ? "● LIVE" : status === "SNAPSHOT" ? "● SNAPSHOT" : status === "STALE" ? "● STALE" : status === "SYNCING" ? "● SYNC" : "● OFFLINE";
  const ageMs = computeDataAgeMs(now, ageAnchor, fetchedAt);
  const ageText = ageMs !== null ? formatDataAge(ageMs) : "";
  return <div className="status-cell"><span>DATA</span><strong className={status === "LIVE" ? "green" : status === "ERROR" ? "red" : "amber"}>{value}{ageText ? ` · ${ageText}` : ""}</strong></div>;
}

function DeadlineStatus({ deadline }: { deadline: string | null }) {
  const [countingDown, setCountingDown] = useState(true);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!countingDown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [countingDown]);
  if (!deadline) return <StatusCell label="DEADLINE" value="—" />;
  return <button type="button" className="status-cell status-cell-button" aria-pressed={countingDown} title={countingDown ? "Show deadline date" : "Show deadline countdown"} onClick={() => { setNow(Date.now()); setCountingDown((value) => !value); }}><span>DEADLINE</span><strong>{countingDown ? formatDeadlineCountdown(deadline, now) : formatDeadline(deadline)}</strong></button>;
}

function PanelToggle({ panel, collapsed, onToggle }: { panel: DesktopPanel; collapsed: boolean; onToggle: () => void }) {
  return <button type="button" className="panel-collapse" aria-expanded={!collapsed} aria-controls={`terminal-panel-${panel}`} aria-label={`${collapsed ? "Expand" : "Minimize"} ${PANEL_LABELS[panel]}`} onClick={onToggle}>{collapsed ? "+" : "−"}</button>;
}

function PanelResizer({ panel, onResizeStart }: { panel: DesktopPanel; onResizeStart: (panel: DesktopPanel, event: ReactPointerEvent<HTMLButtonElement>) => void }) {
  return <button type="button" className="panel-resizer" role="separator" aria-orientation="vertical" aria-label={`Resize ${PANEL_LABELS[panel]}`} onPointerDown={(event) => onResizeStart(panel, event)} />;
}

function FilterBar({ filters, setFilters, players, onReset }: { filters: TerminalFilters; setFilters: (filters: Partial<TerminalFilters>) => void; players: TerminalPlayer[]; onReset: () => void }) {
  const clubs = [...new Set(players.map((player) => player.teamShortName).filter((club) => club !== "—"))].sort();
  return <div className="filters">
    <div className="filter-row"><select value={filters.position} onChange={(event) => setFilters({ position: event.target.value as TerminalFilters["position"] })} aria-label="Filter by position"><option value="ALL">ALL POS</option>{POSITIONS.map((position) => <option value={position} key={position}>{position}</option>)}</select><select value={filters.club} onChange={(event) => setFilters({ club: event.target.value })} aria-label="Filter by club"><option value="">ALL CLUBS</option>{clubs.map((club) => <option value={club} key={club}>{club}</option>)}</select><input inputMode="decimal" value={filters.minPrice} onChange={(event) => setFilters({ minPrice: event.target.value })} placeholder="MIN £" aria-label="Minimum price" /><input inputMode="decimal" value={filters.maxPrice} onChange={(event) => setFilters({ maxPrice: event.target.value })} placeholder="MAX £" aria-label="Maximum price" /></div>
    <div className="filter-row"><input inputMode="decimal" value={filters.minOwnership} onChange={(event) => setFilters({ minOwnership: event.target.value })} placeholder="MIN OWN%" aria-label="Minimum ownership" /><input inputMode="decimal" value={filters.maxOwnership} onChange={(event) => setFilters({ maxOwnership: event.target.value })} placeholder="MAX OWN%" aria-label="Maximum ownership" /><select value={filters.availability} onChange={(event) => setFilters({ availability: event.target.value as TerminalFilters["availability"] })} aria-label="Filter by availability"><option value="ALL">ALL STATUS</option><option value="AVAILABLE">AVAILABLE</option><option value="DOUBTFUL">DOUBTFUL</option><option value="UNAVAILABLE">UNAVAILABLE</option></select><select value={filters.confidence} onChange={(event) => setFilters({ confidence: event.target.value as TerminalFilters["confidence"] })} aria-label="Filter by confidence"><option value="ALL">ALL CONFIDENCE</option><option value="HIGH">HIGH CONF</option><option value="MEDIUM">MED CONF</option><option value="LOW">LOW CONF</option></select></div>
    <div className="filter-row filter-row-last"><select value={filters.risk} onChange={(event) => setFilters({ risk: event.target.value as TerminalFilters["risk"] })} aria-label="Filter by risk"><option value="ALL">ALL RISK</option><option value="LOW">LOW RISK</option><option value="MEDIUM">MED RISK</option><option value="HIGH">HIGH RISK</option></select><div className="quick-filters">{(["ALL", "VALUE", "PREMIUM", "DIFFERENTIAL", "NAILED", "CHEAP"] as const).map((quick) => <button type="button" key={quick} className={filters.quick === quick ? "active" : ""} onClick={() => setFilters({ quick })}>{quick}</button>)}</div></div>
    <div className="filter-actions"><label className="check-label"><input type="checkbox" checked={filters.affordableOnly} onChange={(event) => setFilters({ affordableOnly: event.target.checked })} /> affordable only</label><label className="check-label"><input type="checkbox" checked={filters.excludeSelected} onChange={(event) => setFilters({ excludeSelected: event.target.checked })} /> hide selected</label><button type="button" className="filter-reset" onClick={onReset}>RESET</button></div>
  </div>;
}

function SortableHead({ label, sortKey, active, direction, onSort }: { label: string; sortKey: SortKey; active: SortKey; direction: "asc" | "desc"; onSort: (key: SortKey) => void }) { return <th><button className={`sort-button ${active === sortKey ? "active" : ""}`} onClick={() => onSort(sortKey)}>{label}{active === sortKey && <span>{direction === "asc" ? " ↑" : " ↓"}</span>}</button></th>; }

function PlayerRow({ player, week, gameweek, selected, onSelect, onAdd }: { player: TerminalPlayer; week: UniverseWeekMetrics; gameweek: number; selected: boolean; onSelect: () => void; onAdd: () => void }) { return <tr className={selected ? "selected" : ""}><td><button className="player-name-button" onClick={onSelect}><strong>{player.displayName}</strong><small>· {player.teamShortName}</small></button></td><td><span className={`pos-tag ${player.position.toLowerCase()}`}>{player.position}</span></td><td>{player.priceTenths > 0 ? money(player.priceTenths) : "—"}</td><td>{player.ownership > 0 ? `${player.ownership.toFixed(1)}%` : "—"}</td><td>{player.current.form === undefined ? "—" : player.current.form.toFixed(1)}</td><td className="cyan-text">{points(week.xp)}</td><td>{points(week.next5)}</td><td>{metric(week.value)}</td><td>{week.minutes > 0 ? `${Math.round(week.minutes)}′` : "—"}</td><td>{expectedInvolvementPer90(player)}</td><td>{player.projection?.riskScore ? Math.round(player.projection.riskScore) : "—"}</td><td className="fixture-cell"><FixtureRun player={player} gameweek={gameweek} /></td><td><button className="add-button" onClick={onAdd} disabled={selected} aria-label={`Add ${player.displayName}`}>{selected ? "IN" : "+"}</button></td></tr>; }

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

function MobileLineupBar({ player, starter, benchLabel, benchIndex, captain, vice, locked, lineupActive, onClose, onInfo, onCaptain, onViceCaptain, onSwap, onMoveBench, onToggleLock, onRemove }: { player: TerminalPlayer; starter: boolean; benchLabel?: string; benchIndex: number; captain: boolean; vice: boolean; locked: boolean; lineupActive: boolean; onClose: () => void; onInfo: () => void; onCaptain: () => void; onViceCaptain: () => void; onSwap: () => void; onMoveBench: (direction: -1 | 1) => void; onToggleLock: () => void; onRemove: () => void }) {
  return <div className="mobile-lineup-bar" role="toolbar" aria-label={`Lineup actions for ${player.displayName}`}>
    <div className="mobile-bar-head"><span>{player.displayName} · {player.teamShortName}{starter ? "" : ` · ${benchLabel ?? "BENCH"}`}{captain ? " · ©" : vice ? " · VC" : ""}</span><button type="button" className="bar-close" onClick={onClose} aria-label={`Close actions for ${player.displayName}`}>×</button></div>
    <div className="mobile-bar-actions">
      {lineupActive && starter && <>
        <button type="button" className={`bar-action ${captain ? "active-captain" : ""}`} onClick={onCaptain} aria-label={`Make ${player.displayName} captain`} aria-pressed={captain}>C</button>
        <button type="button" className={`bar-action ${vice ? "active-vice" : ""}`} onClick={onViceCaptain} aria-label={`Make ${player.displayName} vice-captain`} aria-pressed={vice}>VC</button>
        <button type="button" className="bar-action" onClick={onSwap} aria-label={`Select ${player.displayName} to move to bench`}>BENCH</button>
      </>}
      {lineupActive && !starter && <>
        <button type="button" className="bar-action" onClick={onSwap} aria-label={`Select ${player.displayName} to move into the starting XI`}>START</button>
        {benchIndex >= 0 && <>
          <button type="button" className="bar-action" disabled={benchIndex === 0} onClick={() => onMoveBench(-1)} aria-label={`Move ${player.displayName} up the bench order`}>↑</button>
          <button type="button" className="bar-action" disabled={benchIndex === 2} onClick={() => onMoveBench(1)} aria-label={`Move ${player.displayName} down the bench order`}>↓</button>
        </>}
      </>}
      <button type="button" className="bar-action" onClick={onInfo} aria-label={`Open ${player.displayName} details`}>INFO</button>
      <button type="button" className="bar-action" onClick={onToggleLock} aria-label={`${locked ? "Unlock" : "Lock"} ${player.displayName}`} aria-pressed={locked}>{locked ? "UNLOCK" : "LOCK"}</button>
      <button type="button" className="bar-action bar-danger" onClick={onRemove} aria-label={`Remove ${player.displayName}`}>DROP</button>
    </div>
  </div>;
}

function SquadSlot({ player, gameweek, locked, captain, vice, starter, benchLabel, benchIndex, lineupActive, swapSelected, picked, chip, onRemove, onToggleLock, onActivate, onSwap, onCaptain, onViceCaptain, onMoveBench }: { player: TerminalPlayer; gameweek: number; locked: boolean; captain: boolean; vice: boolean; starter: boolean; benchLabel?: string; benchIndex: number; lineupActive: boolean; swapSelected: boolean; picked: boolean; chip?: ChipKind | null; onRemove: () => void; onToggleLock: () => void; onActivate: () => void; onSwap: () => void; onCaptain: () => void; onViceCaptain: () => void; onMoveBench: (direction: -1 | 1) => void }) {
  const benched = Boolean(benchLabel);
  const benchCounting = chip === "bboost" && benched;
  const captainMultiplier = captain ? (chip === "3xc" ? 3 : 2) : 1;
  return <article className={`squad-slot filled ${locked ? "locked" : ""} ${benched ? "benched" : ""} ${swapSelected ? "lineup-selected" : ""} ${picked ? "picked" : ""} ${benchCounting ? "bench-counting" : ""}`}>
    <SquadFixtureBadges player={player} gameweek={gameweek} />
    {(captain || vice) && <span className={`slot-role ${captain ? "captain" : "vice"}`} aria-hidden="true">{captain ? (chip === "3xc" ? "3×" : "C") : "VC"}</span>}
    {benched && benchLabel && <span className="slot-bench-tag" aria-hidden="true">{benchLabel}{benchCounting ? " · COUNTS" : ""}</span>}
    <button className="slot-main" onClick={onActivate} aria-pressed={picked}><span className="slot-player">{player.displayName}</span><span className="slot-sub">{player.teamShortName} · {money(player.priceTenths)}</span><span className="slot-xp">{points(weeklyPlayerMetrics(player, gameweek).points * captainMultiplier)} <small>xP</small></span></button>
    <div className="slot-flags"><button className={`lock-flag ${locked ? "on" : ""}`} onClick={onToggleLock} aria-label={`${locked ? "Unlock" : "Lock"} ${player.displayName}`} aria-pressed={locked}><svg className="lock-icon" viewBox="0 0 16 16" aria-hidden="true"><path className="lock-shackle" d="M4 7V5a4 4 0 0 1 8 0v2" /><rect className="lock-body" x="2.5" y="7" width="11" height="7" /></svg></button>{!locked && <button className="remove-flag" onClick={onRemove} aria-label={`Remove ${player.displayName}`}>×</button>}</div>
    {lineupActive && <div className="lineup-controls">{starter ? <><button className={`role-button captain ${captain ? "active" : ""}`} onClick={onCaptain} aria-label={`Make ${player.displayName} captain`} aria-pressed={captain}>C</button><button className={`role-button vice ${vice ? "active" : ""}`} onClick={onViceCaptain} aria-label={`Make ${player.displayName} vice-captain`} aria-pressed={vice}>VC</button><button className="role-button bench-toggle" onClick={onSwap} aria-label={`Select ${player.displayName} to move to bench`} aria-pressed={swapSelected}>B</button></> : <><button className="role-button bench-toggle active" onClick={onSwap} aria-label={`Select ${player.displayName} to move into the starting XI`} aria-pressed={swapSelected}>{benchLabel}</button>{benchIndex >= 0 && <><button className="role-button bench-order" disabled={benchIndex === 0} onClick={() => onMoveBench(-1)} aria-label={`Move ${player.displayName} up the bench order`}>↑</button><button className="role-button bench-order" disabled={benchIndex === 2} onClick={() => onMoveBench(1)} aria-label={`Move ${player.displayName} down the bench order`}>↓</button></>}</>}</div>}
  </article>;
}

function EmptySlot({ position, maxPriceTenths, onChoose }: { position: Position; maxPriceTenths: number; onChoose: () => void }) { return <button className="squad-slot empty-slot" onClick={onChoose}><span className="empty-plus">+</span><span className="slot-player">Open {position}</span><span className="slot-sub">Max {money(maxPriceTenths)}</span><span className="suggest-label">SUGGEST →</span></button>; }

function MetricStrip({ spent, bankTenths, projected, risk, teamRating }: { spent: number; bankTenths: number; projected: { nextGW?: number }; risk?: number; teamRating?: number }) { return <div className="metric-strip" aria-label="Squad projection metrics"><Metric label="COST" value={money(spent)} /><Metric label="ITB" value={money(bankTenths)} /><Metric label="TEAM RATING" value={teamRating === undefined ? "—" : `${teamRating}%`} title={teamRating === undefined ? "Team rating needs a picked squad and live market data." : "Starting XI plus captain xP as a share of the best legal XI the market can field for the same budget."} tone={teamRating === undefined ? undefined : teamRating >= 90 ? "green" : teamRating >= 80 ? "bright-green" : teamRating >= 70 ? "yellow" : "red"} /><Metric label="GW xP" value={points(projected.nextGW)} tone="cyan" title="Chip-adjusted xP minus transfer hit costs." /><Metric label="RISK" value={risk === undefined ? "—" : risk < 30 ? "LOW" : risk < 60 ? "MED" : "HIGH"} tone={risk === undefined ? undefined : risk < 30 ? "green" : risk < 60 ? "yellow" : "red"} /></div>; }

function StrategyControls({ horizon, riskMode, benchStrategy, setStrategy }: { horizon: 1 | 3 | 5 | 10; riskMode: "SAFE" | "BALANCED" | "AGGRESSIVE"; benchStrategy: "CHEAP" | "BALANCED" | "STRONG"; setStrategy: (strategy: { horizon?: 1 | 3 | 5 | 10; riskMode?: "SAFE" | "BALANCED" | "AGGRESSIVE"; benchStrategy?: "CHEAP" | "BALANCED" | "STRONG" }) => void }) { return <div className="strategy-panel"><span className="section-kicker">OPTIMIZER SETTINGS</span><div><span className="strategy-label">HORIZON</span><div className="segmented">{([1, 3, 5, 10] as const).map((value) => <button key={value} className={horizon === value ? "active" : ""} onClick={() => setStrategy({ horizon: value })}>{value === 1 ? "GW" : `${value}GW`}</button>)}</div></div><div><span className="strategy-label">RISK</span><div className="segmented">{(["SAFE", "BALANCED", "AGGRESSIVE"] as const).map((value) => <button key={value} className={riskMode === value ? "active" : ""} onClick={() => setStrategy({ riskMode: value })}>{value}</button>)}</div></div><div><span className="strategy-label">BENCH</span><div className="segmented">{(["CHEAP", "BALANCED", "STRONG"] as const).map((value) => <button key={value} className={benchStrategy === value ? "active" : ""} onClick={() => setStrategy({ benchStrategy: value })}>{value}</button>)}</div></div></div>; }

function TransferSuggestionsPanel({ suggestions, state, message, horizon, onHorizon, playerById, onSimulate, onDismiss }: { suggestions: SingleTransferSuggestion[]; state: "INCOMPLETE" | "LOADING" | "READY" | "ERROR"; message: string | null; horizon: 1 | 3 | 5 | 10; onHorizon: (horizon: 1 | 3 | 5 | 10) => void; playerById: Map<number, TerminalPlayer>; onSimulate: (outId: number, inId: number) => void; onDismiss: (outId: number, inId: number) => void }) {
  return <section className="replacement-panel unified-replacements" aria-label="Transfer suggestions"><div className="subsection-head"><div><span className="section-kicker">TRANSFER SUGGESTIONS</span><span className="panel-count">EXACT</span></div><div className="segmented transfer-horizon" role="group" aria-label="Transfer suggestion horizon">{([1, 3, 5, 10] as const).map((value) => <button key={value} type="button" className={horizon === value ? "active" : ""} aria-pressed={horizon === value} onClick={() => onHorizon(value)}>{value === 1 ? "GW" : `${value}GW`}</button>)}</div></div><div className="replacement-scroll">{suggestions.length ? suggestions.map((suggestion) => {
    const outgoing = playerById.get(suggestion.outgoingPlayerId);
    const incoming = playerById.get(suggestion.incomingPlayerId);
    const outgoingName = outgoing?.displayName ?? `Player ${suggestion.outgoingPlayerId}`;
    const incomingName = incoming?.displayName ?? `Player ${suggestion.incomingPlayerId}`;
    const kind = suggestion.kind === "BOTH" ? "xP + CASH" : "xP UPGRADE";
    return <div className="replacement-row" key={`${suggestion.outgoingPlayerId}-${suggestion.incomingPlayerId}`}><div><strong>{outgoingName} → {incomingName}</strong><small>{kind} · {incoming?.teamShortName ?? "—"} · {incoming ? money(incoming.priceTenths) : "—"}</small></div><div className="transfer-effects"><span className="green">+{suggestion.projectedDelta.toFixed(1)} xP</span><span>{suggestion.cashReleasedTenths >= 0 ? "+" : "−"}{money(Math.abs(suggestion.cashReleasedTenths))} ITB</span></div><div className="transfer-actions"><button className="compact-action" onClick={() => onSimulate(suggestion.outgoingPlayerId, suggestion.incomingPlayerId)}>SIMULATE</button><button className="transfer-dismiss" aria-label={`Dismiss ${outgoingName} to ${incomingName} suggestion`} title="Dismiss suggestion" onClick={() => onDismiss(suggestion.outgoingPlayerId, suggestion.incomingPlayerId)}>×</button></div></div>;
  }) : <div className="empty-copy">{state === "LOADING" ? "CALCULATING LEGAL xP-INCREASING TRANSFERS…" : state === "INCOMPLETE" ? "Complete a legal 15-player squad to calculate exact transfers." : state === "ERROR" ? message ?? "Exact transfer search is unavailable." : "No legal single transfer increases optimized lineup xP."}</div>}</div></section>;
}

function SimulationPanel({ result, move, playerById, onApply, onDiscard }: { result: SimulationResult; move: { outId: number; inId: number }; playerById: Map<number, TerminalPlayer>; onApply: () => void; onDiscard: () => void }) { return <section className="panel simulation-panel"><div className="panel-header"><div><span className="section-kicker">SIMULATION</span><span className="panel-count">{result.legal ? "LEGAL" : "CHECK REQUIRED"}</span></div><button className="icon-button" onClick={onDiscard} aria-label="Close simulation">×</button></div><div className="simulation-move">{playerById.get(move.outId)?.displayName ?? "Outgoing"} <span>→</span> {playerById.get(move.inId)?.displayName ?? "Incoming"}</div><div className="simulation-grid"><div><span>CURRENT {result.horizon}GW xP</span><strong>{points(result.optimizedBeforeXp)}</strong></div><div><span>SIMULATED {result.horizon}GW xP</span><strong>{points(result.optimizedAfterXp)}</strong></div><div><span>PRICE EFFECT</span><strong>{money(result.priceDeltaTenths)}</strong></div><div><span>xP EFFECT</span><strong className={result.projectedDelta >= 0 ? "green" : "red"}>{result.projectedDelta >= 0 ? "+" : ""}{result.projectedDelta.toFixed(1)}</strong></div></div><p className="simulation-note">{result.explanationFactors[0] ?? "Model comparison complete."}{!result.legal && " The current selection still has a squad-rules issue."}</p><div className="simulation-actions"><button className="primary-button" onClick={onApply}>APPLY CHANGES</button><button className="secondary-button" onClick={onDiscard}>DISCARD</button></div></section>; }

function probability(value: number): string { return `${Math.round(clamp(value, 0, 1) * 100)}%`; }
function formatProfileStat(value: number | undefined, digits = 0): string { return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits); }
function per90(value: number | undefined, minutes: number | undefined): number | undefined { return value === undefined || minutes === undefined || minutes <= 0 ? undefined : value / minutes * 90; }
function profileXgi(stats: Player["current"]): number | undefined {
  if (stats.expectedGoalInvolvements !== undefined) return stats.expectedGoalInvolvements;
  if (stats.expectedGoals === undefined && stats.expectedAssists === undefined) return undefined;
  return (stats.expectedGoals ?? 0) + (stats.expectedAssists ?? 0);
}
function profileAvailabilityLabel(value: ReturnType<typeof availabilityOf>): string { return value === "AVAILABLE" ? "Available" : value === "DOUBTFUL" ? "Doubtful" : "Unavailable"; }
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
function formatDeadline(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
export function formatDeadlineCountdown(value: string, now = Date.now()): string {
  const deadline = Date.parse(value);
  if (!Number.isFinite(deadline)) return "—";
  const totalSeconds = Math.max(0, Math.ceil((deadline - now) / 1_000));
  if (totalSeconds === 0) return "CLOSED";
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor(totalSeconds % 86_400 / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  return days ? `${days}d ${clock}` : clock;
}

function exportState(state: ReturnType<typeof useTerminalStore.getState>) { const blob = new Blob([JSON.stringify(exportTerminalState(state), null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "fpl-terminal-state.json"; anchor.click(); URL.revokeObjectURL(url); }

function importState(event: React.ChangeEvent<HTMLInputElement>, state: ReturnType<typeof useTerminalStore.getState>) { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { const parsed = typeof reader.result === "string" ? parseSavedState(reader.result) : null; if (parsed) state.hydrate(parsed); }; reader.readAsText(file); event.target.value = ""; }

export function ModeChooserPreview() { return null; }
