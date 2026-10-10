"use client";

import type { MouseEvent } from "react";
import { usePhoneLayout } from "@/components/shell/usePhoneLayout";

export interface PlayerNameLinkProps {
  playerId: number;
  name: string;
  /**
   * Opens the player's details. Leave it out for a plain name, for example
   * while a swap is pending and a tap must finish the swap.
   */
  onOpenDetails?: (playerId: number) => void;
  className?: string;
}

/**
 * A player's name that opens their details on a click and underlines on hover.
 * It is a span, not a button, so it can sit inside the token and row buttons;
 * keyboard users reach details through the action sheet's Info button. Phones
 * get a plain name, because a tap there should open the action sheet.
 */
export function PlayerNameLink({ playerId, name, onOpenDetails, className }: PlayerNameLinkProps) {
  const phone = usePhoneLayout();
  if (!onOpenDetails || phone) return <span className={className}>{name}</span>;
  const open = (event: MouseEvent) => {
    event.stopPropagation();
    onOpenDetails(playerId);
  };
  return <span className={["player-name-link", className].filter(Boolean).join(" ")} data-testid="player-name-link" onClick={open}>{name}</span>;
}
