"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import WorkspaceSwitcher from "@/components/terminal/WorkspaceSwitcher";
import { calculateLiveEntry, type LiveStats } from "@/lib/leagues/calculateLiveEntry";
import { calculateLiveStandings } from "@/lib/leagues/calculateLiveStandings";
import { diffLiveSnapshots, type LiveExplainBlock } from "@/lib/leagues/diffLiveSnapshots";
import { LIVE_FEED_MAX_EVENTS, mergeFeedEvents } from "@/lib/leagues/feedEvents";
import { buildLeagueOwnership } from "@/lib/leagues/leagueImpact";
import { pickWeeklyTeam, weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import { exportTerminalState, parseSavedState, useTerminalStore } from "@/store/terminalStore";
import type { EntryHistoryRow, LiveFeedEvent, LiveStandingRow } from "@/types/leagues";
import type { Player, Position } from "@/types/player";
import LiveFeed from "./LiveFeed";
import LeagueStandings, { type StandingsMode } from "./LeagueStandings";
import LiveGameweekPanel from "./LiveGameweekPanel";
import LiveSquad from "./LiveSquad";
import MatchCentre from "./MatchCentre";
import MyLeaguesPanel from "./MyLeaguesPanel";
import { parseLeagueKey } from "@/lib/leagues/leagueKey";
import { useLeaguesData } from "./useLeaguesData";

const EMPTY_PLAYER_MAP = new Map<number, Player>();
const EMPTY_STRING_MAP = new Map<number, string>();

type MobileTab = "LEAGUE" | "TEAM" | "MATCHES" | "FEED";
const MOBILE_TABS: MobileTab[] = ["LEAGUE", "TEAM", "MATCHES", "FEED"];

// Versioned: rows written under the older event shape are dropped rather than
// rendered with missing fields. The Gameweek reconstructs itself anyway.
function feedStorageKey(gameweek: number): string {
  return `fpl-leagues-live-feed-v2-gw${gameweek}`;
}

function readStoredFeed(gameweek: number): LiveFeedEvent[] {
  try {
    const raw = window.localStorage.getItem(feedStorageKey(gameweek));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LiveFeedEvent[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((event) => Boolean(event)
        && typeof event.id === "string"
        && typeof event.kind === "string"
        && typeof event.pointsDelta === "number")
      .slice(0, LIVE_FEED_MAX_EVENTS);
  } catch {
    return [];
  }
}

function storeFeed(gameweek: number, events: readonly LiveFeedEvent[]): void {
  try {
    window.localStorage.setItem(feedStorageKey(gameweek), JSON.stringify(events));
  } catch {
    // Persistence is best effort; the session feed keeps working without it.
  }
}

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const elapsed = Date.now() - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "—";
  const minutes = Math.floor(elapsed / 60000);
  return minutes < 1 ? "<1m" : `${minutes}m`;
}

function StatusCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="status-cell"><span>{label}</span><strong className={tone}>{value}</strong></div>;
}

interface ImportedTeamPayload {
  entryId: number;
  budgetTenths: number;
  teamName?: string;
  managerName?: string;
  squad: { playerIds: number[]; byPosition: Record<Position, number[]> };
  lineup: { gameweek: number; benchGoalkeeperId: number; benchOrder: number[]; captainId: number; viceCaptainId: number };
}

function TeamGate({
  gameweek,
  players,
  bootstrapReady,
}: {
  gameweek: number | null;
  players: Player[];
  bootstrapReady: boolean;
}) {
  const replaceSquad = useTerminalStore((state) => state.replaceSquad);
  const riskMode = useTerminalStore((state) => state.riskMode);
  const [teamId, setTeamId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const raw = teamId.trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1) return setError("Enter a valid FPL team ID.");
    if (gameweek === null) return setError("Waiting for the FPL Gameweek data.");
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/fpl/entry/${raw}?gameweek=${gameweek}`, { headers: { accept: "application/json" } });
      const body = await response.json() as { data?: ImportedTeamPayload; errors?: string[] };
      if (!response.ok || !body.data?.squad || !body.data.lineup) throw new Error(body.errors?.[0] ?? "FPL team import failed.");
      const known = new Set(players.map((player) => player.id));
      if (body.data.squad.playerIds.some((id) => !known.has(id))) {
        throw new Error("This team contains players missing from the current FPL player data. Refresh and try again.");
      }
      const importedPlayers = players.filter((player) => body.data!.squad.playerIds.includes(player.id));
      const fingerprint = pickWeeklyTeam({ squad: importedPlayers, gameweek: body.data.lineup.gameweek, riskMode }).projectionFingerprint;
      const applied = Boolean(fingerprint) && replaceSquad(
        body.data.squad,
        { ...body.data.lineup, lineupProjectionFingerprint: fingerprint },
        body.data.entryId,
        body.data.budgetTenths,
      );
      if (!applied) throw new Error("FPL returned an invalid 15-player squad.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "FPL team import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="leagues-app">
      <header className="topbar">
        <span className="brand"><span className="brand-mark">FPL</span><span>TERMINAL</span></span>
        <WorkspaceSwitcher />
      </header>
      <div className="mode-screen import-screen">
        <p className="mode-tagline">FPL TEAM REQUIRED</p>
        <form className="import-card" onSubmit={submit}>
          <p>Import your FPL Team ID to unlock your live Gameweek, mini-leagues and squad tracker.</p>
          <div className="import-controls">
            <input
              aria-label="FPL TEAM ID"
              inputMode="numeric"
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
              placeholder="4827193"
              data-testid="gate-team-id-input"
            />
            <button className="primary-button" type="submit" disabled={busy || !players.length}>
              {busy ? "IMPORTING…" : "IMPORT"}
            </button>
          </div>
          {!players.length && <span role="status">{bootstrapReady ? "FPL data is unavailable." : "SYNCING FPL DATA…"}</span>}
          {error && <span className="import-error" role="alert">{error}</span>}
        </form>
      </div>
    </main>
  );
}

function WorkspaceBody({
  data,
  entryId,
  onSelectLeague,
}: {
  data: ReturnType<typeof useLeaguesData>;
  entryId: number;
  onSelectLeague: (key: string) => void;
}) {
  const gameweek = data.gameweek;
  const playersById = data.bootstrap.data?.playersById ?? EMPTY_PLAYER_MAP;
  const shortNames = data.bootstrap.data?.teamShortNameById ?? EMPTY_STRING_MAP;
  const picks = data.picks.data;

  const [feedEvents, setFeedEvents] = useState<LiveFeedEvent[]>([]);
  const [mobileTab, setMobileTab] = useState<MobileTab>("LEAGUE");
  const [selectedEntryId, setSelectedEntryId] = useState(entryId);
  const previousLiveRef = useRef<Map<number, LiveStats> | null>(null);
  const feedGameweekRef = useRef<number | null>(null);
  const feedContextRef = useRef<{
    names: Map<number, string>;
    teams: Map<number, number>;
    positions: Map<number, Position>;
    minutes: Map<number, string>;
    explain: ReadonlyMap<number, LiveExplainBlock[]>;
  }>({ names: new Map(), teams: new Map(), positions: new Map(), minutes: new Map(), explain: new Map() });

  const teamIdByElementAll = useMemo(
    () => new Map([...playersById.values()].map((player) => [player.id, player.teamId])),
    [playersById],
  );

  const expectedPointsByElement = useMemo(() => {
    const map = new Map<number, number>();
    if (gameweek === null) return map;
    for (const [id, player] of playersById) {
      map.set(id, weeklyPlayerMetrics(player, gameweek).points);
    }
    return map;
  }, [gameweek, playersById]);

  const myLive = useMemo(() => {
    if (!picks) return null;
    return calculateLiveEntry({
      picks,
      liveElementsByElement: data.liveStatsByElement,
      fixtures: data.fixturesData,
      teamIdByElement: teamIdByElementAll,
      expectedPointsByElement,
    });
  }, [data.fixturesData, data.liveStatsByElement, expectedPointsByElement, picks, teamIdByElementAll]);

  const loadedStandings = data.standings.status === "READY" ? data.standings.data : null;
  const standingsResult = useMemo(() => {
    if (!loadedStandings) return null;
    return calculateLiveStandings({
      rows: loadedStandings.rows,
      userEntryId: entryId,
      picksByEntry: data.memberPicks.data ?? new Map(),
      liveElementsByElement: data.liveStatsByElement,
      fixtures: data.fixturesData,
      teamIdByElement: teamIdByElementAll,
      completePopulation: loadedStandings.completePopulation,
    });
  }, [data.fixturesData, data.liveStatsByElement, data.memberPicks.data, entryId, loadedStandings, teamIdByElementAll]);

  const selectedIsOwn = selectedEntryId === entryId;
  const selectedPicks = selectedIsOwn
    ? picks
    : data.memberPicks.data?.get(selectedEntryId) ?? null;
  const selectedCalculation = useMemo(() => {
    if (selectedIsOwn) return myLive;
    if (!selectedPicks) return null;
    return calculateLiveEntry({
      picks: selectedPicks,
      liveElementsByElement: data.liveStatsByElement,
      fixtures: data.fixturesData,
      teamIdByElement: teamIdByElementAll,
      expectedPointsByElement,
    });
  }, [data.fixturesData, data.liveStatsByElement, expectedPointsByElement, myLive, selectedIsOwn, selectedPicks, teamIdByElementAll]);

  const selectedStanding = useMemo(
    () => standingsResult?.rows.find((row) => row.entryId === selectedEntryId) ?? null,
    [selectedEntryId, standingsResult],
  );
  const profile = data.profile.status === "READY" ? data.profile.data : null;
  const profileManagerName = [profile?.playerFirstName, profile?.playerLastName]
    .filter((name): name is string => Boolean(name))
    .join(" ")
    .trim() || undefined;
  const selectedTeamName = selectedStanding?.entryName
    || (selectedIsOwn ? profile?.name : undefined)
    || `Team ${selectedEntryId}`;
  const selectedManagerName = selectedStanding?.playerName
    || (selectedIsOwn ? profileManagerName : undefined);
  const selectedEntryLabel = selectedManagerName
    ? `${selectedTeamName} · ${selectedManagerName}`
    : selectedTeamName;
  const selectedOverallRank = selectedPicks?.entryHistory?.overallRank
    ?? (selectedIsOwn ? profile?.summaryOverallRank : undefined);
  const selectedGameweekRank = selectedPicks?.entryHistory?.rank
    ?? (selectedIsOwn ? profile?.summaryEventRank : undefined);
  const selectedSquadLoading = data.bootstrap.status === "LOADING"
    || (selectedIsOwn ? data.picks.status === "LOADING" : data.memberPicks.status === "LOADING");

  const selectEntry = useCallback((nextEntryId: number) => {
    setSelectedEntryId(nextEntryId);
    setMobileTab("TEAM");
  }, []);

  const selectLeague = useCallback((key: string) => {
    setSelectedEntryId(entryId);
    onSelectLeague(key);
  }, [entryId, onSelectLeague]);

  const selectedType = parseLeagueKey(data.selectedLeagueKey)?.type;
  const standingsMode: StandingsMode =
    selectedType === "OVERALL" ? "OVERALL"
      : selectedType === "H2H" ? "H2H"
        : loadedStandings && loadedStandings.completePopulation && data.memberPicks.status === "READY" && standingsResult?.completePopulation
          ? "LIVE"
          : "OFFICIAL_ONLY";
  const standingsCalculating = standingsMode === "LIVE" && data.memberPicks.status === "LOADING";

  // Only a match under way or already played has a minute to report. A fixture
  // still to kick off is left out entirely rather than putting its kickoff time
  // in the minute column of an event that cannot have happened yet.
  const minuteLabelsByTeam = useMemo(() => {
    const map = new Map<number, string>();
    for (const fixture of data.fixturesData) {
      if (fixture.state === "UPCOMING") continue;
      const label = fixture.state === "FINISHED"
        ? "FT"
        : `${Math.min(90, Math.floor(fixture.minutes ?? 0))}'`;
      map.set(fixture.homeTeamId, label);
      map.set(fixture.awayTeamId, label);
    }
    return map;
  }, [data.fixturesData]);

  useEffect(() => {
    feedContextRef.current = {
      names: new Map([...playersById.values()].map((player) => [player.id, player.displayName])),
      teams: teamIdByElementAll,
      positions: new Map([...playersById.values()].map((player) => [player.id, player.position])),
      minutes: minuteLabelsByTeam,
      explain: data.liveExplainByElement,
    };
  }, [data.liveExplainByElement, minuteLabelsByTeam, playersById, teamIdByElementAll]);

  useEffect(() => {
    if (gameweek === null || feedGameweewGuard(feedGameweekRef, gameweek)) return;
    previousLiveRef.current = null;
    setFeedEvents(readStoredFeed(gameweek));
  }, [gameweek]);

  // The first snapshot of a session has no predecessor, so the diff reads the
  // Gameweek back out of the cumulative stats instead of starting from nothing.
  // Event ids are stable, so that reconstruction folds onto whatever the last
  // visit already stored rather than repeating it.
  useEffect(() => {
    if (data.liveStatus !== "READY") return;
    const current = data.liveStatsByElement;
    const previous = previousLiveRef.current;
    previousLiveRef.current = current;
    if (!current.size) return;
    const events = diffLiveSnapshots(previous ?? undefined, current, {
      playerNameById: feedContextRef.current.names,
      teamIdByPlayer: feedContextRef.current.teams,
      positionByPlayer: feedContextRef.current.positions,
      minuteLabelByTeam: feedContextRef.current.minutes,
      explainByPlayer: feedContextRef.current.explain,
    });
    if (!events.length) return;
    const gw = feedGameweekRef.current;
    setFeedEvents((existing) => {
      const next = mergeFeedEvents(existing, events);
      if (gw !== null) storeFeed(gw, next);
      return next;
    });
  }, [data.liveStatsByElement, data.liveStatus]);

  const userPlayerById = useMemo(
    () => new Map((myLive?.playerPoints ?? []).map((player) => [player.elementId, player])),
    [myLive],
  );
  const memberPicksList = useMemo(() => Array.from(data.memberPicks.data?.values() ?? []), [data.memberPicks.data]);
  // Every sampled squad is read once here, not once per feed row.
  const leagueOwnership = useMemo(
    () => buildLeagueOwnership(memberPicksList, data.leagueSampleComplete),
    [data.leagueSampleComplete, memberPicksList],
  );
  const nameFor = useCallback(
    (playerId: number) => playersById.get(playerId)?.displayName ?? `Player ${playerId}`,
    [playersById],
  );

  return (
    <>
      <nav className="mobile-tabs leagues-mobile-tabs" aria-label="Leagues panels">
        {MOBILE_TABS.map((tab) => (
          <button key={tab} type="button" className={mobileTab === tab ? "active" : ""} onClick={() => setMobileTab(tab)}>
            {tab}
          </button>
        ))}
      </nav>
      <div className="leagues-grid">
        <aside className={`leagues-column leagues-left ${mobileTab === "LEAGUE" ? "mobile-visible" : ""}`} aria-label="Leagues and standings" data-mobile-tab="LEAGUE">
          <MyLeaguesPanel
            profile={data.profile.status === "READY" ? data.profile.data : null}
            history={data.history.status === "READY" ? data.history.data : null}
            selectedLeagueKey={data.selectedLeagueKey}
            onSelect={selectLeague}
            status={data.profile.status}
          />
          <LeagueStandings
            mode={standingsMode}
            leagueName={loadedStandings?.name ?? (data.selectedLeagueKey === "overall" ? "Overall" : undefined)}
            rows={(standingsResult?.rows ?? []) as readonly LiveStandingRow[]}
            history={(data.history.data?.current ?? []) as EntryHistoryRow[]}
            loading={data.standings.status === "LOADING" || standingsCalculating}
            error={data.standings.error}
            completePopulation={standingsResult?.completePopulation ?? false}
            selectedEntryId={selectedEntryId}
            onSelectEntry={selectEntry}
          />
        </aside>

        <section className={`leagues-column leagues-center-top ${mobileTab === "TEAM" ? "mobile-visible" : ""}`} aria-label="Live Gameweek and squad" data-mobile-tab="TEAM">
          <LiveGameweekPanel
            gameweek={gameweek}
            calculation={selectedCalculation}
            entryLabel={selectedEntryLabel}
            overallRank={selectedOverallRank}
            gameweekRank={selectedGameweekRank}
            onReturnToOwnTeam={selectedIsOwn ? undefined : () => selectEntry(entryId)}
            live={data.anyFixtureLive}
          />
          <section className="leagues-panel" aria-label="Live squad">
            <div className="panel-header">
              <span className="section-kicker">LIVE SQUAD</span>
              <span className="panel-count">{selectedCalculation ? `${selectedCalculation.playerPoints.length}/15` : "—"}</span>
            </div>
            <LiveSquad
              calculation={selectedCalculation}
              playersById={playersById}
              shortNames={shortNames}
              loading={selectedSquadLoading}
            />
          </section>
        </section>

        <section className={`leagues-column leagues-center-bottom ${mobileTab === "MATCHES" ? "mobile-visible" : ""}`} aria-label="Match centre" data-mobile-tab="MATCHES">
          <MatchCentre
            fixtures={data.fixturesData}
            ownedPlayers={myLive?.playerPoints ?? []}
            playersById={playersById}
            teamIdByElementAll={teamIdByElementAll}
            status={data.fixturesStatus}
          />
        </section>

        <aside className={`leagues-column leagues-right ${mobileTab === "FEED" ? "mobile-visible" : ""}`} aria-label="Live feed" data-mobile-tab="FEED">
          <LiveFeed
            events={feedEvents}
            userPlayerById={userPlayerById}
            ownership={leagueOwnership}
            ownershipStatus={data.memberPicks.status}
            playerName={nameFor}
          />
        </aside>
      </div>
    </>
  );
}

function feedGameweewGuard(ref: React.RefObject<number | null>, gameweek: number): boolean {
  if (ref.current === gameweek) return true;
  ref.current = gameweek;
  return false;
}

export default function LeagueScreen() {
  const isHydrated = useTerminalStore((state) => state.isHydrated);
  const entryId = useTerminalStore((state) => state.entryId);
  const savedLeagueKey = useTerminalStore((state) => state.selectedLeagueKey);
  const rememberLeague = useTerminalStore((state) => state.setSelectedLeagueKey);
  const initializeGameweek = useTerminalStore((state) => state.initializeGameweek);

  useEffect(() => {
    const raw = window.localStorage.getItem("fpl-terminal-state");
    useTerminalStore.getState().hydrate(raw ? parseSavedState(raw) : null);
  }, []);

  const data = useLeaguesData(entryId, savedLeagueKey);
  const gameweek = data.gameweek;

  // Opening a league both selects it now and remembers it for the next visit.
  const selectLeague = useCallback((key: string) => {
    data.selectLeague(key);
    rememberLeague(key);
  }, [data, rememberLeague]);

  useEffect(() => {
    if (!isHydrated || data.currentGameweek === null) return;
    initializeGameweek(data.currentGameweek);
  }, [data.currentGameweek, initializeGameweek, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    const state = useTerminalStore.getState();
    window.localStorage.setItem("fpl-terminal-state", JSON.stringify(exportTerminalState(state)));
  }, [entryId, isHydrated, savedLeagueKey]);

  if (!isHydrated) return <main className="leagues-app" aria-busy="true" />;

  if (entryId === undefined) {
    return (
      <TeamGate
        gameweek={gameweek}
        players={data.bootstrap.data?.players ?? []}
        bootstrapReady={data.bootstrap.status === "READY"}
      />
    );
  }

  // The Gameweek data is only trustworthy when FPL answered this poll itself.
  const liveDegraded = data.liveStatus === "ERROR" || data.liveStale;
  const liveNotice = data.liveError ?? data.liveWarning ?? null;

  return (
    <main className="leagues-app">
      <header className="topbar leagues-topbar">
        <span className="brand"><span className="brand-mark">FPL</span><span>TERMINAL</span></span>
        <WorkspaceSwitcher />
        <div className="topbar-stats" aria-label="Leagues status">
          <StatusCell label="GW" value={gameweek !== null ? String(gameweek) : "—"} />
          <StatusCell
            label="MATCHES"
            value={liveDegraded ? "STALE"
              : data.anyFixtureLive ? "LIVE"
                : data.anyFixtureSettling ? "BONUS" : "IDLE"}
            tone={liveDegraded ? "red" : data.anyFixtureLive || data.anyFixtureSettling ? "green" : ""}
          />
          <StatusCell
            label="UPDATED"
            value={ageLabel(data.liveFetchedAt)}
            tone={liveDegraded ? "red" : data.anyFixtureLive ? "green" : ""}
          />
        </div>
        <div className="topbar-actions">
          <button type="button" className="text-button" onClick={() => void data.refreshLive()} data-testid="live-refresh">REFRESH</button>
        </div>
      </header>
      {liveDegraded && (
        <p className="live-notice" role="status">
          LIVE FPL DATA UNAVAILABLE · SHOWING THE LAST GOOD SNAPSHOT{liveNotice ? ` · ${liveNotice.toUpperCase()}` : ""}
        </p>
      )}
      <WorkspaceBody data={data} entryId={entryId} onSelectLeague={selectLeague} />
    </main>
  );
}
