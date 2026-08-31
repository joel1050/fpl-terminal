"use client";

import { useMemo } from "react";
import type { EntryHistoryRow, LiveStandingRow } from "@/types/leagues";
import { compareSortValues, SortableHead, useSortState, type SortValue } from "./tableSort";

export type StandingsMode = "LIVE" | "OFFICIAL_ONLY" | "OVERALL" | "H2H";

type StandingsSortKey = "team" | "manager" | "gw" | "total" | "left" | "delta";

function isLiveRow(mode: StandingsMode, row: LiveStandingRow): boolean {
  return mode === "LIVE" && Number.isFinite(row.gameweekPoints);
}

function standingsSortValue(row: LiveStandingRow, mode: StandingsMode, key: StandingsSortKey): SortValue {
  const live = isLiveRow(mode, row);
  switch (key) {
    case "team": return (row.entryName ?? `Team ${row.entryId}`).toLowerCase();
    case "manager": return (row.playerName ?? "").toLowerCase();
    case "gw": return live ? row.gameweekPoints : row.officialGameweekPoints ?? null;
    case "total": return live ? row.liveTotal : row.officialTotal ?? null;
    case "left": return live ? row.leftToPlay : null;
    case "delta": return live ? row.movement : null;
  }
}

function movementCell(movement: number): { label: string; className: string } {
  if (!Number.isFinite(movement) || movement === 0) return { label: "—", className: "" };
  return movement > 0
    ? { label: `▲ ${movement}`, className: "green" }
    : { label: `▼ ${Math.abs(movement)}`, className: "red" };
}

export default function LeagueStandings({
  mode,
  leagueName,
  rows,
  history,
  loading,
  error,
  completePopulation,
}: {
  mode: StandingsMode;
  leagueName?: string;
  rows: readonly LiveStandingRow[];
  history: EntryHistoryRow[];
  loading: boolean;
  error?: string;
  completePopulation: boolean;
}) {
  const { sortKey, sortDirection, onSort } = useSortState<StandingsSortKey>();
  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    return [...rows].sort((a, b) =>
      compareSortValues(standingsSortValue(a, mode, sortKey), standingsSortValue(b, mode, sortKey), sortDirection),
    );
  }, [rows, mode, sortKey, sortDirection]);

  return (
    <section className="leagues-panel" aria-label="League standings">
      <div className="panel-header">
        <span className="section-kicker">STANDINGS</span>
        <span className="panel-count">{leagueName ?? "—"}</span>
      </div>
      {loading && <div className="empty-state">SYNCING LEAGUE STANDINGS…</div>}
      {!loading && error && <div className="empty-state">{error}</div>}
      {!loading && !error && mode === "H2H" && (
        <div className="empty-state">HEAD-TO-HEAD LEAGUES SHOW OFFICIAL RESULTS ONLY · LIVE MINI-LEAGUE RANKS ARE CLASSIC ONLY</div>
      )}
      {!loading && !error && mode === "OVERALL" && (
        <div className="overall-block">
          <p className="standings-note">GLOBAL LEAGUE · OFFICIAL FPL DATA ONLY. LIVE RANKS CANNOT BE CALCULATED WITHOUT THE FULL POPULATION.</p>
          <table className="league-table">
            <thead><tr><th>GW</th><th>PTS</th><th>TOTAL</th><th>OVERALL RANK</th></tr></thead>
            <tbody>
              {history.slice(-5).reverse().map((row) => (
                <tr key={row.event}>
                  <td>{row.event}</td>
                  <td>{row.points ?? "—"}</td>
                  <td>{row.totalPoints?.toLocaleString() ?? "—"}</td>
                  <td>{row.overallRank?.toLocaleString() ?? "—"}</td>
                </tr>
              ))}
              {!history.length && <tr><td colSpan={4} className="empty-state">No official Gameweek history yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {!loading && !error && (mode === "LIVE" || mode === "OFFICIAL_ONLY") && (
        <>
          {mode === "OFFICIAL_ONLY" && (
            <p className="standings-note">PARTIAL LEAGUE DATA · GW AND TOTAL COME STRAIGHT FROM FPL · NO LIVE RANK CLAIMED</p>
          )}
          {mode === "LIVE" && !completePopulation && (
            <p className="standings-note">PARTIAL LEAGUE DATA · GW AND TOTAL COME STRAIGHT FROM FPL · NO LIVE RANK CLAIMED</p>
          )}
          <div className="table-wrap league-table-wrap">
            <table className="league-table standings-table" data-testid="league-standings">
              <thead>
                <tr>
                  <th>POS</th>
                  <SortableHead label="TEAM" sortKey="team" active={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHead label="MANAGER" sortKey="manager" active={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHead label="GW" sortKey="gw" active={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHead label="LIVE TOTAL" sortKey="total" active={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHead label="LEFT" sortKey="left" active={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHead label="Δ" sortKey="delta" active={sortKey} direction={sortDirection} onSort={onSort} />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const movement = movementCell(row.movement);
                  const live = isLiveRow(mode, row);
                  return (
                    <tr key={row.entryId} className={row.isUser ? "you" : ""} data-testid={row.isUser ? "standings-you-row" : undefined}>
                      <td>{live ? row.localRank : row.officialRank ?? "—"}</td>
                      <td>{row.entryName ?? `Team ${row.entryId}`}</td>
                      <td className="dim-text">{row.playerName ?? "—"}</td>
                      <td>{live ? row.gameweekPoints : row.officialGameweekPoints ?? "—"}</td>
                      <td>{live ? row.liveTotal.toLocaleString() : row.officialTotal?.toLocaleString() ?? "—"}</td>
                      <td>{live ? row.leftToPlay : "—"}</td>
                      <td className={movement.className}>{live ? movement.label : "—"}</td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={7} className="empty-state">No standings rows available.</td></tr>}
              </tbody>
            </table>
          </div>
          {mode === "LIVE" && <p className="standings-footnote">GW AND Δ ARE CALCULATED LOCALLY FROM LIVE FPL SCORING.</p>}
        </>
      )}
    </section>
  );
}
