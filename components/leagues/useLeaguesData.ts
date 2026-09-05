"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FreshnessMetadata } from "@/lib/fpl/cache";
import { parseLeagueKey } from "@/lib/leagues/leagueKey";
import type { LiveStats } from "@/lib/leagues/calculateLiveEntry";
import type { LiveExplainBlock } from "@/lib/leagues/diffLiveSnapshots";
import { MAX_STANDINGS_ROWS } from "@/lib/leagues/calculateLiveStandings";
import { fixtureStateOf, livePollIntervalMs } from "@/lib/leagues/fixtureStatus";
import type {
  ClassicLeagueStandings,
  ClassicStandingRow,
  EntryPicks,
  FixtureStatLine,
  FixtureView,
  ManagerHistory,
  ManagerProfile,
} from "@/types/leagues";
import type { Player } from "@/types/player";
import { cacheBootstrapData, peekBootstrapData, readBootstrapData } from "@/lib/fpl/browserBootstrapCache";

export interface Resource<T> {
  status: "IDLE" | "LOADING" | "READY" | "ERROR";
  data: T | null;
  error?: string;
  /** Set when the server answered with data it could not refresh. */
  warning?: string;
  /** True when the data came from a snapshot or outlived its TTL. */
  stale?: boolean;
  /** When FPL itself supplied the data, not when the browser asked for it. */
  fetchedAt?: string | null;
}

export interface LeaguesBootstrap {
  players: Player[];
  playersById: Map<number, Player>;
  teamNameById: Map<number, string>;
  teamShortNameById: Map<number, string>;
  gameweek: number;
  deadline: string | null;
}

export interface LoadedStandings {
  leagueId: number;
  name?: string;
  rows: ClassicStandingRow[];
  completePopulation: boolean;
}

export interface LiveSnapshot {
  statsByElement: Map<number, LiveStats>;
  /** FPL's own per-fixture points breakdown, which prices each feed event. */
  explainByElement: Map<number, LiveExplainBlock[]>;
  fetchedAt: string;
}

interface RawLiveElement {
  playerId: number;
  stats: LiveStats;
  explain?: Array<{ fixtureId?: number; stats?: LiveExplainBlock["stats"] }>;
}

interface RawEvent {
  id: number;
  deadlineTime?: string;
  isCurrent?: boolean;
  isNext?: boolean;
}

interface RawTeam {
  id: number;
  name?: string;
  shortName?: string;
}

interface RawFixture {
  id: number;
  kickoffTime?: string;
  teamHomeId: number;
  teamAwayId: number;
  homeScore?: number | null;
  awayScore?: number | null;
  finished?: boolean;
  finishedProvisional?: boolean;
  started?: boolean;
  minutes?: number;
  stats?: FixtureStatLine[];
}

const EMPTY_TEAM_NAMES = new Map<number, string>();

interface Envelope<T> {
  data: T;
  /** Upstream problems the server worked around; never silently dropped. */
  errors: string[];
  stale: boolean;
  fetchedAt: string | null;
}

/** Collects every freshness record a route reports, however it nests them. */
function freshnessNodes(value: unknown, depth = 0): FreshnessMetadata[] {
  if (!value || typeof value !== "object" || depth > 2) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.source === "string" && typeof record.fetchedAt === "string") {
    return [record as unknown as FreshnessMetadata];
  }
  return Object.values(record).flatMap((child) => freshnessNodes(child, depth + 1));
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<Envelope<T>> {
  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
  let body: { data?: T | null; errors?: string[]; freshness?: unknown } | null = null;
  try {
    body = (await response.json()) as { data?: T | null; errors?: string[]; freshness?: unknown };
  } catch {
    body = null;
  }
  if (!response.ok || !body || body.data === null || body.data === undefined) {
    throw new Error(body?.errors?.[0] ?? `Request failed with HTTP ${response.status}`);
  }
  const nodes = freshnessNodes(body.freshness);
  const newest = nodes.reduce<FreshnessMetadata | null>(
    (latest, node) => (!latest || Date.parse(node.fetchedAt) > Date.parse(latest.fetchedAt) ? node : latest),
    null,
  );
  return {
    data: body.data,
    errors: body.errors ?? [],
    stale: nodes.some((node) => node.stale || node.source === "snapshot"),
    fetchedAt: newest?.fetchedAt ?? null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "FPL request failed";
}

function buildFixtureViews(raw: readonly RawFixture[], shortNames: ReadonlyMap<number, string>): FixtureView[] {
  return raw.map((fixture) => ({
    id: fixture.id,
    kickoffTime: fixture.kickoffTime ?? null,
    homeTeamId: fixture.teamHomeId,
    awayTeamId: fixture.teamAwayId,
    homeShortName: shortNames.get(fixture.teamHomeId) ?? String(fixture.teamHomeId),
    awayShortName: shortNames.get(fixture.teamAwayId) ?? String(fixture.teamAwayId),
    homeScore: fixture.homeScore ?? null,
    awayScore: fixture.awayScore ?? null,
    state: fixtureStateOf({
      finished: fixture.finished,
      finishedProvisional: fixture.finishedProvisional,
      started: fixture.started,
    }),
    // `finished` is FPL's own confirmation, published once bonus is final.
    bonusSettled: Boolean(fixture.finished),
    minutes: fixture.minutes,
    stats: fixture.stats,
  }));
}

const MEMBER_PICK_CONCURRENCY = 6;

function normalizeLeaguesBootstrap(payload: unknown): LeaguesBootstrap | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as { players?: Player[]; teams?: RawTeam[]; events?: RawEvent[]; liveGameweek?: number };
  const players = Array.isArray(value.players) ? value.players : [];
  if (!players.length) return null;
  const teams = Array.isArray(value.teams) ? value.teams : [];
  const events = Array.isArray(value.events) ? value.events : [];
  const currentEvent = events.find((event) => event.isCurrent) ?? events.find((event) => event.isNext);
  return {
    players,
    playersById: new Map(players.map((player) => [player.id, player])),
    teamNameById: new Map(teams.map((team) => [team.id, team.name ?? `Team ${team.id}`])),
    teamShortNameById: new Map(teams.map((team) => [
      team.id,
      team.shortName ?? (team as RawTeam & { short_name?: string }).short_name ?? team.name ?? String(team.id),
    ])),
    gameweek: value.liveGameweek ?? currentEvent?.id ?? events[0]?.id ?? 1,
    deadline: currentEvent?.deadlineTime ?? null,
  };
}

/**
 * Owns every network boundary used by the Leagues workspace. Components stay
 * presentational; polling, caching decisions, and pagination live here.
 * Effects only push completed fetch results into React state — loading
 * indicators are derived from that state during render, never written
 * synchronously inside effects or read back from refs while rendering.
 */
export function useLeaguesData(entryId: number | undefined, savedLeagueKey?: string) {
  const [bootstrap, setBootstrap] = useState<Resource<LeaguesBootstrap>>(() => {
    const data = normalizeLeaguesBootstrap(peekBootstrapData());
    return data ? { status: "READY", data, stale: true } : { status: "LOADING", data: null };
  });
  const [profile, setProfile] = useState<Resource<ManagerProfile>>({ status: "IDLE", data: null });
  const [history, setHistory] = useState<Resource<ManagerHistory>>({ status: "IDLE", data: null });
  const [picks, setPicks] = useState<Resource<EntryPicks>>({ status: "IDLE", data: null });
  const [live, setLive] = useState<Resource<LiveSnapshot>>({ status: "IDLE", data: null });
  const [fixtures, setFixtures] = useState<Resource<FixtureView[]>>({ status: "IDLE", data: null });
  const [availableGameweek, setAvailableGameweek] = useState<{ requested: number; available: number } | null>(null);
  const [userSelectedLeagueKey, setUserSelectedLeagueKey] = useState<string | null>(null);
  const [standingsCache, setStandingsCache] = useState<Map<string, LoadedStandings>>(new Map());
  const [standingsFailure, setStandingsFailure] = useState<{ key: string; message: string } | null>(null);
  const [memberPicksCache, setMemberPicksCache] = useState<Map<string, Map<number, EntryPicks>>>(new Map());
  const [bootstrapToken, setBootstrapToken] = useState(0);

  const standingsRequestsRef = useRef(new Set<string>());
  const memberPicksRequestsRef = useRef(new Set<string>());
  const pollInFlightRef = useRef(false);
  const pollAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let networkSettled = false;
    void readBootstrapData().then((cached) => {
      if (controller.signal.aborted || networkSettled) return;
      const data = normalizeLeaguesBootstrap(cached);
      if (data) setBootstrap({ status: "READY", data, stale: true });
    });
    getJson<{
      players?: Player[];
      teams?: RawTeam[];
      events?: RawEvent[];
      liveGameweek?: number;
    }>("/api/fpl/bootstrap", controller.signal).then((envelope) => {
      networkSettled = true;
      if (controller.signal.aborted) return;
      cacheBootstrapData(envelope.data);
      const data = normalizeLeaguesBootstrap(envelope.data);
      setBootstrap({
        status: data ? "READY" : "ERROR",
        data,
        error: data ? undefined : "The FPL response contained no player records.",
        warning: envelope.errors[0],
        stale: envelope.stale,
        fetchedAt: envelope.fetchedAt,
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      networkSettled = true;
      setBootstrap((current) => ({ ...current, status: current.data ? current.status : "ERROR", error: errorMessage(error) }));
    });
    return () => controller.abort();
  }, [bootstrapToken]);

  const currentGameweek = bootstrap.data?.gameweek ?? null;
  const gameweek = availableGameweek?.requested === currentGameweek ? availableGameweek.available : currentGameweek;
  const shortNames = useMemo(
    () => bootstrap.data?.teamShortNameById ?? EMPTY_TEAM_NAMES,
    [bootstrap.data],
  );

  useEffect(() => {
    if (!entryId || gameweek === null) return;
    const controller = new AbortController();

    getJson<{ profile: ManagerProfile }>(`/api/fpl/entry/${entryId}?gameweek=${gameweek}`, controller.signal)
      .then((envelope) => {
        if (!controller.signal.aborted) {
          setProfile({
            status: "READY",
            data: envelope.data.profile,
            warning: envelope.errors[0],
            stale: envelope.stale,
            fetchedAt: envelope.fetchedAt,
          });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setProfile((current) => ({ ...current, status: current.data ? current.status : "ERROR", error: errorMessage(error) }));
      });
    getJson<ManagerHistory>(`/api/fpl/entry/${entryId}/history`, controller.signal)
      .then((envelope) => {
        if (!controller.signal.aborted) {
          setHistory({ status: "READY", data: envelope.data, warning: envelope.errors[0], stale: envelope.stale, fetchedAt: envelope.fetchedAt });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setHistory((current) => ({ ...current, status: current.data ? current.status : "ERROR", error: errorMessage(error) }));
      });
    getJson<EntryPicks>(`/api/fpl/entry/${entryId}/event/${gameweek}/picks`, controller.signal)
      .then((envelope) => {
        if (!controller.signal.aborted) {
          setPicks({ status: "READY", data: envelope.data, warning: envelope.errors[0], stale: envelope.stale, fetchedAt: envelope.fetchedAt });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setPicks((current) => ({ ...current, status: current.data ? current.status : "ERROR", error: errorMessage(error) }));
      });

    return () => controller.abort();
  }, [entryId, gameweek]);

  useEffect(() => () => pollAbortRef.current?.abort(), []);

  const refreshLive = useCallback(async () => {
    if (currentGameweek === null || pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    const controller = new AbortController();
    pollAbortRef.current = controller;
    try {
      let liveGameweek = currentGameweek;
      let liveEnvelope = await getJson<{ elements?: RawLiveElement[] }>(`/api/fpl/live/${liveGameweek}`, controller.signal);
      if (!(liveEnvelope.data.elements?.length) && liveGameweek > 1) {
        const previous = await getJson<{ elements?: RawLiveElement[] }>(`/api/fpl/live/${liveGameweek - 1}`, controller.signal);
        if (previous.data.elements?.length) {
          liveGameweek -= 1;
          liveEnvelope = previous;
        }
      }
      const fixtureEnvelope = await getJson<RawFixture[]>(`/api/fpl/fixtures?gameweek=${liveGameweek}`, controller.signal);
      if (controller.signal.aborted) return;
      setAvailableGameweek({ requested: currentGameweek, available: liveGameweek });
      const statsByElement = new Map<number, LiveStats>();
      const explainByElement = new Map<number, LiveExplainBlock[]>();
      for (const element of liveEnvelope.data.elements ?? []) {
        statsByElement.set(element.playerId, element.stats);
        const explain = (element.explain ?? [])
          .map((block) => ({ fixtureId: block.fixtureId, stats: block.stats ?? [] }))
          .filter((block) => block.stats.length > 0);
        if (explain.length) explainByElement.set(element.playerId, explain);
      }
      const snapshot: LiveSnapshot = {
        statsByElement,
        explainByElement,
        fetchedAt: liveEnvelope.fetchedAt ?? new Date().toISOString(),
      };
      // An empty live snapshot means FPL gave us nothing usable: keep the last
      // good one rather than blanking every score to zero.
      const emptyLive = statsByElement.size === 0;
      setLive((current) => ({
        status: emptyLive && current.data ? current.status : "READY",
        data: emptyLive && current.data ? current.data : snapshot,
        warning: liveEnvelope.errors[0] ?? (emptyLive ? "FPL returned no live player data." : undefined),
        stale: liveEnvelope.stale || emptyLive,
        fetchedAt: liveEnvelope.fetchedAt,
      }));
      setFixtures({
        status: "READY",
        data: buildFixtureViews(Array.isArray(fixtureEnvelope.data) ? fixtureEnvelope.data : [], shortNames),
        warning: fixtureEnvelope.errors[0],
        stale: fixtureEnvelope.stale,
        fetchedAt: fixtureEnvelope.fetchedAt,
      });
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      const message = errorMessage(error);
      // A failed poll leaves whatever we already hold on screen, so the data is
      // stale from this moment on and has to say so.
      setLive((current) => ({ ...current, status: current.data ? current.status : "ERROR", error: message, stale: true }));
      setFixtures((current) => ({ ...current, status: current.data ? current.status : "ERROR", error: message, stale: true }));
    } finally {
      if (pollAbortRef.current === controller) pollAbortRef.current = null;
      pollInFlightRef.current = false;
    }
  }, [currentGameweek, shortNames]);

  useEffect(() => {
    if (currentGameweek === null) return;
    const timer = window.setTimeout(() => {
      void refreshLive();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [currentGameweek, refreshLive]);

  const anyFixtureLive = fixtures.data?.some((fixture) => fixture.state === "LIVE") ?? false;
  const anyFixtureSettling = fixtures.data?.some(
    (fixture) => fixture.state === "FINISHED" && !fixture.bonusSettled,
  ) ?? false;
  const waitingForCurrentData = gameweek !== currentGameweek;
  const pollIntervalMs = livePollIntervalMs({ anyFixtureLive, anyFixtureSettling, waitingForCurrentData });

  useEffect(() => {
    if (pollIntervalMs === null) return;
    const timer = window.setInterval(() => {
      void refreshLive();
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [pollIntervalMs, refreshLive]);

  // The default league selection is derived during render, never written by an effect.
  const firstClassicKey = profile.status === "READY" && profile.data
    ? profile.data.leagues.classic[0]
      ? `classic-${profile.data.leagues.classic[0].id}`
      : "overall"
    : null;
  // A remembered league opens by default, but only once we know this manager
  // still plays in it — a saved key from another team must not be trusted.
  const rememberedKey = useMemo(() => {
    const parsed = parseLeagueKey(savedLeagueKey);
    if (!parsed || !savedLeagueKey) return null;
    if (parsed.type === "OVERALL") return savedLeagueKey;
    if (profile.status !== "READY" || !profile.data) return null;
    const leagues = parsed.type === "CLASSIC" ? profile.data.leagues.classic : profile.data.leagues.h2h;
    return leagues.some((league) => league.id === parsed.id) ? savedLeagueKey : null;
  }, [profile.data, profile.status, savedLeagueKey]);
  const selectedLeagueKey = userSelectedLeagueKey ?? rememberedKey ?? firstClassicKey;
  const selectLeague = useCallback((key: string) => setUserSelectedLeagueKey(key), []);

  const activeClassicKey = parseLeagueKey(selectedLeagueKey)?.type === "CLASSIC" ? selectedLeagueKey : null;

  useEffect(() => {
    if (!activeClassicKey) return;
    if (standingsCache.has(activeClassicKey)) return;
    if (standingsRequestsRef.current.has(activeClassicKey)) return;
    const leagueKey: string = activeClassicKey;
    const leagueId = Number(leagueKey.slice("classic-".length));
    if (!Number.isSafeInteger(leagueId)) return;
    standingsRequestsRef.current.add(leagueKey);
    const controller = new AbortController();
    void (async () => {
      try {
        let page = 1;
        let rows: ClassicStandingRow[] = [];
        let hasNext = true;
        let name: string | undefined;
        while (hasNext && rows.length < MAX_STANDINGS_ROWS && page <= 3) {
          const { data: payload } = await getJson<ClassicLeagueStandings>(
            `/api/fpl/leagues/classic/${leagueId}?page=${page}`,
            controller.signal,
          );
          rows = rows.concat(payload.results);
          hasNext = payload.hasNext;
          name = payload.league.name ?? name;
          page += 1;
        }
        if (controller.signal.aborted) return;
        const loaded: LoadedStandings = { leagueId, name, rows, completePopulation: !hasNext };
        setStandingsCache((current) => new Map(current).set(leagueKey, loaded));
      } catch (error: unknown) {
        if (!controller.signal.aborted) setStandingsFailure({ key: leagueKey, message: errorMessage(error) });
      } finally {
        standingsRequestsRef.current.delete(leagueKey);
      }
    })();
    return () => controller.abort();
  }, [activeClassicKey, standingsCache]);

  const cachedStandings = activeClassicKey
    ? standingsCache.get(activeClassicKey) ?? null
    : null;
  const standingsFailureMessage = activeClassicKey && standingsFailure?.key === activeClassicKey
    ? standingsFailure.message
    : undefined;
  const standings = useMemo<Resource<LoadedStandings>>(() => {
    if (cachedStandings) return { status: "READY", data: cachedStandings };
    if (activeClassicKey && standingsFailureMessage) {
      return { status: "ERROR", data: null, error: standingsFailureMessage };
    }
    if (activeClassicKey) return { status: "LOADING", data: null };
    return { status: "IDLE", data: null };
  }, [activeClassicKey, cachedStandings, standingsFailureMessage]);

  // Member picks are loaded for whatever rows we hold, complete league or not:
  // a top-of-the-table sample is enough to say who owns a player, even though
  // it is not enough to rank the league (which `calculateLiveStandings` gates
  // on `completePopulation` separately).
  const memberPicksCacheKey = cachedStandings && gameweek !== null
    ? `${cachedStandings.leagueId}-${gameweek}-${cachedStandings.rows.length}`
    : null;

  useEffect(() => {
    if (!memberPicksCacheKey || !cachedStandings) return;
    if (memberPicksCache.has(memberPicksCacheKey)) return;
    if (memberPicksRequestsRef.current.has(memberPicksCacheKey)) return;
    const cacheKey: string = memberPicksCacheKey;
    memberPicksRequestsRef.current.add(cacheKey);
    const controller = new AbortController();
    void (async () => {
      const collected = new Map<number, EntryPicks>();
      const ids = cachedStandings.rows.map((row) => row.entryId);
      for (let index = 0; index < ids.length; index += MEMBER_PICK_CONCURRENCY) {
        if (controller.signal.aborted) return;
        const chunk = ids.slice(index, index + MEMBER_PICK_CONCURRENCY);
        await Promise.all(chunk.map(async (memberId) => {
          try {
            const { data: memberPicksPayload } = await getJson<EntryPicks>(
              `/api/fpl/entry/${memberId}/event/${gameweek}/picks`,
              controller.signal,
            );
            collected.set(memberId, memberPicksPayload);
          } catch {
            // A member whose picks cannot be loaded keeps official numbers only.
          }
        }));
      }
      if (controller.signal.aborted) return;
      setMemberPicksCache((current) => new Map(current).set(cacheKey, collected));
    })().finally(() => {
      memberPicksRequestsRef.current.delete(cacheKey);
    });
    return () => controller.abort();
  }, [cachedStandings, gameweek, memberPicksCache, memberPicksCacheKey]);

  const memberPicks = useMemo<Resource<Map<number, EntryPicks>>>(() => {
    const cached = memberPicksCacheKey ? memberPicksCache.get(memberPicksCacheKey) ?? null : null;
    if (cached) return { status: "READY", data: cached };
    if (memberPicksCacheKey) return { status: "LOADING", data: new Map() };
    return { status: "IDLE", data: new Map() };
  }, [memberPicksCache, memberPicksCacheKey]);

  /** Whether the loaded rows are the whole league or only its top of the table. */
  const leagueSampleComplete = Boolean(cachedStandings?.completePopulation);

  const refreshBootstrap = useCallback(() => setBootstrapToken((token) => token + 1), []);

  const liveStatsByElement = useMemo(() => live.data?.statsByElement ?? new Map<number, LiveStats>(), [live.data]);
  const liveExplainByElement = useMemo(
    () => live.data?.explainByElement ?? new Map<number, LiveExplainBlock[]>(),
    [live.data],
  );

  return {
    bootstrap,
    gameweek,
    currentGameweek,
    profile,
    history,
    picks,
    liveStatus: live.status,
    liveError: live.error,
    liveWarning: live.warning,
    liveStale: live.stale ?? false,
    liveFetchedAt: live.data?.fetchedAt ?? null,
    liveStatsByElement,
    liveExplainByElement,
    fixturesData: fixtures.data ?? [],
    fixturesStatus: fixtures.status,
    fixturesError: fixtures.error,
    anyFixtureLive,
    anyFixtureSettling,
    refreshLive,
    refreshBootstrap,
    selectedLeagueKey,
    selectLeague,
    standings,
    memberPicks,
    leagueSampleComplete,
  };
}
