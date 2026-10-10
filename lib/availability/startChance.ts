import type { Player } from "@/types/player";
import { availabilityOf } from "./status";

/**
 * The chance a player starts, from the selection model, for display. An
 * unavailable player is 0 whatever the model says (AGENTS.md invariant 6).
 * Undefined when the model has no selection for the player.
 */
export function startChanceOf(player: Pick<Player, "status" | "chanceOfPlaying" | "selection">): number | undefined {
  if (availabilityOf(player) === "UNAVAILABLE") return 0;
  return player.selection?.startProbability;
}
