import type { SquadAlert } from "@/types";
import { PlayerNameLink } from "@/components/terminal/PlayerNameLink";
import { RailSection } from "./DecisionRail";

const GLYPH: Record<SquadAlert["severity"], string> = { BAD: "!", WARN: "!", INFO: "i" };

export interface AlertsSectionProps {
  alerts: SquadAlert[];
  onOpen: (playerId: number) => void;
  /** A click on a name opens the player's details. Leave it out while a swap is pending. */
  onOpenDetails?: (playerId: number) => void;
}

/** Up to five things to look at before the deadline, worst first. A row opens that player's action sheet. */
export function AlertsSection({ alerts, onOpen, onOpenDetails }: AlertsSectionProps) {
  return (
    <RailSection title="Needs a look" action={alerts.length ? <span className="rail-count">{alerts.length}</span> : undefined}>
      {alerts.length ? (
        <ul className="alert-list">
          {alerts.map((alert) => (
            <li key={`${alert.kind}-${alert.playerId}`}>
              <button type="button" className={`alert-row ${alert.severity.toLowerCase()}`} onClick={() => onOpen(alert.playerId)}>
                <span className="alert-glyph" aria-hidden="true">{GLYPH[alert.severity]}</span>
                <span className="alert-text">
                  <strong><PlayerNameLink playerId={alert.playerId} name={alert.name} onOpenDetails={onOpenDetails} /> {alert.message}</strong>
                  <small>{alert.detail}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="rail-empty">Nothing needs a look this week.</p>}
    </RailSection>
  );
}
