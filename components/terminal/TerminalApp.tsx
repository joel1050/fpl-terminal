"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { NailedRating, Player, PlayerFixture, PlayerSelection, Position, SelectionEvidence, SimulationResult, SingleTransferSuggestion, SquadState, WeeklyLineupPlan } from "@/types";
import { analyzeSquad } from "@/lib/analysis/analyzeSquad";
import { simulateChange as simulateSquadChange } from "@/lib/analysis/simulateChange";
import { chooseCaptainVice } from "@/lib/squad/captain";
import { explainIllegalSelection, maxSafePriceForPosition } from "@/lib/squad/budget";
import { expectedAutosubValue, pickWeeklyTeam, projectWeeklyLineupHorizons, validateWeeklyLineup } from "@/lib/squad/weeklyLineup";
import type { OptimizerResult } from "@/lib/optimizer/optimizer";
import { projectPlayer } from "@/lib/projections/projectPlayer";
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
const DESKTOP_PANELS: DesktopPanel[] = ["market", "squad", "ai"];
const PANEL_LABELS: Record<DesktopPanel, string> = { market: "Player universe", squad: "Squad builder and analysis", ai: "AI analyst" };

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
  if (normalized === "ROTOWIRE_XI" || normalized === "ROTOWIREXI" || normalized === "ROTOWIRE_STARTING_XI") return "ROTOWIRE_XI";
  if (normalized === "ROTOWIRE_AVAILABILITY" || normalized === "ROTOWIREAVAILABILITY") return "ROTOWIRE_AVAILABILITY";
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
    .map((player) => ({ ...player, projection: player.projection && (player.projection.nextGW || player.projection.next3 || player.projection.next5) ? player.projection : projectPlayer(player, { currentGameweek: 1, horizon: 5 }) }));
  const events = arrayOf(readField(root, "events", "event")).length ? arrayOf(readField(root, "events", "event")) : arrayOf(readField(data, "events", "event"));
  const currentEvent = events.map(objectOf).find((event): event is UnknownRecord => Boolean(event && (event.is_current === true || event.is_next === true)));
  const gameweek = numberOf(readField(root, "gameweek", "currentGameweek", "current_gameweek")) ?? numberOf(readField(data, "gameweek", "currentGameweek", "current_gameweek")) ?? numberOf(readField(metadata, "currentGameweek", "current_gameweek", "gameweek")) ?? numberOf(currentEvent ? readField(currentEvent, "id", "event") : undefined) ?? null;
  const deadline = stringOf(readField(root, "deadline", "nextDeadline", "next_deadline")) ?? stringOf(readField(data, "deadline", "nextDeadline")) ?? stringOf(currentEvent ? readField(currentEvent, "deadline_time") : undefined) ?? null;
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

function expectedMinutesOf(player: TerminalPlayer): string {
  const minutes = player.selection?.expectedMinutes ?? player.projection?.expectedMinutes;
  return minutes === undefined || !Number.isFinite(minutes) || minutes <= 0 ? "—" : `${Math.round(minutes)}′`;
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

function FixtureRun({ player }: { player: TerminalPlayer }) {
  if (!player.fixtures.length) return <>—</>;
  return <span className="fixture-run">{player.fixtures.slice(0, 12).map((fixture) => <span className={(fixture.difficulty ?? 3) <= 2 ? "easy" : (fixture.difficulty ?? 3) >= 4 ? "hard" : ""} key={`${fixture.gameweek}-${fixture.opponentTeamId}`}>{fixture.opponentShortName}({fixture.isHome ? "H" : "A"})</span>)}</span>;
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
  const projectedXI = starters.reduce((sum, id) => sum + (playerById.get(id)?.projection?.nextGW ?? 0), 0);
  const captainBonus = captainId ? playerById.get(captainId)?.projection?.nextGW ?? 0 : 0;
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
  const [state, setState] = useState<{ data: Bootstrap; status: DataState; message?: string; refresh: () => void }>({ data: { players: [], gameweek: null, deadline: null, source: null, freshness: "LIVE", fetchedAt: null }, status: "SYNCING", refresh: () => setRefreshCount((value) => value + 1) });
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
        const normalized = normalizeBootstrap(payload);
        const errors = arrayOf(root.errors).filter((error): error is string => typeof error === "string");
        const freshnessLabel = classifyFreshness({
          stale: readField(freshness, "stale", "isStale"),
          source: [stringOf(readField(freshness, "source", "dataSource")), normalized.source].filter(Boolean).join(" "),
          errors,
        });
        return { data: { ...normalized, freshness: freshnessLabel, fetchedAt }, errors };
      })
      .then(({ data, errors }) => setState((current) => ({ ...current, data, status: data.players.length ? data.freshness : "EMPTY", message: errors[0] ?? (data.players.length ? undefined : "The FPL response contained no player records.") })))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({ ...current, data: { players: [], gameweek: null, deadline: null, source: null, freshness: "LIVE", fetchedAt: null }, status: "ERROR", message: error instanceof Error ? error.message : "FPL data is unavailable." }));
      });
    return () => controller.abort();
  }, [refreshCount]);

  return state;
}

export default function TerminalApp() {
  const bootstrap = useBootstrap();
  const store = useTerminalStore();
  const [aiMessages, setAiMessages] = useState<Array<{ role: "user" | "assistant"; text: string; at: number; actions?: Array<{ type?: string; playerId?: unknown; outId?: unknown; inId?: unknown }> }>>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiOnline, setAiOnline] = useState<boolean | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
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
  const [transferSearch, setTransferSearch] = useState<{ key: string; suggestions: SingleTransferSuggestion[]; state: "READY" | "ERROR"; message: string | null }>({ key: "", suggestions: [], state: "READY", message: null });
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [simulationMove, setSimulationMove] = useState<{ outId: number; inId: number } | null>(null);
  const [gwSwapSelection, setGWSwapSelection] = useState<{ starterId?: number; benchId?: number }>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const aiRef = useRef<HTMLTextAreaElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const [collapsedPanels, setCollapsedPanels] = useState<Record<DesktopPanel, boolean>>({ market: false, squad: false, ai: false });
  const { data, status, message, refresh } = bootstrap;

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
    const controller = new AbortController();
    fetch("/api/ai", { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`AI status returned ${response.status}`);
        return objectOf(await response.json());
      })
      .then((payload) => setAiOnline(typeof payload?.enabled === "boolean" ? payload.enabled : false))
      .catch(() => {
        if (!controller.signal.aborted) setAiOnline(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const raw = window.localStorage.getItem("fpl-terminal-state");
    useTerminalStore.getState().hydrate(raw ? parseSavedState(raw) : null);
  }, []);

  useEffect(() => {
    const state = useTerminalStore.getState();
    if (!state.isHydrated) return;
    window.localStorage.setItem("fpl-terminal-state", JSON.stringify(exportTerminalState(state)));
  }, [store.isHydrated, store.mode, store.entryId, store.playerIds, store.byPosition, store.benchGoalkeeperId, store.benchOrder, store.lineupGameweek, store.lineupProjectionFingerprint, store.lockedPlayerIds, store.captainId, store.viceCaptainId, store.horizon, store.riskMode, store.benchStrategy, store.panelRatios]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key.toLowerCase() === "a" && !typing) {
        event.preventDefault();
        aiRef.current?.focus();
      }
      if (event.key === "Escape") store.setSelectedPlayer(undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  const selected = useMemo(() => data.players.filter((player) => store.playerIds.includes(player.id)), [data.players, store.playerIds]);
  const playerById = useMemo(() => new Map(data.players.map((player) => [player.id, player])), [data.players]);
  const spent = useMemo(() => selected.reduce((sum, player) => sum + player.priceTenths, 0), [selected]);
  const squadAnalysis = useMemo(() => analyzeSquad({
    squad: store.playerIds,
    players: data.players,
    horizon: store.horizon,
    risk: store.riskMode,
    bench: store.benchStrategy,
  }), [data.players, store.benchStrategy, store.horizon, store.playerIds, store.riskMode]);
  const slotMaxPrices = useMemo(() => POSITIONS.reduce((result, position) => {
    result[position] = maxSafePriceForPosition(position, selected, data.players);
    return result;
  }, {} as Record<Position, number>), [data.players, selected]);
  const weeklyEnginePlan = useMemo(() => pickWeeklyTeam({
    squad: selected,
    gameweek: data.gameweek ?? 1,
    riskMode: store.riskMode,
  }), [data.gameweek, selected, store.riskMode]);
  const lineupApplied = store.lineupGameweek !== undefined && store.lineupProjectionFingerprint !== undefined;
  const currentGWPlan = useMemo<WeeklyLineupPlan | null>(() => {
    if (!lineupApplied || store.benchGoalkeeperId === undefined || store.benchOrder.length !== 3) {
      return weeklyEnginePlan.starterIds.length === 11 ? weeklyEnginePlan : null;
    }
    const startingXI = deriveStartingXI(store.playerIds, store.benchGoalkeeperId, store.benchOrder);
    return persistedLineupPlan(weeklyEnginePlan, startingXI, store.benchGoalkeeperId, store.benchOrder, store.captainId, store.viceCaptainId, playerById);
  }, [lineupApplied, playerById, store.benchGoalkeeperId, store.benchOrder, store.captainId, store.playerIds, store.viceCaptainId, weeklyEnginePlan]);
  const lineupStale = lineupApplied && (store.lineupGameweek !== weeklyEnginePlan.gameweek || store.lineupProjectionFingerprint !== weeklyEnginePlan.projectionFingerprint);
  const projected = useMemo<{ nextGW?: number; next3?: number; next5?: number }>(() => {
    if (!selected.length) return {};
    if (weeklyEnginePlan.starterIds.length !== 11) return {
      nextGW: squadAnalysis.projectedNextGW,
      next3: squadAnalysis.projectedNext3,
      next5: squadAnalysis.projectedNext5,
    };
    return projectWeeklyLineupHorizons({
      squad: selected,
      gameweek: data.gameweek ?? 1,
      riskMode: store.riskMode,
    }, !lineupStale ? currentGWPlan ?? undefined : undefined);
  }, [currentGWPlan, data.gameweek, lineupStale, selected, squadAnalysis.projectedNext3, squadAnalysis.projectedNext5, squadAnalysis.projectedNextGW, store.riskMode, weeklyEnginePlan.starterIds.length]);
  const risk = useMemo(() => {
    if (!selected.length) return undefined;
    const values = selected.map((player) => player.projection?.riskScore ?? 0).filter((value) => value > 0);
    return values.length === selected.length && values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : undefined;
  }, [selected]);
  const weakest = useMemo(() => squadAnalysis.weaknesses
    .slice(0, 3)
    .map((weakness) => playerById.get(weakness.playerId))
    .filter((player): player is TerminalPlayer => Boolean(player)), [playerById, squadAnalysis.weaknesses]);
  const transferRequestKey = selected.length === 15
    ? `${store.playerIds.join(",")}|${store.lockedPlayerIds.join(",")}|${store.horizon}|${store.riskMode}|${data.gameweek ?? 1}`
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
        horizon: store.horizon,
        risk: store.riskMode,
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
  }, [store.horizon, store.lockedPlayerIds, store.playerIds, store.riskMode, transferRequestKey]);
  const transferSuggestions = transferRequestKey && transferSearch.key === transferRequestKey ? transferSearch.suggestions : [];
  const transferSuggestionState: "INCOMPLETE" | "LOADING" | "READY" | "ERROR" = !transferRequestKey ? "INCOMPLETE" : transferSearch.key === transferRequestKey ? transferSearch.state : "LOADING";
  const transferSuggestionMessage = transferSearch.key === transferRequestKey ? transferSearch.message : null;

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
        || (filters.quick === "VALUE" && (player.projection?.valueNext5 ?? 0) >= 2.5);
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
        && (!filters.affordableOnly || player.priceTenths <= 1000 - spent)
        && (!filters.excludeSelected || !store.playerIds.includes(player.id))
        && quickMatch;
    });
    return rows.sort((a, b) => {
      const values: Record<SortKey, (player: TerminalPlayer) => number | string> = {
        name: (player) => player.displayName,
        price: (player) => player.priceTenths,
        nextGW: (player) => player.projection?.nextGW ?? 0,
        next3: (player) => player.projection?.next3 ?? 0,
        next5: (player) => player.projection?.next5 ?? 0,
        value: (player) => player.projection?.valueNext5 ?? 0,
        ownership: (player) => player.ownership,
        risk: (player) => player.projection?.riskScore ?? 0,
      };
      const left = values[store.sortKey](a);
      const right = values[store.sortKey](b);
      const result = typeof left === "string" && typeof right === "string" ? left.localeCompare(right) : Number(left) - Number(right);
      return store.sortDirection === "asc" ? result : -result;
    });
  }, [data.players, spent, store.filters, store.playerIds, store.search, store.sortDirection, store.sortKey]);

  const addPlayer = useCallback((player: TerminalPlayer) => {
    const explanation = explainIllegalSelection(player, selected, data.players);
    if (!explanation.legal) {
      setNotice(explanation.message);
      return;
    }
    if (useTerminalStore.getState().addPlayer(player.id, player.position)) {
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
    const currentOrder = store.benchOrder.length === 3 ? store.benchOrder : currentGWPlan.benchOrder;
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
      gameweek: store.lineupGameweek ?? currentGWPlan.gameweek,
      lineupProjectionFingerprint: store.lineupProjectionFingerprint ?? currentGWPlan.projectionFingerprint,
      benchGoalkeeperId: store.benchGoalkeeperId ?? currentGWPlan.benchGoalkeeperId,
      benchOrder: store.benchOrder.length === 3 ? [...store.benchOrder] : [...currentGWPlan.benchOrder],
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

  const setCaptainDeterministically = () => {
    if (selected.length < 11) {
      setNotice("Captain selection needs at least 11 players.");
      return;
    }
    try {
      const plan = chooseCaptainVice(selected);
      store.setCaptain(plan.captainId);
      store.setViceCaptain(plan.viceCaptainId);
      setNotice("Captain and vice-captain selected from the current projection model.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Captain selection is unavailable.");
    }
  };

  const simulateMove = (outId: number, inId: number) => {
    const result = simulateSquadChange({
      squad: store.playerIds,
      players: data.players,
      outId,
      inId,
      gameweek: data.gameweek ?? 1,
      horizon: store.horizon,
      risk: store.riskMode,
      bench: store.benchStrategy,
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
      gameweek: data.gameweek ?? 1,
      horizon: store.horizon,
      risk: store.riskMode,
      bench: store.benchStrategy,
    });
    if (!checked.legal || !store.replacePlayer(outgoing.id, incoming.id, incoming.position)) {
      setNotice("That transfer is no longer legal for the current squad.");
      return;
    }
    setSimulation(null);
    setSimulationMove(null);
    setNotice(`${outgoing.displayName} → ${incoming.displayName} applied.`);
  };

  const askAI = async (prompt: string) => {
    const text = prompt.trim();
    if (!text || aiBusy) return;
    setAiPrompt("");
    setAiMessages((messages) => [...messages, { role: "user", text, at: Date.now() }]);
    setAiBusy(true);
    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ message: text, context: { gameweek: data.gameweek ?? 1, squad: { playerIds: store.playerIds, lockedPlayerIds: store.lockedPlayerIds, captainId: store.captainId, viceCaptainId: store.viceCaptainId }, finances: { costTenths: spent, bankTenths: 1000 - spent }, strategy: { horizon: store.horizon, risk: store.riskMode, bench: store.benchStrategy } } }),
      });
      if (!response.ok) throw new Error(`AI analyst returned ${response.status}`);
      const payload = objectOf(await response.json());
      const answer = stringOf(payload?.message) ?? stringOf(payload?.text) ?? "The analyst returned no explanation.";
      const actions = arrayOf(payload?.actions)
        .map(objectOf)
        .map((action) => ({ type: stringOf(readField(action, "type")), playerId: readField(action, "playerId"), outId: readField(action, "outId"), inId: readField(action, "inId") }))
        .filter((action): action is { type: string; playerId: unknown; outId: unknown; inId: unknown } => Boolean(action.type));
      setAiMessages((messages) => [...messages, { role: "assistant", text: answer, at: Date.now(), actions }]);
      const weeklyAction = arrayOf(payload?.actions)
        .map(objectOf)
        .find((action): action is UnknownRecord => Boolean(action && readField(action, "type") === "APPLY_WEEKLY_LINEUP"));
      if (weeklyAction) {
        const starterIds = arrayOf(readField(weeklyAction, "starterIds")).map(numberOf).filter((id): id is number => id !== undefined);
        const benchOrder = arrayOf(readField(weeklyAction, "benchOrder")).map(numberOf).filter((id): id is number => id !== undefined);
        const candidate: WeeklyLineupPlan = {
          ...weeklyEnginePlan,
          gameweek: numberOf(readField(weeklyAction, "gameweek")) ?? 0,
          starterIds,
          benchGoalkeeperId: numberOf(readField(weeklyAction, "benchGoalkeeperId")) ?? 0,
          benchOrder: benchOrder as [number, number, number],
          captainId: numberOf(readField(weeklyAction, "captainId")) ?? 0,
          viceCaptainId: numberOf(readField(weeklyAction, "viceCaptainId")) ?? 0,
          projectionFingerprint: stringOf(readField(weeklyAction, "projectionFingerprint")) ?? "",
        };
        const valid = candidate.gameweek === weeklyEnginePlan.gameweek
          && candidate.projectionFingerprint === weeklyEnginePlan.projectionFingerprint
          && validateWeeklyLineup(candidate, selected).legal;
        if (valid) {
          store.setMobileTab("SQUAD");
          setNotice("AI weekly team recommendation is ready. Use PICK TEAM to apply the shared lineup engine.");
        } else {
          setNotice("AI weekly team proposal failed validation against the current squad and projections.");
        }
      }
      setAiOnline(true);
    } catch {
      setAiOnline(false);
      setAiMessages((messages) => [...messages, { role: "assistant", text: "AI analyst is offline. The squad controls and deterministic analysis remain available; no model output was used.", at: Date.now() }]);
    } finally {
      setAiBusy(false);
    }
  };

  const handleAnalystAction = (action: { type?: string; playerId?: unknown; outId?: unknown; inId?: unknown }) => {
    const playerId = numberOf(action.playerId);
    if (action.type === "VIEW_PLAYER" && playerId !== undefined) {
      store.setSelectedPlayer(playerId);
      store.setMobileTab("MARKET");
      return;
    }
    if (action.type === "LOCK_PLAYER" && playerId !== undefined) {
      store.toggleLock(playerId);
      return;
    }
    if (action.type === "OPTIMIZE") {
      void runOptimize(false);
      return;
    }
    const outId = numberOf(action.outId);
    const inId = numberOf(action.inId);
    if (action.type === "SIMULATE_TRANSFER" && outId !== undefined && inId !== undefined && playerById.has(outId) && playerById.has(inId)) {
      store.setMobileTab("SQUAD");
      simulateMove(outId, inId);
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
      onBack={() => store.setMode(null)}
      onImport={(result) => {
        const importedPlayers = data.players.filter((player) => result.squad.playerIds.includes(player.id));
        const fingerprint = pickWeeklyTeam({ squad: importedPlayers, gameweek: result.lineup.gameweek, riskMode: store.riskMode }).projectionFingerprint;
        if (!store.replaceSquad(result.squad, { ...result.lineup, lineupProjectionFingerprint: fingerprint }, result.entryId)) return false;
        setNotice(`Imported ${result.teamName || result.managerName || `FPL team ${result.entryId}`}.`);
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
  const renderSquadPlayer = (player: TerminalPlayer, starter: boolean, benchLabel?: string) => {
    const benchIndex = (store.benchOrder.length === 3 ? store.benchOrder : currentGWPlan?.benchOrder ?? []).indexOf(player.id);
    const swapSelected = benchLabel ? gwSwapSelection.benchId === player.id : gwSwapSelection.starterId === player.id;
    return <SquadSlot key={player.id} player={player} locked={store.lockedPlayerIds.includes(player.id)} captain={(store.captainId ?? currentGWPlan?.captainId) === player.id} vice={(store.viceCaptainId ?? currentGWPlan?.viceCaptainId) === player.id} starter={starter} benchLabel={benchLabel} benchIndex={benchIndex} lineupActive={Boolean(currentGWPlan)} swapSelected={swapSelected} onRemove={() => store.removePlayer(player.id)} onToggleLock={() => store.toggleLock(player.id)} onSelect={() => store.setSelectedPlayer(player.id)} onSwap={() => selectGWSwapPlayer(benchLabel ? "bench" : "starter", player.id)} onCaptain={() => makeGWCaptain(player.id)} onViceCaptain={() => makeGWViceCaptain(player.id)} onMoveBench={(direction) => moveGWBench(player.id, direction)} />;
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
  return (
    <main className="terminal-app">
      <header className="topbar">
        <button className="brand" onClick={() => store.setMode(null)} aria-label="Return to mode chooser"><span className="brand-mark">FPL</span><span>TERMINAL</span></button>
        <div className="topbar-stats" aria-label="Terminal status">
          <StatusCell label="GW" value={data.gameweek ? String(data.gameweek) : "—"} />
          <StatusCell label="DEADLINE" value={data.deadline ? formatDeadline(data.deadline) : "—"} />
          <StatusCell label="DATA" value={status === "LIVE" ? "LIVE" : status === "SNAPSHOT" ? "SNAPSHOT" : status === "STALE" ? "STALE" : status === "SYNCING" ? "SYNC" : "OFFLINE"} tone={status === "LIVE" ? "green" : status === "ERROR" ? "red" : "amber"} />
          <StatusCell label="UPDATED" value={data.fetchedAt ? relativeAge(data.fetchedAt) : "—"} />
          <StatusCell label="ITB" value={money(1000 - spent)} tone={spent > 1000 ? "red" : "amber"} />
          <StatusCell label="5GW xP" value={points(projected.next5)} tone="cyan" />
          <StatusCell label="RISK" value={risk === undefined ? "—" : risk < 30 ? "LOW" : risk < 60 ? "MED" : "HIGH"} />
        </div>
        <div className="topbar-actions"><button className="text-button" onClick={refresh}>REFRESH</button><button className="text-button" onClick={() => exportState(store)}>EXPORT</button><button className="text-button" onClick={() => importRef.current?.click()}>IMPORT</button><button className="text-button danger-text" onClick={reset}>RESET</button><input ref={importRef} type="file" accept="application/json" hidden onChange={(event) => importState(event, store)} /></div>
      </header>

      <nav className="mobile-tabs" aria-label="Terminal panels">{(["SQUAD", "MARKET", "AI"] as const).map((tab) => <button key={tab} className={store.activeMobileTab === tab ? "active" : ""} onClick={() => store.setMobileTab(tab)}>{tab}</button>)}</nav>

      <div className="terminal-grid" style={gridStyle}>
        <section id="terminal-panel-market" data-panel="market" className={`market-column ${collapsedPanels.market ? "panel-collapsed" : ""} ${store.activeMobileTab === "MARKET" ? "mobile-visible" : ""}`} aria-label="Player universe">
          <div className="panel-header"><div><span className="section-kicker">PLAYER UNIVERSE</span><span className="panel-count">{data.players.length || "—"} records</span></div><div className="header-actions"><span className={`data-badge ${status.toLowerCase()}`}>{status === "LIVE" ? "LIVE FPL" : status === "SYNCING" ? "SYNCING" : "NO LIVE DATA"}</span><PanelToggle panel="market" collapsed={collapsedPanels.market} onToggle={() => togglePanel("market")} /></div></div>
          <div className="search-wrap"><span aria-hidden="true">/</span><input ref={searchRef} value={store.search} onChange={(event) => store.setSearch(event.target.value)} placeholder="Search player, club..." aria-label="Search players" /><kbd>/</kbd></div>
          <FilterBar filters={store.filters} setFilters={store.setFilters} players={data.players} onReset={resetFilters} />
          <div className="table-wrap"><table className="player-table"><thead><tr><SortableHead label="PLAYER" sortKey="name" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><th>POS</th><SortableHead label="PRICE" sortKey="price" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="OWN%" sortKey="ownership" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="XP GW" sortKey="nextGW" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="XP3" sortKey="next3" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="XP5" sortKey="next5" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="XP/£" sortKey="value" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><th>EXP MIN</th><th>XGI/90</th><th>RISK</th><th>FIXTURES</th><th>ADD</th></tr></thead><tbody>{filteredPlayers.slice(0, 250).map((player) => <PlayerRow key={player.id} player={player} selected={store.playerIds.includes(player.id)} onSelect={() => store.setSelectedPlayer(player.id)} onAdd={() => addPlayer(player)} />)}</tbody></table>{status === "SYNCING" && <div className="empty-state">SYNCING FPL MARKET…</div>}{status !== "SYNCING" && filteredPlayers.length === 0 && <div className="empty-state">{data.players.length ? "No players match these filters." : message ?? "FPL data is unavailable."}</div>}</div>
          {selectedPlayer && <PlayerDetail player={selectedPlayer} locked={store.lockedPlayerIds.includes(selectedPlayer.id)} freshness={status} source={data.source} onClose={() => store.setSelectedPlayer(undefined)} onAdd={() => addPlayer(selectedPlayer)} onToggleLock={() => store.toggleLock(selectedPlayer.id)} />}
          <PanelResizer panel="market" onResizeStart={beginPanelResize} />
        </section>

        <section id="terminal-panel-squad" data-panel="squad" className={`squad-column ${collapsedPanels.squad ? "panel-collapsed" : ""} ${store.activeMobileTab === "SQUAD" ? "mobile-visible" : ""}`} aria-label="Squad builder and analysis">
          <div className="panel-header"><div><span className="section-kicker">SQUAD BUILDER</span><span className="panel-count">{selected.length}/15 selected</span></div><div className="header-actions"><details className="strategy-settings"><summary className="compact-action">SETTINGS</summary><div className="strategy-popover"><StrategyControls horizon={store.horizon} riskMode={store.riskMode} benchStrategy={store.benchStrategy} setStrategy={store.setStrategy} /></div></details><button className="compact-action" disabled={optimizing} onClick={() => void runOptimize(selected.length < 15)}>{optimizing ? "OPTIMIZING…" : selected.length < 15 ? "COMPLETE SQUAD" : "OPTIMIZE"}</button><button className={`compact-action pick-team-action ${lineupStale ? "stale" : ""}`} onClick={pickGWTeam}>{lineupStale ? "PICK TEAM · OUTDATED" : "PICK TEAM"}</button><PanelToggle panel="squad" collapsed={collapsedPanels.squad} onToggle={() => togglePanel("squad")} /></div></div>
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
          <MetricStrip spent={spent} projected={projected} risk={risk} />
          <TransferSuggestionsPanel suggestions={transferSuggestions} state={transferSuggestionState} message={transferSuggestionMessage} playerById={playerById} onSimulate={simulateMove} />
          {simulation && simulationMove && <div className="squad-overlay"><SimulationPanel result={simulation} move={simulationMove} playerById={playerById} onApply={applySimulation} onDiscard={() => { setSimulation(null); setSimulationMove(null); }} /></div>}
          <PanelResizer panel="squad" onResizeStart={beginPanelResize} />
        </section>

        <section id="terminal-panel-ai" data-panel="ai" className={`ai-column ${collapsedPanels.ai ? "panel-collapsed" : ""} ${store.activeMobileTab === "AI" ? "mobile-visible" : ""}`} aria-label="AI analyst">
          <AnalystPanel messages={aiMessages} busy={aiBusy} online={aiOnline} prompt={aiPrompt} setPrompt={setAiPrompt} onAsk={askAI} onAction={handleAnalystAction} lockedCheck={(id) => store.lockedPlayerIds.includes(id)} playerById={playerById} onQuick={(label) => { if (label === "OPTIMIZE" || label === "FINISH SQUAD") { runOptimize(label === "FINISH SQUAD"); store.setMobileTab("SQUAD"); return; } if (label === "CAPTAIN") { setCaptainDeterministically(); return; } if (label === "WEAK LINK") { store.setMobileTab("SQUAD"); if (weakest[0]) store.setSelectedPlayer(weakest[0].id); return; } if (label === "ANALYZE") { store.setMobileTab("SQUAD"); return; } askAI(label.toLowerCase()); }} textareaRef={aiRef} collapsed={collapsedPanels.ai} onToggle={() => togglePanel("ai")} />
          <PanelResizer panel="ai" onResizeStart={beginPanelResize} />
        </section>
      </div>
      {notice && (noticeMinimized
        ? <button type="button" className="toast toast-pill" aria-label="Show notification" onClick={() => setNoticeMinimized(false)}>{notice}</button>
        : <div className="toast" role="status"><span className="toast-message">{notice}</span><span className="toast-actions"><button type="button" className="toast-button" aria-label="Minimize" onClick={() => setNoticeMinimized(true)}>–</button><button type="button" className="toast-button" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button></span></div>)}
    </main>
  );
}

function ModeChooser({ status, message, gameweek, onChoose }: { status: DataState; message?: string; gameweek: number | null; onChoose: (mode: TerminalMode) => void }) {
  return <main className="mode-screen"><div className="mode-brand"><span className="brand-mark" aria-hidden="true" /><span>FPL TERMINAL</span></div><p className="mode-tagline">QUANTITATIVE FPL SQUAD INTELLIGENCE</p><div className="mode-grid"><button className="mode-card" onClick={() => onChoose("BUILD")}><span className="mode-index">MODE A</span><strong>BUILD FROM SCRATCH</strong><span>Start with £100.0m and construct your squad player by player, with live projections reacting to every pick.</span></button><button className="mode-card" onClick={() => onChoose("ANALYZE")}><span className="mode-index">MODE B</span><strong>ANALYZE A TEAM</strong><span>Enter an existing 15-player squad and get immediate analysis: weakest links, budget inefficiencies, and upgrade opportunities.</span></button></div><div className="mode-footer"><span className={`status-pip ${status.toLowerCase()}`} />{status === "LIVE" ? `LIVE DATA · GAMEWEEK ${gameweek ?? "—"} · MODEL ESTIMATES · SQUAD RULES ENFORCED LOCALLY` : status === "SNAPSHOT" ? `SNAPSHOT DATA · GAMEWEEK ${gameweek ?? "—"}` : status === "STALE" ? `STALE DATA · GAMEWEEK ${gameweek ?? "—"}` : status === "SYNCING" ? "SYNCING FPL MARKET…" : message ?? "FPL data is unavailable."}</div></main>;
}

type ImportedTeam = { entryId: number; teamName?: string; managerName?: string; squad: SquadState; lineup: Omit<ApplyLineupInput, "lineupProjectionFingerprint"> };

function TeamImportScreen({ players, onImport, onBack }: { players: TerminalPlayer[]; onImport: (result: ImportedTeam) => boolean; onBack: () => void }) {
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
      const response = await fetch(`/api/fpl/entry/${id}`, { headers: { accept: "application/json" } });
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
  return <main className="mode-screen import-screen"><button type="button" className="import-back" onClick={onBack}>← BACK</button><div className="mode-brand"><span className="brand-mark" aria-hidden="true" /><span>FPL TERMINAL</span></div><p className="mode-tagline">IMPORT YOUR OFFICIAL FPL TEAM</p><form className="import-card" onSubmit={submit}><label htmlFor="fpl-entry-id">ENTER FPL ID</label><div className="import-controls"><input id="fpl-entry-id" inputMode="numeric" pattern="[0-9]*" autoFocus value={entryId} onChange={(event) => setEntryId(event.target.value)} placeholder="4827193" /><button className="primary-button" type="submit" disabled={busy || !players.length}>{busy ? "IMPORTING…" : "IMPORT TEAM"}</button></div><p>We’ll load Gameweek 1 picks from the official FPL API and fill all 15 squad positions.</p>{!players.length && <span className="import-error" role="status">Waiting for the FPL player list…</span>}{error && <span className="import-error" role="alert">{error}</span>}</form></main>;
}

function StatusCell({ label, value, tone }: { label: string; value: string; tone?: "amber" | "green" | "red" | "cyan" }) { return <div className="status-cell"><span>{label}</span><strong className={tone ?? ""}>{value}</strong></div>; }

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

function PlayerRow({ player, selected, onSelect, onAdd }: { player: TerminalPlayer; selected: boolean; onSelect: () => void; onAdd: () => void }) { return <tr className={selected ? "selected" : ""}><td><button className="player-name-button" onClick={onSelect}><strong>{player.displayName}</strong><small>· {player.teamShortName}</small></button></td><td><span className={`pos-tag ${player.position.toLowerCase()}`}>{player.position}</span></td><td>{player.priceTenths > 0 ? money(player.priceTenths) : "—"}</td><td>{player.ownership > 0 ? `${player.ownership.toFixed(1)}%` : "—"}</td><td className="cyan-text">{points(player.projection?.nextGW)}</td><td>{points(player.projection?.next3)}</td><td>{points(player.projection?.next5)}</td><td>{metric(player.projection?.valueNext5)}</td><td>{expectedMinutesOf(player)}</td><td>{expectedInvolvementPer90(player)}</td><td>{player.projection?.riskScore ? Math.round(player.projection.riskScore) : "—"}</td><td className="fixture-cell"><FixtureRun player={player} /></td><td><button className="add-button" onClick={onAdd} disabled={selected} aria-label={`Add ${player.displayName}`}>{selected ? "IN" : "+"}</button></td></tr>; }

function PlayerDetail({ player, locked, freshness, source, onClose, onAdd, onToggleLock }: { player: TerminalPlayer; locked: boolean; freshness: DataState; source: string | null; onClose: () => void; onAdd: () => void; onToggleLock: () => void }) {
  const selection = player.selection;
  const expectedMinutes = selection?.expectedMinutes ?? player.projection?.expectedMinutes;
  return <aside className="detail-panel" aria-label={`${player.displayName} detail`}>
    <div className="detail-head"><div><span className="section-kicker">PLAYER DETAIL</span><h2>{player.displayName}</h2><p>{player.teamShortName} · {player.position} · {player.ownership ? `${player.ownership.toFixed(1)}% own` : "ownership —"}</p></div><button className="icon-button" onClick={onClose} aria-label="Close player detail">×</button></div>
    <div className="detail-metrics"><Metric label="NEXT GW xP" value={points(player.projection?.nextGW)} tone="cyan" /><Metric label="5GW xP" value={points(player.projection?.next5)} /><Metric label="VALUE" value={metric(player.projection?.valueNext5)} /><Metric label="EXP MIN" value={expectedMinutes ? `${Math.round(expectedMinutes)}′` : "—"} /></div>
    <div className="selection-panel" aria-label={`${player.displayName} selection model`}>
      <div className="selection-head"><div><span className="section-kicker">STARTING STATUS</span><span className="selection-note">Availability and lineup evidence</span></div><span className={`data-badge ${selection ? "model" : "unavailable"}`}>{selection ? "MODEL" : "UNAVAILABLE"}</span></div>
      {selection ? <>
        <div className="selection-metrics"><Metric label="NAILED 1–5" value={String(selection.nailedRating)} tone="amber" /><Metric label="P(START)" value={probability(selection.startProbability)} tone="cyan" /><Metric label="P(CAMEO)" value={probability(selection.cameoProbability)} /><Metric label="CONFIDENCE" value={selection.confidence} /></div>
        <div className="selection-freshness"><span>UPDATED</span><time dateTime={selection.updatedAt || undefined}>{formatSelectionUpdatedAt(selection.updatedAt)}</time><span>MODEL</span><strong>{selectionSourceLabel(selection)}</strong><span>DATA</span><strong>{source ?? "FPL feed"} · {freshnessLabel(freshness)}</strong></div>
        <div className="selection-evidence"><span className="section-kicker">EVIDENCE</span>{selection.evidence.length ? <ul className="selection-evidence-list">{selection.evidence.map((item, index) => <li className="selection-evidence-line" key={`${item.source}-${index}`}><span className={`data-badge ${evidenceBadgeClass(item.source)}`}>{evidenceBadgeLabel(item.source)}</span><span>{item.detail}</span></li>)}</ul> : <span className="selection-empty">No evidence lines were supplied.</span>}</div>
      </> : <p className="selection-unavailable" role="status">Selection model unavailable; lineup probabilities, rating, and evidence were not supplied for this player.</p>}
    </div>
    <div className="detail-list"><div><span>PRICE</span><strong>{money(player.priceTenths)}</strong></div><div><span>CONFIDENCE</span><strong>{selection?.confidence ?? player.projection?.confidence ?? "—"}</strong></div><div><span>RISK</span><strong>{player.projection?.riskScore ? `${Math.round(player.projection.riskScore)}/100` : "—"}</strong></div><div><span>FORM / POINTS</span><strong>{player.current.totalPoints ? player.current.totalPoints : "—"}</strong></div></div>
    <div className="detail-fixtures"><span>FIXTURES · NEXT 5</span><div>{player.fixtures.length ? player.fixtures.slice(0, 5).map((fixture) => <span key={`${fixture.gameweek}-${fixture.opponentTeamId}`}>{fixture.opponentShortName}{fixture.isHome ? "(H)" : "(A)"}</span>) : <span>—</span>}</div></div>
    <div className="detail-actions"><button className="primary-button" onClick={onAdd}>ADD TO SQUAD</button><button className={`secondary-button ${locked ? "locked" : ""}`} onClick={onToggleLock}>{locked ? "UNLOCK PLAYER" : "LOCK PLAYER"}</button></div>
    <div className="provenance"><span className="data-badge live">LIVE</span> Price, status, ownership and current points come from the FPL feed.<br /><span className="data-badge model">MODEL</span> Projection fields are FPL Terminal estimates when present.</div>
  </aside>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) { return <div><span>{label}</span><strong className={tone ?? ""}>{value}</strong></div>; }

function SquadSlot({ player, locked, captain, vice, starter, benchLabel, benchIndex, lineupActive, swapSelected, onRemove, onToggleLock, onSelect, onSwap, onCaptain, onViceCaptain, onMoveBench }: { player: TerminalPlayer; locked: boolean; captain: boolean; vice: boolean; starter: boolean; benchLabel?: string; benchIndex: number; lineupActive: boolean; swapSelected: boolean; onRemove: () => void; onToggleLock: () => void; onSelect: () => void; onSwap: () => void; onCaptain: () => void; onViceCaptain: () => void; onMoveBench: (direction: -1 | 1) => void }) {
  const benched = Boolean(benchLabel);
  return <article className={`squad-slot filled ${locked ? "locked" : ""} ${benched ? "benched" : ""} ${swapSelected ? "lineup-selected" : ""}`}>
    <button className="slot-main" onClick={onSelect}><span className="slot-player">{player.displayName}</span><span className="slot-sub">{player.teamShortName} · {money(player.priceTenths)}</span><span className="slot-xp">{points(player.projection?.nextGW)} <small>xP</small></span></button>
    <div className="slot-flags"><button className={`lock-flag ${locked ? "on" : ""}`} onClick={onToggleLock} aria-label={`${locked ? "Unlock" : "Lock"} ${player.displayName}`} aria-pressed={locked}><svg className="lock-icon" viewBox="0 0 16 16" aria-hidden="true"><path className="lock-shackle" d="M4 7V5a4 4 0 0 1 8 0v2" /><rect className="lock-body" x="2.5" y="7" width="11" height="7" /></svg></button>{!locked && <button className="remove-flag" onClick={onRemove} aria-label={`Remove ${player.displayName}`}>×</button>}</div>
    {lineupActive && <div className="lineup-controls">{starter ? <><button className={`role-button captain ${captain ? "active" : ""}`} onClick={onCaptain} aria-label={`Make ${player.displayName} captain`} aria-pressed={captain}>C</button><button className={`role-button vice ${vice ? "active" : ""}`} onClick={onViceCaptain} aria-label={`Make ${player.displayName} vice-captain`} aria-pressed={vice}>VC</button><button className="role-button bench-toggle" onClick={onSwap} aria-label={`Select ${player.displayName} to move to bench`} aria-pressed={swapSelected}>B</button></> : <><button className="role-button bench-toggle active" onClick={onSwap} aria-label={`Select ${player.displayName} to move into the starting XI`} aria-pressed={swapSelected}>{benchLabel}</button>{benchIndex >= 0 && <><button className="role-button bench-order" disabled={benchIndex === 0} onClick={() => onMoveBench(-1)} aria-label={`Move ${player.displayName} up the bench order`}>↑</button><button className="role-button bench-order" disabled={benchIndex === 2} onClick={() => onMoveBench(1)} aria-label={`Move ${player.displayName} down the bench order`}>↓</button></>}</>}</div>}
  </article>;
}

function EmptySlot({ position, maxPriceTenths, onChoose }: { position: Position; maxPriceTenths: number; onChoose: () => void }) { return <button className="squad-slot empty-slot" onClick={onChoose}><span className="empty-plus">+</span><span className="slot-player">Open {position}</span><span className="slot-sub">Max {money(maxPriceTenths)}</span><span className="suggest-label">SUGGEST →</span></button>; }

function MetricStrip({ spent, projected, risk }: { spent: number; projected: { nextGW?: number; next3?: number; next5?: number }; risk?: number }) { return <div className="metric-strip" aria-label="Squad projection metrics"><Metric label="COST" value={money(spent)} /><Metric label="ITB" value={money(1000 - spent)} tone={spent <= 1000 ? "green" : "red"} /><Metric label="GW xP" value={points(projected.nextGW)} tone="cyan" /><Metric label="3GW" value={points(projected.next3)} /><Metric label="5GW" value={points(projected.next5)} /><Metric label="RISK" value={risk === undefined ? "—" : risk < 30 ? "LOW" : risk < 60 ? "MED" : "HIGH"} /></div>; }

function StrategyControls({ horizon, riskMode, benchStrategy, setStrategy }: { horizon: 1 | 3 | 5; riskMode: "SAFE" | "BALANCED" | "AGGRESSIVE"; benchStrategy: "CHEAP" | "BALANCED" | "STRONG"; setStrategy: (strategy: { horizon?: 1 | 3 | 5; riskMode?: "SAFE" | "BALANCED" | "AGGRESSIVE"; benchStrategy?: "CHEAP" | "BALANCED" | "STRONG" }) => void }) { return <div className="strategy-panel"><span className="section-kicker">OPTIMIZER SETTINGS</span><div><span className="strategy-label">HORIZON</span><div className="segmented">{([1, 3, 5] as const).map((value) => <button key={value} className={horizon === value ? "active" : ""} onClick={() => setStrategy({ horizon: value })}>{value === 1 ? "GW" : `${value}GW`}</button>)}</div></div><div><span className="strategy-label">RISK</span><div className="segmented">{(["SAFE", "BALANCED", "AGGRESSIVE"] as const).map((value) => <button key={value} className={riskMode === value ? "active" : ""} onClick={() => setStrategy({ riskMode: value })}>{value.slice(0, 4)}</button>)}</div></div><div><span className="strategy-label">BENCH</span><div className="segmented">{(["CHEAP", "BALANCED", "STRONG"] as const).map((value) => <button key={value} className={benchStrategy === value ? "active" : ""} onClick={() => setStrategy({ benchStrategy: value })}>{value.slice(0, 4)}</button>)}</div></div></div>; }

function TransferSuggestionsPanel({ suggestions, state, message, playerById, onSimulate }: { suggestions: SingleTransferSuggestion[]; state: "INCOMPLETE" | "LOADING" | "READY" | "ERROR"; message: string | null; playerById: Map<number, TerminalPlayer>; onSimulate: (outId: number, inId: number) => void }) { return <section className="replacement-panel unified-replacements" aria-label="Transfer suggestions"><div className="subsection-head"><div><span className="section-kicker">TRANSFER SUGGESTIONS</span><span className="panel-count">EXACT</span></div></div><div className="replacement-scroll">{suggestions.length ? suggestions.map((suggestion) => { const outgoing = playerById.get(suggestion.outgoingPlayerId); const incoming = playerById.get(suggestion.incomingPlayerId); const kind = suggestion.kind === "BOTH" ? "xP + CASH" : "xP UPGRADE"; return <div className="replacement-row" key={`${suggestion.outgoingPlayerId}-${suggestion.incomingPlayerId}`}><div><strong>{outgoing?.displayName ?? `Player ${suggestion.outgoingPlayerId}`} → {incoming?.displayName ?? `Player ${suggestion.incomingPlayerId}`}</strong><small>{kind} · {incoming?.teamShortName ?? "—"} · {incoming ? money(incoming.priceTenths) : "—"}</small></div><div className="transfer-effects"><span className="green">+{suggestion.projectedDelta.toFixed(1)} xP</span><span>{suggestion.cashReleasedTenths >= 0 ? "+" : "−"}{money(Math.abs(suggestion.cashReleasedTenths))} ITB</span></div><button className="compact-action" onClick={() => onSimulate(suggestion.outgoingPlayerId, suggestion.incomingPlayerId)}>SIMULATE</button></div>; }) : <div className="empty-copy">{state === "LOADING" ? "CALCULATING LEGAL xP-INCREASING TRANSFERS…" : state === "INCOMPLETE" ? "Complete a legal 15-player squad to calculate exact transfers." : state === "ERROR" ? message ?? "Exact transfer search is unavailable." : "No legal single transfer increases optimized lineup xP."}</div>}</div></section>; }

function SimulationPanel({ result, move, playerById, onApply, onDiscard }: { result: SimulationResult; move: { outId: number; inId: number }; playerById: Map<number, TerminalPlayer>; onApply: () => void; onDiscard: () => void }) { return <section className="panel simulation-panel"><div className="panel-header"><div><span className="section-kicker">SIMULATION</span><span className="panel-count">{result.legal ? "LEGAL" : "CHECK REQUIRED"}</span></div><button className="icon-button" onClick={onDiscard} aria-label="Close simulation">×</button></div><div className="simulation-move">{playerById.get(move.outId)?.displayName ?? "Outgoing"} <span>→</span> {playerById.get(move.inId)?.displayName ?? "Incoming"}</div><div className="simulation-grid"><div><span>CURRENT {result.horizon}GW xP</span><strong>{points(result.optimizedBeforeXp)}</strong></div><div><span>SIMULATED {result.horizon}GW xP</span><strong>{points(result.optimizedAfterXp)}</strong></div><div><span>PRICE EFFECT</span><strong>{money(result.priceDeltaTenths)}</strong></div><div><span>xP EFFECT</span><strong className={result.projectedDelta >= 0 ? "green" : "red"}>{result.projectedDelta >= 0 ? "+" : ""}{result.projectedDelta.toFixed(1)}</strong></div></div><p className="simulation-note">{result.explanationFactors[0] ?? "Model comparison complete."}{!result.legal && " The current selection still has a squad-rules issue."}</p><div className="simulation-actions"><button className="primary-button" onClick={onApply}>APPLY CHANGES</button><button className="secondary-button" onClick={onDiscard}>DISCARD</button></div></section>; }

const PROMPT_CARDS: Array<{ title: string; detail: string; prompt: string }> = [
  { title: "ANALYZE SQUAD", detail: "Strengths, weak links and the next move", prompt: "Analyze my current squad and suggest the next move" },
  { title: "WEAKEST LINK", detail: "Who is holding the squad back", prompt: "Who is my weakest link and who should replace them?" },
  { title: "CAPTAIN PICK", detail: "Best captaincy for the next gameweek", prompt: "Who should I captain this gameweek?" },
  { title: "BENCH CHECK", detail: "Is my bench strong enough?", prompt: "Is my bench strong enough for the next gameweek?" },
];

type AssistantActionHint = { type?: string; playerId?: unknown; outId?: unknown; inId?: unknown };

function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function AnalystPanel({ messages, busy, online, prompt, setPrompt, onAsk, onQuick, onAction, lockedCheck, playerById, textareaRef, collapsed, onToggle }: {
  messages: Array<{ role: "user" | "assistant"; text: string; at?: number; actions?: AssistantActionHint[] }>;
  busy: boolean;
  online: boolean | null;
  prompt: string;
  setPrompt: (value: string) => void;
  onAsk: (prompt: string) => void;
  onQuick: (label: string) => void;
  onAction: (action: AssistantActionHint) => void;
  lockedCheck: (id: number) => boolean;
  playerById: Map<number, TerminalPlayer>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const offlineCopy = online === false ? "AI analyst offline. Add DEEPSEEK_API_KEY to .env.local to enable conversational analysis." : null;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);
  const actionLabel = (action: AssistantActionHint): string | null => {
    const playerId = numberOf(action.playerId);
    if (action.type === "VIEW_PLAYER" && playerId !== undefined) return `VIEW ${playerById.get(playerId)?.displayName ?? "#" + playerId}`;
    if (action.type === "LOCK_PLAYER" && playerId !== undefined) return `${lockedCheck(playerId) ? "UNLOCK" : "LOCK"} ${playerById.get(playerId)?.displayName ?? "#" + playerId}`;
    if (action.type === "OPTIMIZE") return "RUN OPTIMIZER";
    const outId = numberOf(action.outId);
    const inId = numberOf(action.inId);
    if (action.type === "SIMULATE_TRANSFER" && outId !== undefined && inId !== undefined) return `PREVIEW ${playerById.get(outId)?.displayName ?? "#" + outId} → ${playerById.get(inId)?.displayName ?? "#" + inId}`;
    return null;
  };
  return (
    <section className={`panel analyst-panel ${collapsed ? "panel-collapsed" : ""}`}>
      <div className="panel-header">
        <div>
          <span className="section-kicker">AI ANALYST</span>
          <span className="panel-count">{online === true ? "ONLINE" : online === false ? "OFFLINE SHELL" : "CHECKING"}</span>
        </div>
        <div className="header-actions">
          <span className={`data-badge ${online === true ? "green" : "model"}`}>{online === false ? "OFFLINE" : "DEEPSEEK"}</span>
          <PanelToggle panel="ai" collapsed={collapsed} onToggle={onToggle} />
        </div>
      </div>
      <div className="analyst-scroll" ref={scrollRef}>
        {!messages.length && !busy && offlineCopy && <div className="analyst-block"><p>{offlineCopy}</p></div>}
        {!messages.length && !busy && !offlineCopy && (
          <div className="prompt-cards">
            {PROMPT_CARDS.map((card) => (
              <button key={card.title} type="button" className="prompt-card" onClick={() => onAsk(card.prompt)}>
                <strong>{card.title}</strong>
                <span>{card.detail}</span>
              </button>
            ))}
          </div>
        )}
        {messages.map((message, index) => (
          <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
            <span className="message-label">
              {message.role === "user" ? "> YOU" : "ANALYST"}
              {message.at ? <time className="message-time">{clockLabel(message.at)}</time> : null}
            </span>
            <p>{message.text}</p>
            {message.role === "assistant" && message.actions?.length ? (
              <div className="message-actions">
                {message.actions.map((action, actionIndex) => {
                  const label = actionLabel(action);
                  return label ? <button key={`${action.type}-${actionIndex}`} type="button" onClick={() => onAction(action)}>{label}</button> : null;
                })}
              </div>
            ) : null}
          </div>
        ))}
        {busy && (
          <div className="message assistant">
            <span className="message-label">ANALYST</span>
            <p className="thinking" aria-label="Analyst thinking"><i /><i /><i /></p>
          </div>
        )}
      </div>
      <form className="ai-composer" onSubmit={(event) => { event.preventDefault(); onAsk(prompt); }}>
        <div className="command-chips" role="toolbar" aria-label="Quick commands">
          {["ANALYZE", "OPTIMIZE", "WEAK LINK", "FINISH SQUAD", "CHEAPEN BENCH", "CAPTAIN"].map((label) => (
            <button key={label} type="button" onClick={() => onQuick(label)}>{label}</button>
          ))}
        </div>
        <div className="ai-input">
          <span>&gt;</span>
          <textarea ref={textareaRef} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask about this squad..." rows={2} aria-label="Ask the AI analyst" />
          <button type="submit" disabled={!prompt.trim() || busy} aria-label="Send analyst query">↗</button>
        </div>
      </form>
    </section>
  );
}

function probability(value: number): string { return `${Math.round(clamp(value, 0, 1) * 100)}%`; }
export function formatSelectionUpdatedAt(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${relativeAge(value)}`;
}
function freshnessLabel(value: DataState): string { return value === "LIVE" ? "LIVE" : value === "SNAPSHOT" ? "SNAPSHOT" : value === "STALE" ? "STALE" : value === "SYNCING" ? "SYNCING" : "UNAVAILABLE"; }
function evidenceBadgeLabel(source: SelectionEvidence["source"]): string { return source === "ROTOWIRE_XI" ? "RotoWire XI" : source === "ROTOWIRE_AVAILABILITY" ? "RotoWire" : source === "FPL_STATUS" ? "LIVE FPL" : "MODEL"; }
function evidenceBadgeClass(source: SelectionEvidence["source"]): "rotowire" | "live" | "model" { return source === "ROTOWIRE_XI" || source === "ROTOWIRE_AVAILABILITY" ? "rotowire" : source === "FPL_STATUS" ? "live" : "model"; }
function selectionSourceLabel(selection: PlayerSelection): string {
  const sources = selection.evidence.map((item) => item.source);
  return [sources.some((item) => item.startsWith("ROTOWIRE")) ? "RotoWire" : "", sources.includes("HISTORICAL_STARTS") ? "history" : "", sources.includes("FPL_STATUS") ? "FPL" : ""].filter(Boolean).join(" + ") || "model estimate";
}
function formatDeadline(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function relativeAge(value: string): string { const elapsed = Math.max(0, Date.now() - Date.parse(value)); if (!Number.isFinite(elapsed)) return "—"; const minutes = Math.floor(elapsed / 60000); return minutes < 1 ? "<1m" : `${minutes}m ago`; }

function exportState(state: ReturnType<typeof useTerminalStore.getState>) { const blob = new Blob([JSON.stringify(exportTerminalState(state), null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "fpl-terminal-state.json"; anchor.click(); URL.revokeObjectURL(url); }

function importState(event: React.ChangeEvent<HTMLInputElement>, state: ReturnType<typeof useTerminalStore.getState>) { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { const parsed = typeof reader.result === "string" ? parseSavedState(reader.result) : null; if (parsed) state.hydrate(parsed); }; reader.readAsText(file); event.target.value = ""; }

export function ModeChooserPreview() { return null; }
