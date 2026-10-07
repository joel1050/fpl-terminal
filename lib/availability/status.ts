import type { Player } from "@/types";

export type Availability = "AVAILABLE" | "DOUBTFUL" | "UNAVAILABLE";

/** FPL status wins: a negative status is absolute (domain invariant 6). */
export function availabilityOf(player: Pick<Player, "status" | "chanceOfPlaying">): Availability {
  const status = player.status.trim().toLowerCase();
  if (["i", "u", "n", "s"].includes(status)) return "UNAVAILABLE";
  if (status === "d") return "DOUBTFUL";
  if (typeof player.chanceOfPlaying === "number" && player.chanceOfPlaying < 75) return "DOUBTFUL";
  return "AVAILABLE";
}
