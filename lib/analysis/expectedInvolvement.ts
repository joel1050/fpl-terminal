import type { Player } from "@/types/player";

/** In-season xGI per 90, falling back to the prior season when this one has no minutes yet. */
export function expectedInvolvementPer90(player: Pick<Player, "current" | "historical">): number | undefined {
  const minutes = player.current.minutes;
  const expectedGoals = player.current.expectedGoals;
  const expectedAssists = player.current.expectedAssists;
  if (minutes <= 0 || expectedGoals === undefined || expectedAssists === undefined || !Number.isFinite(expectedGoals + expectedAssists)) {
    const historical = player.historical?.xGIPer90;
    return historical !== undefined && Number.isFinite(historical) ? historical : undefined;
  }
  return (expectedGoals + expectedAssists) / minutes * 90;
}
