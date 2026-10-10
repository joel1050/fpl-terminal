import type { ReactNode } from "react";

export interface DecisionRailProps {
  captain: ReactNode;
  alerts: ReactNode;
  transfers: ReactNode;
  chips: ReactNode;
  /** Phones show the rail with the Squad tab, as they show the squad. */
  mobileVisible: boolean;
  /** Header actions: the minimize button. Shown only when the rail is a column. */
  headerAction?: ReactNode;
  collapsed?: boolean;
}

/**
 * The decisions to make before the deadline, in one place. It is a sibling of
 * the squad column, placed by the grid: a third column from 1400px, and under
 * the squad from 901px to 1399px. Phones stack it below the squad.
 */
export function DecisionRail({ captain, alerts, transfers, chips, mobileVisible, headerAction, collapsed = false }: DecisionRailProps) {
  return (
    <aside id="terminal-panel-rail" data-panel="rail" className={`decision-rail ${collapsed ? "rail-collapsed" : ""} ${mobileVisible ? "mobile-visible" : ""}`} aria-label="Analysis">
      <div className="panel-header rail-panel-header">
        <div><span className="panel-title">Analysis</span></div>
        {headerAction && <div className="header-actions">{headerAction}</div>}
      </div>
      {captain}
      {alerts}
      {transfers}
      {chips}
    </aside>
  );
}

/** A titled block in the rail. The heading names the block. */
export function RailSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="rail-section">
      <div className="rail-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}
