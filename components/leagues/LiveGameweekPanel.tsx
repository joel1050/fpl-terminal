"use client";

import type { LiveEntryCalculation } from "@/types/leagues";

function rankLabel(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString();
}

export default function LiveGameweekPanel({
  gameweek,
  calculation,
  entryLabel,
  overallRank,
  gameweekRank,
  onReturnToOwnTeam,
  live,
}: {
  gameweek: number | null;
  calculation: LiveEntryCalculation | null;
  entryLabel: string;
  overallRank?: number;
  gameweekRank?: number;
  onReturnToOwnTeam?: () => void;
  live: boolean;
}) {
  const done = calculation?.done ?? 0;
  const liveCount = calculation?.live ?? 0;
  const toPlay = calculation?.toPlay ?? 0;
  return (
    <section className="leagues-panel" aria-label="Live Gameweek summary">
      <div className="panel-header">
        <div>
          <span className="section-kicker">LIVE GAMEWEEK</span>
          <span className="panel-count">{entryLabel}</span>
        </div>
        <div className="header-actions">
          {onReturnToOwnTeam && (
            <button type="button" className="icon-button" onClick={onReturnToOwnTeam} aria-label="Return to my team" title="Return to my team">
              ↩
            </button>
          )}
          <span className={`data-badge ${live ? "live" : ""}`}>GW {gameweek ?? "—"}</span>
        </div>
      </div>
      <div className="live-metrics">
        <div><span>LIVE POINTS</span><strong className="cyan-text">{calculation ? calculation.netPoints : "—"}</strong></div>
        <div><span>OFFICIAL RANK</span><strong>{rankLabel(overallRank)}</strong></div>
        <div><span>GW RANK</span><strong>{rankLabel(gameweekRank)}</strong></div>
        <div><span>DONE</span><strong className="green">{done || "—"}</strong></div>
        <div><span>LIVE</span><strong className="amber">{liveCount || "—"}</strong></div>
        <div><span>TO PLAY</span><strong>{toPlay || "—"}</strong></div>
        <div><span>ACTIVE CHIP</span><strong>{calculation?.activeChip ? calculation.activeChip.replace(/_/g, " ").toUpperCase() : "—"}</strong></div>
      </div>
    </section>
  );
}
