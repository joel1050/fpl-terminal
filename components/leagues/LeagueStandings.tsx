"use client";

import type { EntryHistoryRow, LiveStandingRow } from "@/types/leagues";

export type StandingsMode = "LIVE" | "OFFICIAL_ONLY" | "OVERALL" | "H2H";

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
                <tr><th>POS</th><th>TEAM</th><th>MANAGER</th><th>GW</th><th>LIVE TOTAL</th><th>LEFT</th><th>Δ</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const movement = movementCell(row.movement);
                  const live = mode === "LIVE" && Number.isFinite(row.gameweekPoints);
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
