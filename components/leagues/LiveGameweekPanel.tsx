"use client";

import { compactCount } from "@/lib/display/format";
import { activeChipLabel } from "@/lib/leagues/display";
import type { LiveEntryCalculation } from "@/types/leagues";


export default function LiveGameweekPanel({
  gameweek,
  calculation,
  entryLabel,
  overallRank,
  gameweekRank,
  live,
}: {
  gameweek: number | null;
  calculation: LiveEntryCalculation | null;
  entryLabel: string;
  overallRank?: number;
  gameweekRank?: number;
  live: boolean;
}) {
  const done = calculation?.done ?? 0;
  const liveCount = calculation?.live ?? 0;
  const toPlay = calculation?.toPlay ?? 0;
  return (
    <section className="leagues-panel" aria-label="Live Gameweek summary">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Live Gameweek</span>
          <span className="panel-count">{entryLabel}</span>
        </div>
        <span className={`data-badge ${live ? "live" : ""}`}>GW {gameweek ?? "—"}</span>
      </div>
      <div className="live-metrics">
        <div><span>Live points</span><strong className="cyan-text">{calculation ? calculation.netPoints : "—"}</strong></div>
        <div><span>Overall</span><strong title={overallRank?.toLocaleString()}>{compactCount(overallRank)}</strong></div>
        <div><span>GW rank</span><strong title={gameweekRank?.toLocaleString()}>{compactCount(gameweekRank)}</strong></div>
        <div><span>Done</span><strong className="green">{done || "—"}</strong></div>
        <div><span>Live</span><strong className="amber">{liveCount || "—"}</strong></div>
        <div><span>To play</span><strong>{toPlay || "—"}</strong></div>
        <div><span>Chip</span><strong>{activeChipLabel(calculation?.activeChip)}</strong></div>
      </div>
    </section>
  );
}
