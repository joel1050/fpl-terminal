import type { RefObject } from "react";
import { Sheet } from "@/components/shell/Sheet";
import { money, points } from "@/lib/display/format";
import type { Player } from "@/types";
import type { ChipKind } from "@/types/chips";
import { pitchXp } from "./PitchToken";

export interface PlayerActionsProps {
  player: Player;
  starter: boolean;
  benchLabel?: string;
  benchIndex: number;
  captain: boolean;
  vice: boolean;
  locked: boolean;
  /** A weekly lineup exists, so captaincy and swaps apply. */
  lineupActive: boolean;
  sellingPriceTenths?: number;
  gameweek: number;
  chip?: ChipKind | null;
  variant: "bottom" | "popover";
  /** The token or row that opened the sheet. A popover opens beside it. */
  anchor?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onInfo: () => void;
  onCaptain: () => void;
  onViceCaptain: () => void;
  onSwap: () => void;
  onMoveBench: (direction: -1 | 1) => void;
  onToggleLock: () => void;
  /** Returns false when the player could not be removed, which keeps the sheet open. */
  onRemove: () => boolean;
}

/**
 * The actions for one player, in a sheet. Captaincy, bench order and lock keep
 * the sheet open. Choosing a swap, opening details or removing closes it.
 */
export function PlayerActions({ player, starter, benchLabel, benchIndex, captain, vice, locked, lineupActive, sellingPriceTenths, gameweek, chip, variant, anchor, onClose, onInfo, onCaptain, onViceCaptain, onSwap, onMoveBench, onToggleLock, onRemove }: PlayerActionsProps) {
  const name = player.displayName;
  const swap = () => {
    onSwap();
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={name} variant={variant} anchor={anchor} placement="side">
      <p className="action-meta">
        {player.teamShortName} · {player.position} · {money(sellingPriceTenths ?? player.priceTenths)}m · {points(pitchXp(player, gameweek, captain, chip))} xP
        {starter ? "" : ` · ${benchLabel && benchLabel !== player.position ? benchLabel : "Bench"}`}
        {captain ? " · Captain" : vice ? " · Vice-captain" : ""}
      </p>
      <div className="action-grid">
        {lineupActive && starter && <>
          <button type="button" className={`action-button ${captain ? "on" : ""}`} aria-label={`Make ${name} captain`} aria-pressed={captain} onClick={onCaptain}>Captain</button>
          <button type="button" className={`action-button ${vice ? "on" : ""}`} aria-label={`Make ${name} vice-captain`} aria-pressed={vice} onClick={onViceCaptain}>Vice-captain</button>
          <button type="button" className="action-button" aria-label={`Select ${name} to move to bench`} onClick={swap}>Move to bench</button>
        </>}
        {lineupActive && !starter && <>
          <button type="button" className="action-button" aria-label={`Select ${name} to move into the starting XI`} onClick={swap}>Start</button>
          {benchIndex >= 0 && <>
            <button type="button" className="action-button" aria-label={`Move ${name} up the bench order`} disabled={benchIndex === 0} onClick={() => onMoveBench(-1)}>Up</button>
            <button type="button" className="action-button" aria-label={`Move ${name} down the bench order`} disabled={benchIndex === 2} onClick={() => onMoveBench(1)}>Down</button>
          </>}
        </>}
        <button type="button" className="action-button" aria-label={`Open ${name} details`} onClick={() => { onInfo(); onClose(); }}>Details</button>
        <button type="button" className={`action-button ${locked ? "on" : ""}`} aria-label={`${locked ? "Unlock" : "Lock"} ${name}`} aria-pressed={locked} onClick={onToggleLock}>{locked ? "Unlock" : "Lock"}</button>
        <button type="button" className="action-button danger" aria-label={`Remove ${name}`} disabled={locked} onClick={() => { if (onRemove()) onClose(); }}>Remove</button>
      </div>
    </Sheet>
  );
}
