"use client";

import { useMemo, useState } from "react";
import { statNumber, type LiveStats } from "@/lib/leagues/calculateLiveEntry";
import { playerValueLabel } from "@/lib/leagues/display";
import type { FixtureView, LiveEntryPlayer } from "@/types/leagues";
import type { Player } from "@/types/player";

type MatchFilter = "ALL" | "LIVE" | "FINISHED" | "UPCOMING";
const FILTERS: MatchFilter[] = ["ALL", "LIVE", "FINISHED", "UPCOMING"];

function stateLabel(fixture: FixtureView): string {
  if (fixture.state === "FINISHED") return "FT";
  if (fixture.state === "LIVE") return `${fixture.minutes ?? 0}'`;
  if (!fixture.kickoffTime) return "";
  const date = new Date(fixture.kickoffTime);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

interface BpsLeader {
  playerId: number;
  name: string;
  bps: number;
}

export default function MatchCentre({
  fixtures,
  ownedPlayers,
  playersById,
  teamIdByElementAll,
  liveStatsByElement,
  status,
}: {
  fixtures: readonly FixtureView[];
  ownedPlayers: readonly LiveEntryPlayer[];
  playersById: ReadonlyMap<number, Player>;
  teamIdByElementAll: ReadonlyMap<number, number>;
  liveStatsByElement: ReadonlyMap<number, LiveStats>;
  status: "IDLE" | "LOADING" | "READY" | "ERROR";
}) {
  const [filter, setFilter] = useState<MatchFilter>("ALL");
  const groups = useMemo(() => ({
    LIVE: fixtures.filter((fixture) => fixture.state === "LIVE"),
    FINISHED: fixtures.filter((fixture) => fixture.state === "FINISHED"),
    UPCOMING: fixtures.filter((fixture) => fixture.state === "UPCOMING"),
  }), [fixtures]);

  const visible = filter === "ALL"
    ? [...groups.LIVE, ...groups.FINISHED, ...groups.UPCOMING]
    : groups[filter];

  const bpsLeadersByFixture = useMemo(() => {
    const map = new Map<number, BpsLeader[]>();
    for (const fixture of fixtures) {
      if (fixture.state !== "LIVE") continue;
      const leaders: BpsLeader[] = [];
      for (const [playerId, stats] of liveStatsByElement) {
        const teamId = teamIdByElementAll.get(playerId);
        if (teamId !== fixture.homeTeamId && teamId !== fixture.awayTeamId) continue;
        leaders.push({
          playerId,
          name: playersById.get(playerId)?.displayName ?? `Player ${playerId}`,
          bps: statNumber(stats, "bps"),
        });
      }
      leaders.sort((left, right) => right.bps - left.bps || left.playerId - right.playerId);
      map.set(fixture.id, leaders.slice(0, 3));
    }
    return map;
  }, [fixtures, liveStatsByElement, playersById, teamIdByElementAll]);

  const ownedInFixture = (fixture: FixtureView): LiveEntryPlayer[] =>
    ownedPlayers.filter((player) => {
      const teamId = playersById.get(player.elementId)?.teamId;
      return teamId === fixture.homeTeamId || teamId === fixture.awayTeamId;
    });

  return (
    <section className="leagues-panel" aria-label="Gameweek fixtures">
      <div className="panel-header">
        <div><span className="section-kicker">MATCH CENTRE</span></div>
        <div className="segmented" role="group" aria-label="Match filter">
          {FILTERS.map((value) => (
            <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
              {value}
            </button>
          ))}
        </div>
      </div>
      {status === "LOADING" && <div className="empty-state">SYNCING FIXTURES…</div>}
      {status === "ERROR" && <div className="empty-state">FIXTURE DATA UNAVAILABLE</div>}
      {(status === "READY" || status === "IDLE") && (
        <div className="match-list">
          {!visible.length && <div className="empty-state">NO MATCHES IN THIS VIEW</div>}
          {visible.map((fixture) => {
            const owned = ownedInFixture(fixture);
            const leaders = bpsLeadersByFixture.get(fixture.id) ?? [];
            return (
              <article key={fixture.id} className={`match-row ${fixture.state.toLowerCase()}`} data-testid="match-row">
                <div className="match-line">
                  <span className="match-team home">{fixture.homeShortName}</span>
                  <span className="match-score">{fixture.homeScore ?? ""}{fixture.state === "UPCOMING" ? " v " : " — "}{fixture.awayScore ?? ""}</span>
                  <span className="match-team away">{fixture.awayShortName}</span>
                  <span className={`match-state ${fixture.state.toLowerCase()}`}>{stateLabel(fixture)}</span>
                </div>
                {owned.length > 0 && (
                  <p className="match-owned">
                    YOU OWN ·{" "}
                    {owned.slice(0, 6).map((player) => {
                      const value = playerValueLabel(player);
                      return `${playersById.get(player.elementId)?.displayName ?? `#${player.elementId}`} ${value.value}${value.started ? " P" : " xP"}`;
                    }).join(" · ")}
                    {owned.length > 6 ? ` · +${owned.length - 6} more` : ""}
                  </p>
                )}
                {fixture.state === "LIVE" && leaders.length > 0 && (
                  <div className="match-bps" aria-label="Provisional BPS">
                    <span className="section-kicker small">PROVISIONAL BPS</span>
                    <ol>
                      {leaders.map((leader, index) => (
                        <li key={leader.playerId}><span>{index + 1}</span>{leader.name}<strong>{leader.bps}</strong></li>
                      ))}
                    </ol>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
