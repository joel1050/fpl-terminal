"use client";

import { useMemo } from "react";
import type { EntryHistoryRow, LiveStandingRow } from "@/types/leagues";
import { compareSortValues, SortableHead, useSortState, type SortValue } from "./tableSort";

export type StandingsMode = "LIVE" | "OFFICIAL_ONLY" | "OVERALL" | "H2H";

type StandingsSortKey = "team" | "gw" | "total" | "left" | "delta";

function isLiveRow(mode: StandingsMode, row: LiveStandingRow): boolean {
  return mode === "LIVE" && Number.isFinite(row.gameweekPoints);
}

function standingsSortValue(row: LiveStandingRow, mode: StandingsMode, key: StandingsSortKey): SortValue {
  const live = isLiveRow(mode, row);
  switch (key) {
    case "team": return (row.entryName ?? `Team ${row.entryId}`).toLowerCase();
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
  selectedEntryId,
  onSelectEntry,
}: {
  mode: StandingsMode;
  leagueName?: string;
  rows: readonly LiveStandingRow[];
  history: EntryHistoryRow[];
  loading: boolean;
  error?: string;
  completePopulation: boolean;
  selectedEntryId: number;
  onSelectEntry: (entryId: number) => void;
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
        <span className="section-kicker">Standings</span>
        <span className="panel-count">{leagueName ?? "—"}</span>
      </div>
      {loading && <div className="empty-state">Loading standings…</div>}
      {!loading && error && <div className="empty-state">{error}</div>}
      {!loading && !error && mode === "H2H" && (
        <div className="empty-state">Head-to-head leagues show official results only. Live ranks cover classic leagues.</div>
      )}
      {!loading && !error && mode === "OVERALL" && (
        <div className="overall-block">
          <p className="standings-note">Overall league: official FPL data only. Live ranks need every team in the league.</p>
          <table className="league-table">
            <thead><tr><th>GW</th><th>Points</th><th>Total</th><th>Overall rank</th></tr></thead>
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
          {(mode === "OFFICIAL_ONLY" || !completePopulation) && (
            <p className="standings-note">Partial league data: GW and total come straight from FPL, with no live rank.</p>
          )}
          <div className="table-wrap league-table-wrap">
            <table className="league-table standings-table" data-testid="league-standings">
              <thead>
                <tr>
                  <th className="standings-pos">#</th>
                  <SortableHead label="Team" sortKey="team" active={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHead label="GW" sortKey="gw" active={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHead label="Total" sortKey="total" active={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHead label="Left" sortKey="left" active={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHead label="Δ" sortKey="delta" active={sortKey} direction={sortDirection} onSort={onSort} />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const movement = movementCell(row.movement);
                  const live = isLiveRow(mode, row);
                  const selected = row.entryId === selectedEntryId;
                  const teamName = row.entryName ?? `Team ${row.entryId}`;
                  const managerName = row.playerName?.trim();
                  const accessibleLabel = managerName
                    ? `View live squad for ${teamName}, managed by ${managerName}`
                    : `View live squad for ${teamName}`;
                  return (
                    <tr
                      key={row.entryId}
                      className={[row.isUser ? "you" : "", selected ? "selected" : ""].filter(Boolean).join(" ")}
                      data-testid={row.isUser ? "standings-you-row" : undefined}
                    >
                      <td className="standings-pos">{live ? row.localRank : row.officialRank ?? "—"}</td>
                      <td className="standings-team">
                        <button
                          type="button"
                          className="league-name-button"
                          onClick={() => onSelectEntry(row.entryId)}
                          aria-label={accessibleLabel}
                          aria-pressed={selected}
                        >
                          {teamName}
                        </button>
                        <span className="standings-manager">{managerName || "—"}{row.isUser ? " · you" : ""}</span>
                      </td>
                      <td>{live ? row.gameweekPoints : row.officialGameweekPoints ?? "—"}</td>
                      <td>{live ? row.liveTotal.toLocaleString() : row.officialTotal?.toLocaleString() ?? "—"}</td>
                      <td>{live ? row.leftToPlay : "—"}</td>
                      <td className={movement.className}>{live ? movement.label : "—"}</td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={6} className="empty-state">No standings rows available.</td></tr>}
              </tbody>
            </table>
          </div>
          {mode === "LIVE" && <p className="standings-footnote">GW and Δ are worked out here from live FPL scoring.</p>}
        </>
      )}
    </section>
  );
}
