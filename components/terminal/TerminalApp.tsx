"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { NailedRating, Player, PlayerFixture, PlayerSelection, Position, ReplacementCandidate, SelectionEvidence, SimulationResult, WeeklyLineupPlan } from "@/types";
import { analyzeSquad } from "@/lib/analysis/analyzeSquad";
import { findReplacements } from "@/lib/analysis/replacements";
import { simulateChange as simulateSquadChange } from "@/lib/analysis/simulateChange";
import { chooseCaptainVice } from "@/lib/squad/captain";
import { calculateBudgetFeasibility, explainIllegalSelection, maxSafePriceForPosition } from "@/lib/squad/budget";
import { expectedAutosubValue, pickWeeklyTeam, validateWeeklyLineup } from "@/lib/squad/weeklyLineup";
import type { OptimizerResult } from "@/lib/optimizer/optimizer";
import { projectPlayer } from "@/lib/projections/projectPlayer";
import {
  exportTerminalState,
  parseSavedState,
  deriveStartingXI,
  useTerminalStore,
  type TerminalFilters,
  type TerminalMode,
  type SortKey,
} from "@/store/terminalStore";

type UnknownRecord = Record<string, unknown>;
type DataState = "SYNCING" | "LIVE" | "SNAPSHOT" | "STALE" | "EMPTY" | "ERROR";

const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];
const POSITION_LIMITS: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
type DesktopPanel = "market" | "squad" | "analysis" | "ai";
const DESKTOP_PANELS: DesktopPanel[] = ["market", "squad", "analysis", "ai"];
const PANEL_LABELS: Record<DesktopPanel, string> = { market: "Player universe", squad: "Squad builder", analysis: "Squad analysis", ai: "AI analyst" };

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
    fixtures: [],
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

function normalizeBootstrap(value: unknown): Bootstrap {
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
  return <span className="fixture-run">{player.fixtures.slice(0, 5).map((fixture) => <span className={(fixture.difficulty ?? 3) <= 2 ? "easy" : (fixture.difficulty ?? 3) >= 4 ? "hard" : ""} key={`${fixture.gameweek}-${fixture.opponentTeamId}`}>{fixture.opponentShortName}({fixture.isHome ? "H" : "A"})</span>)}</span>;
}

function weeklyPoints(plan: WeeklyLineupPlan): number {
  return plan.projectedTotal;
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
  const [pasteText, setPasteText] = useState("");
  const [pasteMessage, setPasteMessage] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState<Array<{ name: string; matches: TerminalPlayer[] }>>([]);
  const [aiMessages, setAiMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiOnline, setAiOnline] = useState<boolean | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [showReplacements, setShowReplacements] = useState(false);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [simulationMove, setSimulationMove] = useState<{ outId: number; inId: number } | null>(null);
  const [squadView, setSquadView] = useState<"BUILD" | "GW TEAM">("BUILD");
  const [gwDraft, setGwDraft] = useState<WeeklyLineupPlan | null>(null);
  const [gwSwapSelection, setGWSwapSelection] = useState<{ starterId?: number; benchId?: number }>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const aiRef = useRef<HTMLTextAreaElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const [collapsedPanels, setCollapsedPanels] = useState<Record<DesktopPanel, boolean>>({ market: false, squad: false, analysis: false, ai: false });
  const [panelRatios, setPanelRatios] = useState<Partial<Record<DesktopPanel, number>>>({});
  const { data, status, message, refresh } = bootstrap;

  const togglePanel = (panel: DesktopPanel) => setCollapsedPanels((current) => ({ ...current, [panel]: !current[panel] }));

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
    const ratios = Object.fromEntries(DESKTOP_PANELS.map((name, index) => [name, widths[index] / availableWidth])) as Record<DesktopPanel, number>;
    resizeRef.current = { panel, neighbor, direction: panelIndex === DESKTOP_PANELS.length - 1 ? -1 : 1, startX: event.clientX, currentWidth: widths[panelIndex], neighborWidth: widths[neighborIndex], availableWidth, ratios };
    setPanelRatios(ratios);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.preventDefault();
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      const delta = clamp((event.clientX - resize.startX) * resize.direction, 260 - resize.currentWidth, resize.neighborWidth - 260);
      setPanelRatios({ ...resize.ratios, [resize.panel]: (resize.currentWidth + delta) / resize.availableWidth, [resize.neighbor]: (resize.neighborWidth - delta) / resize.availableWidth });
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
  }, [store.isHydrated, store.playerIds, store.byPosition, store.benchGoalkeeperId, store.benchOrder, store.lineupGameweek, store.lineupProjectionFingerprint, store.lockedPlayerIds, store.captainId, store.viceCaptainId, store.horizon, store.riskMode, store.benchStrategy]);

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
  const feasibility = useMemo(() => calculateBudgetFeasibility(selected, data.players), [data.players, selected]);
  const slotMaxPrices = useMemo(() => POSITIONS.reduce((result, position) => {
    result[position] = maxSafePriceForPosition(position, selected, data.players);
    return result;
  }, {} as Record<Position, number>), [data.players, selected]);
  const projected = useMemo(() => ({
    nextGW: selected.length ? squadAnalysis.projectedNextGW : undefined,
    next3: selected.length ? squadAnalysis.projectedNext3 : undefined,
    next5: selected.length ? squadAnalysis.projectedNext5 : undefined,
  }), [selected.length, squadAnalysis.projectedNext3, squadAnalysis.projectedNext5, squadAnalysis.projectedNextGW]);
  const weeklyEnginePlan = useMemo(() => pickWeeklyTeam({
    squad: selected,
    gameweek: data.gameweek ?? 1,
    riskMode: store.riskMode,
  }), [data.gameweek, selected, store.riskMode]);
  const lineupApplied = store.lineupGameweek !== undefined && store.lineupProjectionFingerprint !== undefined;
  const currentGWPlan = useMemo<WeeklyLineupPlan | null>(() => {
    if (!lineupApplied || store.benchGoalkeeperId === undefined || store.benchOrder.length !== 3) return null;
    const startingXI = deriveStartingXI(store.playerIds, store.benchGoalkeeperId, store.benchOrder);
    return persistedLineupPlan(weeklyEnginePlan, startingXI, store.benchGoalkeeperId, store.benchOrder, store.captainId, store.viceCaptainId, playerById);
  }, [lineupApplied, playerById, store.benchGoalkeeperId, store.benchOrder, store.captainId, store.playerIds, store.viceCaptainId, weeklyEnginePlan]);
  const draftActive = Boolean(gwDraft && gwDraft.gameweek === weeklyEnginePlan.gameweek && gwDraft.projectionFingerprint === weeklyEnginePlan.projectionFingerprint);
  const proposedGWPlan = draftActive ? gwDraft : currentGWPlan;
  const gwCurrentPoints = useMemo(() => currentGWPlan ? weeklyPoints(currentGWPlan) : 0, [currentGWPlan]);
  const gwProposedPoints = useMemo(() => proposedGWPlan ? weeklyPoints(proposedGWPlan) : 0, [proposedGWPlan]);
  const gwDirty = draftActive;
  const lineupStale = lineupApplied && (store.lineupGameweek !== weeklyEnginePlan.gameweek || store.lineupProjectionFingerprint !== weeklyEnginePlan.projectionFingerprint);
  const risk = useMemo(() => {
    if (!selected.length) return undefined;
    const values = selected.map((player) => player.projection?.riskScore ?? 0).filter((value) => value > 0);
    return values.length === selected.length && values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : undefined;
  }, [selected]);
  const weakest = useMemo(() => squadAnalysis.weaknesses
    .slice(0, 3)
    .map((weakness) => playerById.get(weakness.playerId))
    .filter((player): player is TerminalPlayer => Boolean(player)), [playerById, squadAnalysis.weaknesses]);
  const replacements = useMemo<ReplacementCandidate[]>(() => {
    const outgoingPlayerId = squadAnalysis.weaknesses[0]?.playerId;
    if (!outgoingPlayerId || !data.players.length) return [];
    const engineCandidates = findReplacements({
      outgoingPlayerId,
      squad: store.playerIds,
      players: data.players,
      horizon: store.horizon,
      risk: store.riskMode,
      bench: store.benchStrategy,
    }).slice(0, 5);
    if (engineCandidates.length) return engineCandidates;
    const outgoing = playerById.get(outgoingPlayerId);
    if (!outgoing) return [];
    return data.players
      .filter((player) => player.position === outgoing.position && !store.playerIds.includes(player.id))
      .sort((left, right) => (right.projection?.next5 ?? 0) - (left.projection?.next5 ?? 0) || left.priceTenths - right.priceTenths)
      .slice(0, 5)
      .map((player) => ({
        playerId: player.id,
        priceTenths: player.priceTenths,
        projectedNext5: player.projection?.next5 ?? 0,
        projectedDelta: (player.projection?.next5 ?? 0) - (outgoing.projection?.next5 ?? 0),
        bankDeltaTenths: outgoing.priceTenths - player.priceTenths,
        expectedMinutes: player.projection?.expectedMinutes ?? 0,
        confidence: player.projection?.confidence ?? "LOW",
        reason: "Same-position model alternative",
      }));
  }, [data.players, playerById, squadAnalysis.weaknesses, store.benchStrategy, store.horizon, store.playerIds, store.riskMode]);

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
      window.setTimeout(() => setNotice(null), 2400);
    } else {
      setNotice(`No open ${player.position} slot, or the squad already contains this player.`);
    }
  }, [data.players, selected]);

  const handlePaste = () => {
    const names = pasteText.split(/[\n,]+/).map((name) => name.trim()).filter(Boolean);
    if (!names.length) {
      setPasteMessage("Paste names separated by commas or new lines.");
      return;
    }
    const nextAmbiguous: Array<{ name: string; matches: TerminalPlayer[] }> = [];
    let unresolved = 0;
    for (const name of names) {
      const token = normalizeName(name);
      const matches = data.players.filter((player) => normalizeName(player.displayName) === token || normalizeName(player.lastName) === token || normalizeName(`${player.firstName}${player.lastName}`) === token);
      if (matches.length === 1) addPlayer(matches[0]);
      else if (matches.length > 1) nextAmbiguous.push({ name, matches });
      else unresolved += 1;
    }
    setAmbiguous(nextAmbiguous);
    setPasteMessage(`${names.length - unresolved - nextAmbiguous.length} added · ${nextAmbiguous.length} need selection · ${unresolved} not found`);
  };

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

  const updateGWPlan = (changes: Partial<WeeklyLineupPlan>) => {
    if (!proposedGWPlan) return;
    setGwDraft({ ...proposedGWPlan, ...changes });
  };

  const pickGWTeam = () => {
    if (weeklyEnginePlan.starterIds.length !== 11 || weeklyEnginePlan.benchOrder.length !== 3 || weeklyEnginePlan.benchGoalkeeperId === 0) {
      setNotice("Complete a legal 15-player squad before picking a GW TEAM.");
      return;
    }
    setGwDraft(weeklyEnginePlan);
    setGWSwapSelection({});
    setNotice("GW TEAM picked. Review the proposed lineup before applying it.");
  };

  const selectGWSwapPlayer = (role: "starter" | "bench", id: number) => {
    if (!proposedGWPlan) return;
    const nextSelection = role === "starter" ? { ...gwSwapSelection, starterId: id } : { ...gwSwapSelection, benchId: id };
    const starterId = nextSelection.starterId;
    const benchId = nextSelection.benchId;
    if (starterId === undefined || benchId === undefined) {
      setGWSwapSelection(nextSelection);
      setNotice(`Select a ${role === "starter" ? "bench player" : "starter"} to propose the swap.`);
      return;
    }
    const starters = [...proposedGWPlan.starterIds];
    const bench = [proposedGWPlan.benchGoalkeeperId, ...proposedGWPlan.benchOrder];
    const starterIndex = starters.indexOf(starterId);
    const benchIndex = bench.indexOf(benchId);
    if (starterIndex < 0 || benchIndex < 0) return;
    if (proposedGWPlan.captainId === starterId || proposedGWPlan.viceCaptainId === starterId) {
      setNotice("Choose a different captain or vice-captain before moving that starter to the bench.");
      setGWSwapSelection({});
      return;
    }
    starters[starterIndex] = benchId;
    bench[benchIndex] = starterId;
    const benchGoalkeeperId = bench.find((id) => playerById.get(id)?.position === "GK");
    const nextPlan = persistedLineupPlan(proposedGWPlan, starters, benchGoalkeeperId, bench.filter((id) => id !== benchGoalkeeperId), proposedGWPlan.captainId, proposedGWPlan.viceCaptainId, playerById);
    if (!validateWeeklyLineup(nextPlan, selected).legal) {
      setNotice("That swap would leave an invalid starting formation. Pick a compatible player.");
      setGWSwapSelection({});
      return;
    }
    updateGWPlan(nextPlan);
    setGWSwapSelection({});
    setNotice(`${playerById.get(benchId)?.displayName ?? "Player"} proposed to start.`);
  };

  const moveGWBench = (id: number, direction: -1 | 1) => {
    if (!proposedGWPlan) return;
    const index = proposedGWPlan.benchOrder.indexOf(id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= proposedGWPlan.benchOrder.length) return;
    const bench = [...proposedGWPlan.benchOrder];
    [bench[index], bench[nextIndex]] = [bench[nextIndex], bench[index]];
    updateGWPlan(persistedLineupPlan(proposedGWPlan, proposedGWPlan.starterIds, proposedGWPlan.benchGoalkeeperId, bench, proposedGWPlan.captainId, proposedGWPlan.viceCaptainId, playerById));
  };

  const makeGWCaptain = (id: number) => {
    if (!proposedGWPlan) return;
    const viceCaptainId = proposedGWPlan.viceCaptainId === id ? proposedGWPlan.captainId : proposedGWPlan.viceCaptainId;
    if (viceCaptainId === undefined || viceCaptainId === id) return;
    updateGWPlan(persistedLineupPlan(proposedGWPlan, proposedGWPlan.starterIds, proposedGWPlan.benchGoalkeeperId, proposedGWPlan.benchOrder, id, viceCaptainId, playerById));
  };

  const makeGWViceCaptain = (id: number) => {
    if (!proposedGWPlan) return;
    const captainId = proposedGWPlan.captainId === id ? proposedGWPlan.viceCaptainId : proposedGWPlan.captainId;
    if (captainId === undefined || captainId === id) return;
    updateGWPlan(persistedLineupPlan(proposedGWPlan, proposedGWPlan.starterIds, proposedGWPlan.benchGoalkeeperId, proposedGWPlan.benchOrder, captainId, id, playerById));
  };

  const applyGWTeam = () => {
    if (!proposedGWPlan) return;
    if (selected.length < 15 || proposedGWPlan.starterIds.length !== 11 || proposedGWPlan.benchOrder.length !== 3 || proposedGWPlan.benchGoalkeeperId === 0) {
      setNotice("Complete a legal 15-player squad before applying the GW TEAM pick.");
      return;
    }
    if (proposedGWPlan.captainId === undefined || proposedGWPlan.viceCaptainId === undefined) {
      setNotice("Choose a captain and vice-captain before applying the GW TEAM pick.");
      return;
    }
    const applied = store.applyLineup({
      gameweek: proposedGWPlan.gameweek,
      lineupProjectionFingerprint: proposedGWPlan.projectionFingerprint,
      benchGoalkeeperId: proposedGWPlan.benchGoalkeeperId,
      benchOrder: [...proposedGWPlan.benchOrder],
      captainId: proposedGWPlan.captainId,
      viceCaptainId: proposedGWPlan.viceCaptainId,
    });
    if (!applied) {
      setNotice("The weekly pick failed the squad rules. Review the starting XI and bench order.");
      return;
    }
    setGwDraft(null);
    setGWSwapSelection({});
    setNotice("GW TEAM pick applied for this squad.");
  };

  const discardGWTeam = () => {
    setGwDraft(null);
    setGWSwapSelection({});
    setNotice("GW TEAM changes discarded.");
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
    store.removePlayer(outgoing.id);
    store.addPlayer(incoming.id, incoming.position);
    setSimulation(null);
    setSimulationMove(null);
    setNotice(`${outgoing.displayName} → ${incoming.displayName} applied.`);
  };

  const askAI = async (prompt: string) => {
    const text = prompt.trim();
    if (!text || aiBusy) return;
    setAiPrompt("");
    setAiMessages((messages) => [...messages, { role: "user", text }]);
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
      setAiMessages((messages) => [...messages, { role: "assistant", text: answer }]);
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
          setGwDraft(candidate);
          setSquadView("GW TEAM");
          store.setMobileTab("SQUAD");
          setNotice("AI weekly team proposal ready for review. Use APPLY LINEUP to save it.");
        } else {
          setNotice("AI weekly team proposal failed validation against the current squad and projections.");
        }
      }
      setAiOnline(true);
    } catch {
      setAiOnline(false);
      setAiMessages((messages) => [...messages, { role: "assistant", text: "AI analyst is offline. The squad controls and deterministic analysis remain available; no model output was used." }]);
    } finally {
      setAiBusy(false);
    }
  };

  const reset = () => {
    if (window.confirm("Reset the current squad and saved terminal state?")) {
      store.reset();
      window.localStorage.removeItem("fpl-terminal-state");
      setNotice("Terminal state reset.");
    }
  };

  if (store.mode === null) {
    return <ModeChooser status={status} message={message} gameweek={data.gameweek} onChoose={(mode) => store.setMode(mode)} />;
  }

  const selectedPlayer = store.selectedPlayerId ? playerById.get(store.selectedPlayerId) : undefined;
  const isAnalyze = store.mode === "ANALYZE";
  const gridStyle = Object.fromEntries(DESKTOP_PANELS.flatMap((panel) => {
    const value = collapsedPanels[panel] ? "52px" : panelRatios[panel] ? `${panelRatios[panel]}fr` : undefined;
    return value ? [[`--${panel}-column`, value]] : [];
  })) as CSSProperties;
  const resetFilters = () => {
    store.setSearch("");
    store.setFilters({ position: "ALL", club: "", minPrice: "", maxPrice: "", minOwnership: "", maxOwnership: "", availability: "ALL", confidence: "ALL", risk: "ALL", affordableOnly: false, excludeSelected: false, quick: "ALL" });
  };
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

      <nav className="mobile-tabs" aria-label="Terminal panels">{(["SQUAD", "ANALYSIS", "MARKET", "AI"] as const).map((tab) => <button key={tab} className={store.activeMobileTab === tab ? "active" : ""} onClick={() => store.setMobileTab(tab)}>{tab}</button>)}</nav>

      {isAnalyze && <section className="paste-strip panel"><div><span className="section-kicker">ANALYZE A TEAM</span><p>Paste names from your current squad. Matches stay local; uncertain names require a choice.</p></div><textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder="Raya\nGabriel, Haaland" aria-label="Paste squad player names" /><button className="primary-button" onClick={handlePaste}>RESOLVE NAMES</button>{pasteMessage && <span className="inline-note">{pasteMessage}</span>}</section>}
      {ambiguous.length > 0 && <section className="ambiguity panel" aria-live="polite"><div className="section-kicker">SELECT AMBIGUOUS MATCHES</div>{ambiguous.map((item) => <div className="ambiguity-row" key={item.name}><span>{item.name}</span><div>{item.matches.map((player) => <button key={player.id} className="choice-button" onClick={() => { addPlayer(player); setAmbiguous((current) => current.filter((entry) => entry.name !== item.name)); }}>{player.displayName} · {player.teamShortName}</button>)}</div></div>)}</section>}

      <div className="terminal-grid" style={gridStyle}>
        <section id="terminal-panel-market" data-panel="market" className={`market-column ${collapsedPanels.market ? "panel-collapsed" : ""} ${store.activeMobileTab === "MARKET" ? "mobile-visible" : ""}`} aria-label="Player universe">
          <div className="panel-header"><div><span className="section-kicker">PLAYER UNIVERSE</span><span className="panel-count">{data.players.length || "—"} records</span></div><div className="header-actions"><span className={`data-badge ${status.toLowerCase()}`}>{status === "LIVE" ? "LIVE FPL" : status === "SYNCING" ? "SYNCING" : "NO LIVE DATA"}</span><PanelToggle panel="market" collapsed={collapsedPanels.market} onToggle={() => togglePanel("market")} /></div></div>
          <div className="search-wrap"><span aria-hidden="true">/</span><input ref={searchRef} value={store.search} onChange={(event) => store.setSearch(event.target.value)} placeholder="Search player, club..." aria-label="Search players" /><kbd>/</kbd></div>
          <FilterBar filters={store.filters} setFilters={store.setFilters} players={data.players} onReset={resetFilters} />
          <div className="table-wrap"><table className="player-table"><thead><tr><SortableHead label="PLAYER" sortKey="name" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><th>POS</th><SortableHead label="PRICE" sortKey="price" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="OWN%" sortKey="ownership" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="XP GW" sortKey="nextGW" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="XP3" sortKey="next3" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="XP5" sortKey="next5" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><SortableHead label="XP/£" sortKey="value" active={store.sortKey} direction={store.sortDirection} onSort={store.setSort} /><th>EXP MIN</th><th>XGI/90</th><th>RISK</th><th>FIXTURES</th><th>ADD</th></tr></thead><tbody>{filteredPlayers.slice(0, 250).map((player) => <PlayerRow key={player.id} player={player} selected={store.playerIds.includes(player.id)} onSelect={() => store.setSelectedPlayer(player.id)} onAdd={() => addPlayer(player)} />)}</tbody></table>{status === "SYNCING" && <div className="empty-state">SYNCING FPL MARKET…</div>}{status !== "SYNCING" && filteredPlayers.length === 0 && <div className="empty-state">{data.players.length ? "No players match these filters." : message ?? "FPL data is unavailable."}</div>}</div>
          {selectedPlayer && <PlayerDetail player={selectedPlayer} locked={store.lockedPlayerIds.includes(selectedPlayer.id)} freshness={status} source={data.source} onClose={() => store.setSelectedPlayer(undefined)} onAdd={() => addPlayer(selectedPlayer)} onToggleLock={() => store.toggleLock(selectedPlayer.id)} />}
          <PanelResizer panel="market" onResizeStart={beginPanelResize} />
        </section>

        <section id="terminal-panel-squad" data-panel="squad" className={`squad-column ${collapsedPanels.squad ? "panel-collapsed" : ""} ${store.activeMobileTab === "SQUAD" ? "mobile-visible" : ""}`} aria-label={squadView === "GW TEAM" ? "GW team picker" : "Squad builder"}>
          <div className="panel-header"><div><span className="section-kicker">SQUAD BUILDER</span><span className="panel-count">{selected.length}/15 selected</span></div><div className="header-actions"><div className="team-view-switch" role="group" aria-label="Squad workflow"><button className={squadView === "BUILD" ? "active" : ""} onClick={() => setSquadView("BUILD")}>BUILD</button><button className={squadView === "GW TEAM" ? "active" : ""} onClick={() => setSquadView("GW TEAM")}>GW TEAM</button></div><div className="mode-pill">{isAnalyze ? "ANALYZE" : "BUILD"}</div>{squadView === "BUILD" && <button className="compact-action" disabled={optimizing} onClick={() => void runOptimize(selected.length < 15)}>{optimizing ? "OPTIMIZING…" : selected.length < 15 ? "COMPLETE SQUAD" : "OPTIMIZE"}</button>}<PanelToggle panel="squad" collapsed={collapsedPanels.squad} onToggle={() => togglePanel("squad")} /></div></div>
          {squadView === "GW TEAM" ? <GWTeamPanel status={status} selectedCount={selected.length} current={currentGWPlan} proposed={proposedGWPlan} currentPoints={gwCurrentPoints} proposedPoints={gwProposedPoints} playerById={playerById} dirty={gwDirty} lineupApplied={lineupApplied} lineupStale={lineupStale} swapSelection={gwSwapSelection} onPick={pickGWTeam} onSwap={selectGWSwapPlayer} onMoveBench={moveGWBench} onCaptain={makeGWCaptain} onViceCaptain={makeGWViceCaptain} onApply={applyGWTeam} onDiscard={discardGWTeam} /> : <>
            <div className="budget-rail"><div><span>SPENT</span><strong className={spent > 1000 ? "red" : ""}>{money(spent)}</strong></div><div><span>ITB</span><strong className={spent > 1000 ? "red" : "amber"}>{money(1000 - spent)}</strong></div><div><span>LOCKED</span><strong>{store.lockedPlayerIds.length}</strong></div></div>
            <div className="squad-sections">{POSITIONS.map((position) => <div className="position-section" key={position}><div className="position-heading"><span>{position}</span><span>{store.byPosition[position].length}/{POSITION_LIMITS[position]}</span></div><div className={`slot-grid slot-${position.toLowerCase()}`}>{Array.from({ length: POSITION_LIMITS[position] }, (_, index) => { const id = store.byPosition[position][index]; const player = id ? playerById.get(id) : undefined; const maxPriceTenths = slotMaxPrices[position]; return player ? <SquadSlot key={player.id} player={player} locked={store.lockedPlayerIds.includes(player.id)} captain={store.captainId === player.id} vice={store.viceCaptainId === player.id} onRemove={() => store.removePlayer(player.id)} onToggleLock={() => store.toggleLock(player.id)} onSelect={() => store.setSelectedPlayer(player.id)} onCaptain={() => store.setCaptain(store.captainId === player.id ? undefined : player.id)} /> : <EmptySlot key={`${position}-${index}`} position={position} maxPriceTenths={maxPriceTenths} onChoose={() => { store.setFilters({ position, maxPrice: (maxPriceTenths / 10).toFixed(1) }); store.setMobileTab("MARKET"); searchRef.current?.focus(); }} />; })}</div></div>)}</div>
            <MetricStrip spent={spent} projected={projected} risk={risk} />
            <FeasibilityRail selected={selected} spent={spent} feasibility={feasibility} />
            <StrategyControls horizon={store.horizon} riskMode={store.riskMode} benchStrategy={store.benchStrategy} setStrategy={store.setStrategy} />
          </>}
          <PanelResizer panel="squad" onResizeStart={beginPanelResize} />
        </section>

        <section id="terminal-panel-analysis" data-panel="analysis" className={`analysis-column ${collapsedPanels.analysis ? "panel-collapsed" : ""} ${store.activeMobileTab === "ANALYSIS" ? "mobile-visible" : ""}`} aria-label="Squad analysis">
          <AnalysisPanel selected={selected} weakest={weakest} projected={projected} risk={risk} playerById={playerById} analysis={squadAnalysis} onSelect={(id) => store.setSelectedPlayer(id)} onOpenReplacements={() => setShowReplacements(true)} collapsed={collapsedPanels.analysis} onToggle={() => togglePanel("analysis")} />
          {showReplacements && <ReplacementPanel outgoingId={squadAnalysis.weaknesses[0]?.playerId} candidates={replacements} playerById={playerById} onClose={() => setShowReplacements(false)} onSimulate={simulateMove} />}
          {simulation && simulationMove && <SimulationPanel result={simulation} move={simulationMove} playerById={playerById} onApply={applySimulation} onDiscard={() => { setSimulation(null); setSimulationMove(null); }} />}
          <section className="panel opportunity-panel"><div className="panel-header"><span className="section-kicker">MARKET OPPORTUNITIES</span><span className="data-badge model">MODEL</span></div>{squadAnalysis.opportunities.length ? squadAnalysis.opportunities.slice(0, 3).map((opportunity, index) => { const outgoing = playerById.get(opportunity.outgoingPlayerId); const incoming = playerById.get(opportunity.incomingPlayerId); return <button className="opportunity-row" key={`${opportunity.outgoingPlayerId}-${opportunity.incomingPlayerId}`} onClick={() => store.setSelectedPlayer(opportunity.incomingPlayerId)}><span className="rank">0{index + 1}</span><span className="opportunity-name">{outgoing?.displayName ?? "—"} → {incoming?.displayName ?? "—"}<small>{opportunity.reason}</small></span><span className="opportunity-value">+{opportunity.projectedDelta.toFixed(1)} xP</span><span className="arrow">›</span></button>; }) : <div className="empty-copy">Complete enough of the squad to scan deterministic replacements.</div>}</section>
          <PanelResizer panel="analysis" onResizeStart={beginPanelResize} />
        </section>

        <section id="terminal-panel-ai" data-panel="ai" className={`ai-column ${collapsedPanels.ai ? "panel-collapsed" : ""} ${store.activeMobileTab === "AI" ? "mobile-visible" : ""}`} aria-label="AI analyst">
          <AnalystPanel messages={aiMessages} busy={aiBusy} online={aiOnline} prompt={aiPrompt} setPrompt={setAiPrompt} onAsk={askAI} onQuick={(label) => { if (label === "OPTIMIZE" || label === "FINISH SQUAD") { runOptimize(label === "FINISH SQUAD"); store.setMobileTab("SQUAD"); return; } if (label === "CAPTAIN") { setCaptainDeterministically(); return; } if (label === "WEAK LINK") { store.setMobileTab("ANALYSIS"); if (weakest[0]) store.setSelectedPlayer(weakest[0].id); return; } if (label === "ANALYZE") { store.setMobileTab("ANALYSIS"); return; } askAI(label.toLowerCase()); }} textareaRef={aiRef} collapsed={collapsedPanels.ai} onToggle={() => togglePanel("ai")} />
          <PanelResizer panel="ai" onResizeStart={beginPanelResize} />
        </section>
      </div>
      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}

function ModeChooser({ status, message, gameweek, onChoose }: { status: DataState; message?: string; gameweek: number | null; onChoose: (mode: TerminalMode) => void }) {
  return <main className="mode-screen"><div className="mode-brand"><span className="brand-mark" aria-hidden="true" /><span>FPL TERMINAL</span></div><p className="mode-tagline">QUANTITATIVE FPL SQUAD INTELLIGENCE</p><div className="mode-grid"><button className="mode-card" onClick={() => onChoose("BUILD")}><span className="mode-index">MODE A</span><strong>BUILD FROM SCRATCH</strong><span>Start with £100.0m and construct your squad player by player, with live projections reacting to every pick.</span></button><button className="mode-card" onClick={() => onChoose("ANALYZE")}><span className="mode-index">MODE B</span><strong>ANALYZE A TEAM</strong><span>Enter an existing 15-player squad and get immediate analysis: weakest links, budget inefficiencies, and upgrade opportunities.</span></button></div><div className="mode-footer"><span className={`status-pip ${status.toLowerCase()}`} />{status === "LIVE" ? `LIVE DATA · GAMEWEEK ${gameweek ?? "—"} · MODEL ESTIMATES · SQUAD RULES ENFORCED LOCALLY` : status === "SNAPSHOT" ? `SNAPSHOT DATA · GAMEWEEK ${gameweek ?? "—"}` : status === "STALE" ? `STALE DATA · GAMEWEEK ${gameweek ?? "—"}` : status === "SYNCING" ? "SYNCING FPL MARKET…" : message ?? "FPL data is unavailable."}</div></main>;
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

function SquadSlot({ player, locked, captain, vice, onRemove, onToggleLock, onSelect, onCaptain }: { player: TerminalPlayer; locked: boolean; captain: boolean; vice: boolean; onRemove: () => void; onToggleLock: () => void; onSelect: () => void; onCaptain: () => void }) { return <article className="squad-slot filled"><button className="slot-main" onClick={onSelect}><span className="slot-player">{player.displayName}</span><span className="slot-sub">{player.teamShortName} · {money(player.priceTenths)}</span><span className="slot-xp">{points(player.projection?.nextGW)} <small>xP</small></span></button><div className="slot-flags">{locked && <span className="lock-label">LOCKED</span>}{captain && <button className="captain-flag" onClick={onCaptain} aria-label={`Remove captain from ${player.displayName}`}>C</button>}{vice && <button className="captain-flag" onClick={onCaptain} aria-label={`Remove vice captain from ${player.displayName}`}>V</button>}<button className={`lock-flag ${locked ? "on" : ""}`} onClick={onToggleLock} aria-label={`${locked ? "Unlock" : "Lock"} ${player.displayName}`}>{locked ? "▣" : "□"}</button><button className="remove-flag" onClick={onRemove} disabled={locked} aria-label={`Remove ${player.displayName}`}>×</button></div><button className="captain-toggle" onClick={onCaptain}>{captain ? "captain" : vice ? "vice" : "set C/V"}</button></article>; }

function EmptySlot({ position, maxPriceTenths, onChoose }: { position: Position; maxPriceTenths: number; onChoose: () => void }) { return <button className="squad-slot empty-slot" onClick={onChoose}><span className="empty-plus">+</span><span className="slot-player">Open {position}</span><span className="slot-sub">Max {money(maxPriceTenths)}</span><span className="suggest-label">SUGGEST →</span></button>; }

function MetricStrip({ spent, projected, risk }: { spent: number; projected: { nextGW?: number; next3?: number; next5?: number }; risk?: number }) { return <div className="metric-strip"><Metric label="COST" value={money(spent)} /><Metric label="ITB" value={money(1000 - spent)} tone={spent <= 1000 ? "green" : "red"} /><Metric label="GW xP" value={points(projected.nextGW)} tone="cyan" /><Metric label="3GW" value={points(projected.next3)} /><Metric label="5GW" value={points(projected.next5)} /><Metric label="RISK" value={risk === undefined ? "—" : risk < 30 ? "LOW" : risk < 60 ? "MED" : "HIGH"} /></div>; }

function FeasibilityRail({ selected, spent, feasibility }: { selected: TerminalPlayer[]; spent: number; feasibility: { minimumRequiredTenths: number; flexibleTenths: number; feasible: boolean } }) { const minimum = Number.isFinite(feasibility.minimumRequiredTenths) ? feasibility.minimumRequiredTenths : undefined; return <div className={`feasibility-rail ${spent > 1000 || (selected.length && !feasibility.feasible) ? "bad" : ""}`}><div className="rail-head"><span>FEASIBILITY</span><strong>{spent > 1000 ? "OVER BUDGET" : selected.length === 15 ? (feasibility.feasible ? "LEGALITY CHECK" : "NO LEGAL COMPLETION") : "INCOMPLETE SQUAD"}</strong></div><div className="rail-track"><span style={{ width: `${Math.min(100, Math.max(0, spent / 10))}%` }} /></div><div className="rail-foot"><span>{selected.length}/15 players</span><span>{minimum === undefined ? "Minimum required —" : `Minimum required ${money(minimum)}`} · flexible {Number.isFinite(feasibility.flexibleTenths) ? money(feasibility.flexibleTenths) : "—"}</span></div></div>; }

function StrategyControls({ horizon, riskMode, benchStrategy, setStrategy }: { horizon: 1 | 3 | 5; riskMode: "SAFE" | "BALANCED" | "AGGRESSIVE"; benchStrategy: "CHEAP" | "BALANCED" | "STRONG"; setStrategy: (strategy: { horizon?: 1 | 3 | 5; riskMode?: "SAFE" | "BALANCED" | "AGGRESSIVE"; benchStrategy?: "CHEAP" | "BALANCED" | "STRONG" }) => void }) { return <div className="strategy-panel"><div><span className="section-kicker">STRATEGY</span><span className="strategy-label">HORIZON</span><div className="segmented">{([1, 3, 5] as const).map((value) => <button key={value} className={horizon === value ? "active" : ""} onClick={() => setStrategy({ horizon: value })}>{value === 1 ? "GW" : `${value}GW`}</button>)}</div></div><div><span className="strategy-label">RISK</span><div className="segmented">{(["SAFE", "BALANCED", "AGGRESSIVE"] as const).map((value) => <button key={value} className={riskMode === value ? "active" : ""} onClick={() => setStrategy({ riskMode: value })}>{value.slice(0, 4)}</button>)}</div></div><div><span className="strategy-label">BENCH</span><div className="segmented">{(["CHEAP", "BALANCED", "STRONG"] as const).map((value) => <button key={value} className={benchStrategy === value ? "active" : ""} onClick={() => setStrategy({ benchStrategy: value })}>{value.slice(0, 4)}</button>)}</div></div></div>; }

function GWTeamPanel({ status, selectedCount, current, proposed, currentPoints, proposedPoints, playerById, dirty, lineupApplied, lineupStale, swapSelection, onPick, onSwap, onMoveBench, onCaptain, onViceCaptain, onApply, onDiscard }: {
  status: DataState;
  selectedCount: number;
  current: WeeklyLineupPlan | null;
  proposed: WeeklyLineupPlan | null;
  currentPoints: number;
  proposedPoints: number;
  playerById: Map<number, TerminalPlayer>;
  dirty: boolean;
  lineupApplied: boolean;
  lineupStale?: boolean;
  swapSelection: { starterId?: number; benchId?: number };
  onPick: () => void;
  onSwap: (role: "starter" | "bench", id: number) => void;
  onMoveBench: (id: number, direction: -1 | 1) => void;
  onCaptain: (id: number) => void;
  onViceCaptain: (id: number) => void;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const gain = proposed && current ? proposedPoints - currentPoints : 0;
  const stale = lineupStale || status === "STALE" || status === "SNAPSHOT";
  return <div className="gw-team-panel">
    <div className="gw-team-heading"><div><span className="section-kicker">GW TEAM PICK PREVIEW</span><p>Set the starting XI, captaincy, and bench order for the next gameweek.</p></div><div className="gw-heading-actions"><span className={`data-badge ${stale ? "snapshot" : "model"}`}>{stale ? "REVIEW" : lineupApplied ? "APPLIED" : "MODEL"}</span><button className="compact-action" onClick={onPick}>PICK GW TEAM</button></div></div>
    {!proposed ? <div className="gw-empty" role="status"><strong>NO WEEKLY PICK TO REVIEW</strong><span>Pick a deterministic GW TEAM preview once the squad has 15 legal players. You can edit it before applying.</span><button className="primary-button" onClick={onPick}>PICK GW TEAM</button></div> : <>
    <div className="gw-comparison" aria-label="Current and proposed gameweek team comparison">
      <div><span>CURRENT</span><strong>{current ? formationLabel(current) : "—"}</strong><small>{current ? `${points(currentPoints)} xPts` : "No applied lineup"}</small></div>
      <div><span>PROPOSED</span><strong>{formationLabel(proposed)}</strong><small>{points(proposedPoints)} xPts</small></div>
      <div className={gain >= 0 ? "gain-positive" : "gain-negative"}><span>GAIN</span><strong>{gain >= 0 ? "+" : ""}{gain.toFixed(1)}</strong><small>xPts</small></div>
    </div>
    <div className="gw-model-values"><span>CAPTAIN BONUS <strong>+{proposed.captainBonus.toFixed(1)} xPts</strong></span><span>AUTOSUB VALUE · MODEL ESTIMATE <strong>+{proposed.autosubValue.toFixed(1)} xPts</strong></span></div>
    {stale && <div className="gw-stale-warning" role="alert">{lineupStale ? "LINEUP OUTDATED — RE-PICK" : "DATA IS A SNAPSHOT · review this team before applying."}</div>}
    {(selectedCount < 15 || proposed.starterIds.length !== 11 || proposed.benchOrder.length !== 3 || proposed.benchGoalkeeperId === 0) && <div className="gw-incomplete" role="status">Complete a legal 15-player squad to apply a weekly team. The preview will update as picks are added.</div>}
    <div className="gw-section-head"><span className="section-kicker">STARTERS</span><span>{proposed.starterIds.length}/11 · {formationLabel(proposed)}</span></div>
    <div className="gw-starters">{POSITIONS.map((position) => {
      const ids = proposed.starterIds.filter((id) => playerById.get(id)?.position === position);
      return <section className="gw-position-group" key={position} aria-label={`${position} starters`}><div className="gw-position-heading"><span>{position}</span><span>{ids.length}</span></div>{ids.map((id) => {
        const player = playerById.get(id);
        if (!player) return null;
        const captain = proposed.captainId === id;
        const vice = proposed.viceCaptainId === id;
        return <article className={`gw-player-row ${swapSelection.starterId === id ? "selected" : ""}`} key={id}><div><strong>{player.displayName}</strong><small>{player.teamShortName} · {points(player.projection?.nextGW)} xP {captain ? "· C" : vice ? "· VC" : ""}</small></div><div className="gw-row-actions"><button className="gw-team-button" onClick={() => onSwap("starter", id)} aria-label={`Select ${player.displayName} to move to bench`}>BENCH</button><button className={`gw-mark-button ${captain ? "active" : ""}`} onClick={() => onCaptain(id)} aria-label={`Make ${player.displayName} captain`} aria-pressed={captain}>C</button><button className={`gw-mark-button ${vice ? "active" : ""}`} onClick={() => onViceCaptain(id)} aria-label={`Make ${player.displayName} vice-captain`} aria-pressed={vice}>VC</button></div></article>;
      })}</section>;
    })}</div>
    <div className="gw-section-head bench-head"><span className="section-kicker">ORDERED BENCH</span><span>GK · 1 · 2 · 3</span></div>
    <div className="gw-bench-list">{[proposed.benchGoalkeeperId, ...proposed.benchOrder].map((id, index) => {
      const player = playerById.get(id);
      if (!player) return null;
      const goalkeeper = player.position === "GK";
      return <article className={`gw-player-row bench-row ${swapSelection.benchId === id ? "selected" : ""}`} key={id}><span className="bench-number">{goalkeeper ? "GK" : index}</span><div><strong>{player.displayName}</strong><small>{player.teamShortName} · {points(player.projection?.nextGW)} xP</small></div><div className="gw-row-actions"><button className="gw-team-button" onClick={() => onSwap("bench", id)} aria-label={`Select ${player.displayName} to move into starters`}>START</button><button className="gw-mark-button" disabled={goalkeeper || index === 1} onClick={() => onMoveBench(id, -1)} aria-label={`Move ${player.displayName} bench up`}>↑</button><button className="gw-mark-button" disabled={goalkeeper || index === proposed.benchOrder.length} onClick={() => onMoveBench(id, 1)} aria-label={`Move ${player.displayName} bench down`}>↓</button></div></article>;
    })}</div>
    <div className="gw-team-actions"><button className="primary-button" onClick={onApply} disabled={!dirty}>APPLY LINEUP</button><button className="secondary-button" onClick={onDiscard} disabled={!dirty}>DISCARD</button></div>
    </>}
  </div>;
}

function AnalysisPanel({ selected, weakest, projected, risk, playerById, analysis, onSelect, onOpenReplacements, collapsed, onToggle }: { selected: TerminalPlayer[]; weakest: TerminalPlayer[]; projected: { nextGW?: number; next3?: number; next5?: number }; risk?: number; playerById: Map<number, TerminalPlayer>; analysis: ReturnType<typeof analyzeSquad>; onSelect: (id: number) => void; onOpenReplacements: () => void; collapsed: boolean; onToggle: () => void }) { const byWeakness = new Map(analysis.weaknesses.map((weakness) => [weakness.playerId, weakness])); return <section className={`panel analysis-panel ${collapsed ? "panel-collapsed" : ""}`}><div className="panel-header"><div><span className="section-kicker">SQUAD ANALYSIS</span><span className="panel-count">{selected.length === 15 ? "READY" : "PARTIAL"}</span></div><div className="header-actions"><span className="data-badge model">MODEL</span><button className="compact-action" onClick={onOpenReplacements}>REPLACEMENTS</button><PanelToggle panel="analysis" collapsed={collapsed} onToggle={onToggle} /></div></div><div className="analysis-hero"><div><span>5GW xPTS</span><strong>{points(projected.next5)}</strong></div><div><span>MINUTES SECURITY</span><strong>{risk === undefined ? "—" : risk < 30 ? "HIGH" : risk < 60 ? "MED" : "LOW"}</strong></div></div><div className="analysis-lines"><div><span>TOTAL COST</span><strong>{money(analysis.totalCostTenths)}</strong></div><div><span>BANK</span><strong>{money(analysis.bankTenths)}</strong></div><div><span>FIXTURE SCORE</span><strong>—</strong></div></div><div className="weak-links"><div className="subsection-head"><span className="section-kicker">WEAKEST LINKS</span><span className="data-badge model">MODEL</span></div>{weakest.length ? weakest.map((player, index) => { const weakness = byWeakness.get(player.id); return <button className="weak-row" key={player.id} onClick={() => onSelect(player.id)}><span className="weak-rank">{index + 1}</span><span><strong>{player.displayName}</strong><small>{weakness?.reasons[0] ?? "Projection unavailable"}</small></span><b>{weakness?.score ?? "—"}</b></button>; }) : <div className="empty-copy">No model weak links yet. Add players with projection data to evaluate trade-offs.</div>}</div><div className="formation-note">{playerById.size ? `Live universe: ${playerById.size} players.` : "No live player universe loaded."}<br />Stats marked MODEL are estimates, not official FPL values.</div></section>; }

function ReplacementPanel({ outgoingId, candidates, playerById, onClose, onSimulate }: { outgoingId?: number; candidates: ReplacementCandidate[]; playerById: Map<number, TerminalPlayer>; onClose: () => void; onSimulate: (outId: number, inId: number) => void }) { return <section className="panel replacement-panel"><div className="panel-header"><div><span className="section-kicker">REPLACEMENTS</span><span className="panel-count">DETERMINISTIC</span></div><button className="icon-button" onClick={onClose} aria-label="Close replacements">×</button></div>{candidates.length && outgoingId ? candidates.map((candidate) => { const incoming = playerById.get(candidate.playerId); return <div className="replacement-row" key={candidate.playerId}><div><strong>{incoming?.displayName ?? `Player ${candidate.playerId}`}</strong><small>{incoming?.teamShortName ?? "—"} · {money(candidate.priceTenths)} · {candidate.reason}</small></div><span className={candidate.projectedDelta >= 0 ? "green" : "red"}>{candidate.projectedDelta >= 0 ? "+" : ""}{candidate.projectedDelta.toFixed(1)} xP</span><button className="compact-action" onClick={() => onSimulate(outgoingId, candidate.playerId)}>SIMULATE</button></div>; }) : <div className="empty-copy">No replacement candidates are available from the current squad and model inputs.</div>}</section>; }

function SimulationPanel({ result, move, playerById, onApply, onDiscard }: { result: SimulationResult; move: { outId: number; inId: number }; playerById: Map<number, TerminalPlayer>; onApply: () => void; onDiscard: () => void }) { return <section className="panel simulation-panel"><div className="panel-header"><div><span className="section-kicker">SIMULATION</span><span className="panel-count">{result.legal ? "LEGAL" : "CHECK REQUIRED"}</span></div><button className="icon-button" onClick={onDiscard} aria-label="Close simulation">×</button></div><div className="simulation-move">{playerById.get(move.outId)?.displayName ?? "Outgoing"} <span>→</span> {playerById.get(move.inId)?.displayName ?? "Incoming"}</div><div className="simulation-grid"><div><span>CURRENT 5GW xP</span><strong>{points(result.before.projectedNext5)}</strong></div><div><span>SIMULATED 5GW xP</span><strong>{points(result.after.projectedNext5)}</strong></div><div><span>PRICE EFFECT</span><strong>{money(result.priceDeltaTenths)}</strong></div><div><span>GW EFFECT</span><strong className={result.projectedDelta5 >= 0 ? "green" : "red"}>{result.projectedDelta5 >= 0 ? "+" : ""}{result.projectedDelta5.toFixed(1)}</strong></div></div><p className="simulation-note">{result.explanationFactors[0] ?? "Model comparison complete."}{!result.legal && " The current selection still has a rules issue; review the feasibility rail after applying."}</p><div className="simulation-actions"><button className="primary-button" onClick={onApply}>APPLY CHANGES</button><button className="secondary-button" onClick={onDiscard}>DISCARD</button></div></section>; }

function AnalystPanel({ messages, busy, online, prompt, setPrompt, onAsk, onQuick, textareaRef, collapsed, onToggle }: { messages: Array<{ role: "user" | "assistant"; text: string }>; busy: boolean; online: boolean | null; prompt: string; setPrompt: (value: string) => void; onAsk: (prompt: string) => void; onQuick: (label: string) => void; textareaRef: React.RefObject<HTMLTextAreaElement | null>; collapsed: boolean; onToggle: () => void }) { const defaultCopy = online === false ? "AI analyst offline. Add DEEPSEEK_API_KEY to .env.local to enable conversational analysis." : "The analyst reads the current squad context and explains trade-offs. It cannot change picks without your action."; return <section className={`panel analyst-panel ${collapsed ? "panel-collapsed" : ""}`}><div className="panel-header"><div><span className="section-kicker">AI ANALYST</span><span className="panel-count">{online === true ? "ONLINE" : online === false ? "OFFLINE SHELL" : "CHECKING"}</span></div><div className="header-actions"><span className={`data-badge ${online === true ? "green" : "model"}`}>{online === false ? "OFFLINE" : "DEEPSEEK"}</span><PanelToggle panel="ai" collapsed={collapsed} onToggle={onToggle} /></div></div><div className="analyst-scroll"><div className="analyst-block"><span className="section-kicker">SQUAD DIAGNOSIS</span><p>{defaultCopy}</p></div>{messages.map((message, index) => <div className={`message ${message.role}`} key={`${message.role}-${index}`}><span className="message-label">{message.role === "user" ? "> YOU" : "ANALYST"}</span><p>{message.text}</p></div>)}{busy && <div className="message assistant"><span className="message-label">ANALYST</span><p className="loading-line">CHECKING CONTEXT…</p></div>}</div><div className="quick-commands"><span className="section-kicker">QUICK COMMANDS</span><div>{["ANALYZE", "OPTIMIZE", "WEAK LINK", "FINISH SQUAD", "CHEAPEN BENCH", "CAPTAIN"].map((label) => <button key={label} onClick={() => onQuick(label)}>{label}</button>)}</div></div><form className="ai-input" onSubmit={(event) => { event.preventDefault(); onAsk(prompt); }}><span>&gt;</span><textarea ref={textareaRef} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask about this squad..." rows={2} aria-label="Ask the AI analyst" /><button type="submit" disabled={!prompt.trim() || busy} aria-label="Send analyst query">↗</button></form></section>; }

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
