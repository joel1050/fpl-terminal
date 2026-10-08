"use client";

import { useEffect, useState, type ReactNode } from "react";
import WorkspaceSwitcher from "@/components/terminal/WorkspaceSwitcher";
import { useTerminalStore } from "@/store/terminalStore";
import { formatDeadline, formatDeadlineCountdown } from "./deadline";

/**
 * The Planner's top bar: the planning Gameweek stepper, the deadline, the data
 * status, and Refresh and More. On phones the CSS keeps only the stepper,
 * Refresh and More.
 */
export function TopBar({ planningGameweek, liveGameweek, onGameweek, deadline, statusSlot, onRefresh, more }: {
  planningGameweek: number;
  liveGameweek: number;
  onGameweek: (gameweek: number) => void;
  deadline: string | null;
  statusSlot: ReactNode;
  onRefresh: () => void;
  more: ReactNode;
}) {
  return (
    <header className="shell-topbar">
      <button type="button" className="brand" onClick={() => useTerminalStore.getState().setMode(null)} aria-label="Return to mode chooser"><span className="brand-mark">FPL</span><span>TERMINAL</span></button>
      <WorkspaceSwitcher />
      <div className="planning-switcher" role="group" aria-label="Select planning Gameweek">
        <button type="button" className="planning-arrow" disabled={planningGameweek <= liveGameweek} onClick={() => onGameweek(planningGameweek - 1)} aria-label="Previous planning Gameweek">←</button>
        <span aria-live="polite">GW {planningGameweek}</span>
        <button type="button" className="planning-arrow" disabled={planningGameweek >= 38} onClick={() => onGameweek(planningGameweek + 1)} aria-label="Next planning Gameweek">→</button>
      </div>
      <div className="shell-status" aria-label="Terminal status">
        <span className="shell-live">LIVE GW {liveGameweek}</span>
        <DeadlineStatus deadline={deadline} />
        {statusSlot}
      </div>
      <div className="shell-actions">
        <button type="button" onClick={onRefresh}>Refresh</button>
        {more}
      </div>
    </header>
  );
}

function DeadlineStatus({ deadline }: { deadline: string | null }) {
  const [countingDown, setCountingDown] = useState(true);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!countingDown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [countingDown]);
  if (!deadline) return <div className="status-cell"><span>DEADLINE</span><strong>—</strong></div>;
  return <button type="button" className="status-cell status-cell-button" aria-pressed={countingDown} title={countingDown ? "Show deadline date" : "Show deadline countdown"} onClick={() => { setNow(Date.now()); setCountingDown((value) => !value); }}><span>DEADLINE</span><strong>{countingDown ? formatDeadlineCountdown(deadline, now) : formatDeadline(deadline)}</strong></button>;
}
