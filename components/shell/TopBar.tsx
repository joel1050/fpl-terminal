"use client";

import { useEffect, useState, type ReactNode } from "react";
import WorkspaceSwitcher from "@/components/terminal/WorkspaceSwitcher";
import { useTerminalStore } from "@/store/terminalStore";
import { formatDeadlineDate, formatTimeLeft } from "./deadline";

/**
 * The Planner's top bar: the planning Gameweek stepper, the deadline, the data
 * status, and Refresh and More. On phones the CSS swaps the readout for a
 * title ("Gameweek 6", time to the deadline) and keeps only the stepper;
 * Refresh and More live in the tab bar's More sheet there.
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
  const now = useMinuteClock();
  const timeLeft = deadline ? formatTimeLeft(deadline, now) : null;
  return (
    <header className="shell-topbar">
      <button type="button" className="brand" onClick={() => useTerminalStore.getState().setMode(null)} aria-label="Return to mode chooser"><span className="brand-mark">FPL</span><span className="brand-name">Terminal</span></button>
      <WorkspaceSwitcher />
      <div className="shell-title">
        <strong>Gameweek {planningGameweek}</strong>
        <span>{timeLeft === null ? "No deadline yet" : timeLeft === "Closed" ? "Deadline passed" : `Deadline in ${timeLeft}`}</span>
      </div>
      <div className="planning-switcher" role="group" aria-label="Select planning Gameweek">
        <button type="button" className="planning-arrow" disabled={planningGameweek <= liveGameweek} onClick={() => onGameweek(planningGameweek - 1)} aria-label="Previous planning Gameweek">‹</button>
        <span aria-live="polite">GW {planningGameweek}</span>
        <button type="button" className="planning-arrow" disabled={planningGameweek >= 38} onClick={() => onGameweek(planningGameweek + 1)} aria-label="Next planning Gameweek">›</button>
      </div>
      <div className="shell-status" aria-label="Terminal status">
        {planningGameweek !== liveGameweek && <span className="shell-live">Live GW {liveGameweek}</span>}
        <div className="status-cell shell-deadline">
          <span>Deadline</span>
          <strong>{deadline ? formatDeadlineDate(deadline) : "—"}</strong>
          {timeLeft && <span>· {timeLeft}</span>}
        </div>
        {statusSlot}
      </div>
      <div className="shell-actions">
        <button type="button" onClick={onRefresh}>Refresh</button>
        {more}
      </div>
    </header>
  );
}

/** The current time, updated once a minute: the deadline readout shows minutes, not seconds. */
function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
