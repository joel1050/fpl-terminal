import type { ReactNode } from "react";
import { money, points } from "@/lib/display/format";

export interface SquadKpisProps {
  /** Projected points for the planning Gameweek, already including the captain. */
  projected: number | undefined;
  gameweek: number;
  /** Tenths. The selling value for an imported team, otherwise the cost of the squad. */
  value: number;
  valueLabel: "COST" | "VALUE";
  bankSlot: ReactNode;
  freeTransfers: number | undefined;
  /** Team rating as a whole percentage. */
  rating: number | undefined;
}

function ratingTone(rating: number): string {
  return rating >= 90 ? "green" : rating >= 80 ? "bright-green" : rating >= 70 ? "yellow" : "red";
}

/** The squad's headline numbers in one strip under the pitch. */
export function SquadKpis({ projected, gameweek, value, valueLabel, bankSlot, freeTransfers, rating }: SquadKpisProps) {
  return (
    <div className="squad-kpis" role="group" aria-label="Squad projection metrics">
      <div className="kpi kpi-proj">
        <span>Proj. GW {gameweek}</span>
        <strong className="cyan">{points(projected)}</strong>
      </div>
      <div className="kpi">
        <span>{valueLabel}</span>
        <strong>{money(value)}</strong>
      </div>
      <div className="kpi kpi-bank">{bankSlot}</div>
      <div className="kpi">
        <span>Transfers</span>
        <strong>{freeTransfers === undefined ? "—" : `${freeTransfers} FT`}</strong>
      </div>
      <div className="kpi" title={rating === undefined ? "Team rating needs a picked squad and live market data." : "Starting XI plus captain xP as a share of the best legal XI the market can field for the same budget."}>
        <span>Team rating</span>
        <strong className={rating === undefined ? "" : ratingTone(rating)}>{rating === undefined ? "—" : `${rating}%`}</strong>
        {rating !== undefined && <span className="kpi-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, rating))}%` }} /></span>}
      </div>
    </div>
  );
}
