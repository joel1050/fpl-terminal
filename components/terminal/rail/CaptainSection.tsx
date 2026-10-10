import { points } from "@/lib/display/format";
import { weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import type { Player } from "@/types";
import { PlayerNameLink } from "@/components/terminal/PlayerNameLink";
import { RailSection } from "./DecisionRail";

const SHOWN = 4;

export interface CaptainSectionProps {
  starters: Player[];
  gameweek: number;
  captainId?: number;
  viceCaptainId?: number;
  /** Opens a player's action sheet, where the armband is set. */
  onOpen: (playerId: number) => void;
  /** A click on a name opens the player's details. Leave it out while a swap is pending. */
  onOpenDetails?: (playerId: number) => void;
}

/**
 * The four starters with the most Gameweek xP, as bars. Bars show xP before the
 * captain's double, so every row compares like with like.
 */
export function CaptainSection({ starters, gameweek, captainId, viceCaptainId, onOpen, onOpenDetails }: CaptainSectionProps) {
  const ranked = starters
    .map((player) => ({ player, xp: weeklyPlayerMetrics(player, gameweek).points }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, SHOWN);
  const top = ranked[0]?.xp ?? 0;
  return (
    <RailSection
      title="Captain"
      action={<button type="button" className="rail-action" onClick={() => { if (captainId !== undefined) onOpen(captainId); }} disabled={captainId === undefined} aria-label="Change captain">Change</button>}
    >
      {ranked.length ? (
        <ol className="captain-list">
          {ranked.map(({ player, xp }) => {
            const role = player.id === captainId ? "C" : player.id === viceCaptainId ? "V" : null;
            const width = top > 0 ? (xp / top) * 100 : 0;
            return (
              <li key={player.id}>
                <button type="button" className={`captain-row ${player.id === captainId ? "is-captain" : ""}`} aria-haspopup="dialog" onClick={() => onOpen(player.id)}>
                  <span className="captain-name">
                    <PlayerNameLink playerId={player.id} name={player.displayName} onOpenDetails={onOpenDetails} />
                    {role && <span className={`captain-role ${role === "C" ? "captain" : "vice"}`}>{role}</span>}
                  </span>
                  <span className="captain-bar" aria-hidden="true"><i style={{ width: `${width}%` }} /></span>
                  <span className="captain-xp">{points(xp)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : <p className="rail-empty">Pick a starting XI to see captain options.</p>}
    </RailSection>
  );
}
