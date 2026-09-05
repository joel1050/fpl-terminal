"use client";

import { useMemo, useState } from "react";
import { playerValueLabel } from "@/lib/leagues/display";
import { buildMatchDetail, type MatchContributor, type MatchDetail } from "@/lib/leagues/matchDetail";
import type { FixtureView, LiveEntryPlayer } from "@/types/leagues";
import type { Player } from "@/types/player";

type MatchFilter = "ALL" | "LIVE" | "FINISHED" | "UPCOMING";
const FILTERS: MatchFilter[] = ["ALL", "LIVE", "FINISHED", "UPCOMING"];

/** Long BPS tables bury the players who can still take a bonus point. */
const BPS_ROWS = 6;

function stateLabel(fixture: FixtureView): string {
  if (fixture.state === "FINISHED") return "FT";
  if (fixture.state === "LIVE") return `${fixture.minutes ?? 0}'`;
  if (!fixture.kickoffTime) return "";
  const date = new Date(fixture.kickoffTime);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function MatchSection({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: readonly MatchContributor[];
  empty: string;
}) {
  return (
    <div className="match-section">
      <span className="section-kicker small">{title}</span>
      {rows.length ? (
        <ul>
          {rows.map((row) => (
            <li key={`${row.elementId}-${row.side}`} className={row.owned ? "owned" : ""}>
              <span className="match-side">{row.side === "HOME" ? "H" : "A"}</span>
              {row.name}
              {row.count > 1 && <strong>×{row.count}</strong>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="match-section-empty">{empty}</p>
      )}
    </div>
  );
}

function MatchBody({ fixture, detail }: { fixture: FixtureView; detail: MatchDetail }) {
  if (fixture.state === "UPCOMING") {
    return <div className="match-detail"><p className="match-section-empty">MATCH NOT STARTED</p></div>;
  }
  const bonusTitle = detail.bonusConfirmed ? "BONUS POINTS" : "BONUS POINTS · PROVISIONAL";
  return (
    <div className="match-detail">
      <MatchSection title="GOALS" rows={detail.scorers} empty="NO GOALS" />
      <MatchSection title="ASSISTS" rows={detail.assists} empty="NO ASSISTS" />
      <div className="match-section">
        <span className="section-kicker small">{bonusTitle}</span>
        {detail.bonus.length ? (
          <ul className="match-bps">
            {detail.bonus.slice(0, BPS_ROWS).map((row) => (
              <li key={row.elementId} className={row.owned ? "owned" : ""}>
                <span className="match-side">{row.side === "HOME" ? "H" : "A"}</span>
                {row.name}
                <em>{row.bonus > 0 ? `+${row.bonus}` : ""}</em>
                <strong>{row.bps}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="match-section-empty">NO BPS RECORDED</p>
        )}
      </div>
    </div>
  );
}

export default function MatchCentre({
  fixtures,
  ownedPlayers,
  playersById,
  teamIdByElementAll,
  status,
}: {
  fixtures: readonly FixtureView[];
  ownedPlayers: readonly LiveEntryPlayer[];
  playersById: ReadonlyMap<number, Player>;
  teamIdByElementAll: ReadonlyMap<number, number>;
  status: "IDLE" | "LOADING" | "READY" | "ERROR";
}) {
  const [filter, setFilter] = useState<MatchFilter>("ALL");
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set<number>());

  const groups = useMemo(() => ({
    LIVE: fixtures.filter((fixture) => fixture.state === "LIVE"),
    FINISHED: fixtures.filter((fixture) => fixture.state === "FINISHED"),
    UPCOMING: fixtures.filter((fixture) => fixture.state === "UPCOMING"),
  }), [fixtures]);

  const visible = filter === "ALL"
    ? [...groups.LIVE, ...groups.FINISHED, ...groups.UPCOMING]
    : groups[filter];

  const nameByElement = useMemo(
    () => new Map([...playersById.values()].map((player) => [player.id, player.displayName])),
    [playersById],
  );

  const detailByFixture = useMemo(() => {
    const map = new Map<number, MatchDetail>();
    for (const fixture of fixtures) {
      map.set(fixture.id, buildMatchDetail(fixture, {
        ownedPlayers,
        teamIdByElement: teamIdByElementAll,
        nameByElement,
      }));
    }
    return map;
  }, [fixtures, nameByElement, ownedPlayers, teamIdByElementAll]);

  const toggle = (fixtureId: number, open: boolean): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(fixtureId);
      else next.delete(fixtureId);
      return next;
    });
  };

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
            const open = expanded.has(fixture.id);
            const detail = detailByFixture.get(fixture.id);
            if (!detail) return null;
            return (
              <details
                key={fixture.id}
                className={`match-row ${fixture.state.toLowerCase()}`}
                data-testid="match-row"
                open={open}
                onToggle={(event) => toggle(fixture.id, event.currentTarget.open)}
              >
                <summary>
                  <div className="match-line">
                    <span className="match-team home">{fixture.homeShortName}</span>
                    <span className="match-score">{fixture.homeScore ?? ""}{fixture.state === "UPCOMING" ? " v " : " — "}{fixture.awayScore ?? ""}</span>
                    <span className="match-team away">{fixture.awayShortName}</span>
                    <span className={`match-state ${fixture.state.toLowerCase()}`}>{stateLabel(fixture)}</span>
                  </div>
                  {detail.owned.length > 0 && (
                    <p className="match-owned">
                      YOU {detail.ownedPoints} PTS ·{" "}
                      {detail.owned.slice(0, 6).map((player) => {
                        const value = playerValueLabel(player);
                        const name = nameByElement.get(player.elementId) ?? `#${player.elementId}`;
                        return `${name} ${value.value}${value.started ? " P" : " xP"}${player.multiplier === 0 ? " (B)" : ""}`;
                      }).join(" · ")}
                      {detail.owned.length > 6 ? ` · +${detail.owned.length - 6} more` : ""}
                    </p>
                  )}
                </summary>
                {open && <MatchBody fixture={fixture} detail={detail} />}
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
