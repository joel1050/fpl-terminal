"use client";

import { useMemo, useState } from "react";
import { compactCount } from "@/lib/display/format";
import { leagueTypeLabel } from "@/lib/leagues/display";
import type { ManagerHistory, ManagerProfile } from "@/types/leagues";
import { compareSortValues, SortableHead, useSortState, type SortValue } from "./tableSort";

export type LeagueRow = {
  key: string;
  name: string;
  type: "OVERALL" | "CLASSIC" | "H2H";
  rank?: number;
  teams?: number;
  trendFrom?: number;
  trendTo?: number;
};

type LeagueSortKey = "name" | "type" | "rank" | "teams" | "trend";

function leagueSortValue(row: LeagueRow, key: LeagueSortKey): SortValue {
  switch (key) {
    case "name": return row.name.toLowerCase();
    case "type": return row.type;
    case "rank": return row.rank ?? null;
    case "teams": return row.teams ?? null;
    case "trend": return row.trendFrom && row.trendTo ? row.trendFrom - row.trendTo : null;
  }
}

/**
 * FPL reports a last rank of 0 until an entry has held one, so a first-Gameweek
 * league has no movement to show rather than a fall of several million places.
 */
export function movementLabel(from?: number, to?: number): { label: string; className: string } {
  if (!from || !to || from === to) return { label: "—", className: "" };
  return to < from
    ? { label: `▲ ${compactCount(Math.abs(to - from))}`, className: "green" }
    : { label: `▼ ${compactCount(to - from)}`, className: "red" };
}

export function buildLeagueRows(profile: ManagerProfile | null, history: ManagerHistory | null): LeagueRow[] {
  const rows: LeagueRow[] = [];
  const current = history?.current ?? [];
  const previousOverall = current.length >= 2 ? current[current.length - 2].overallRank : undefined;
  const latestOverall = current.length ? current[current.length - 1].overallRank : undefined;
  rows.push({
    key: "overall",
    name: "Overall",
    type: "OVERALL",
    rank: profile?.summaryOverallRank,
    trendFrom: previousOverall,
    trendTo: latestOverall,
  });
  for (const league of profile?.leagues.classic ?? []) {
    rows.push({
      key: `classic-${league.id}`,
      name: league.name,
      type: "CLASSIC",
      rank: league.entryRank ?? league.rank,
      teams: league.size ?? league.entryCount,
      trendFrom: league.entryLastRank,
      trendTo: league.entryRank ?? league.rank,
    });
  }
  for (const league of profile?.leagues.h2h ?? []) {
    rows.push({
      key: `h2h-${league.id}`,
      name: league.name,
      type: "H2H",
      rank: league.entryRank ?? league.rank,
      teams: league.size ?? league.entryCount,
      trendFrom: league.entryLastRank,
      trendTo: league.entryRank ?? league.rank,
    });
  }
  return rows;
}

export default function MyLeaguesPanel({
  profile,
  history,
  selectedLeagueKey,
  onSelect,
  status,
}: {
  profile: ManagerProfile | null;
  history: ManagerHistory | null;
  selectedLeagueKey: string | null;
  onSelect: (key: string) => void;
  status: "IDLE" | "LOADING" | "READY" | "ERROR";
}) {
  const [search, setSearch] = useState("");
  const { sortKey, sortDirection, onSort } = useSortState<LeagueSortKey>();
  const allRows = useMemo(() => buildLeagueRows(profile, history), [profile, history]);
  const query = search.trim().toLowerCase();
  const rows = useMemo(() => {
    const filtered = query ? allRows.filter((row) => row.name.toLowerCase().includes(query)) : allRows;
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) =>
      compareSortValues(leagueSortValue(a, sortKey), leagueSortValue(b, sortKey), sortDirection),
    );
  }, [allRows, query, sortKey, sortDirection]);

  return (
    <section className="leagues-panel" aria-label="My leagues">
      <div className="panel-header">
        <span className="section-kicker">My leagues</span>
        <span className="panel-count">{allRows.length || "—"} leagues</span>
      </div>
      <div className="search-wrap league-search">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search leagues..."
          aria-label="Search leagues"
        />
        <kbd>/</kbd>
      </div>
      {status === "LOADING" && <div className="empty-state">Loading leagues…</div>}
      {status === "ERROR" && <div className="empty-state">League data unavailable</div>}
      {status !== "LOADING" && status !== "ERROR" && (
        <div className="table-wrap league-table-wrap league-list-wrap">
          <table className="league-table">
            <thead>
              <tr>
                <SortableHead label="League" sortKey="name" active={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHead label="Type" sortKey="type" active={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHead label="Rank" sortKey="rank" active={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHead label="Teams" sortKey="teams" active={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHead label="Trend" sortKey="trend" active={sortKey} direction={sortDirection} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const trend = movementLabel(row.trendFrom, row.trendTo);
                return (
                  <tr
                    key={row.key}
                    className={selectedLeagueKey === row.key ? "selected" : ""}
                    data-league-key={row.key}
                  >
                    <td>
                      <button type="button" className="league-name-button" onClick={() => onSelect(row.key)}>
                        {row.name || `League ${row.key}`}
                      </button>
                    </td>
                    <td className="league-type">{leagueTypeLabel(row.type)}</td>
                    <td title={row.rank?.toLocaleString()}>{compactCount(row.rank)}</td>
                    <td title={row.teams?.toLocaleString()}>{compactCount(row.teams)}</td>
                    <td className={trend.className}>{trend.label}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={5} className="empty-state">No leagues match this search.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
