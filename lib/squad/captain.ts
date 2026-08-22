import type { Player } from "@/types/player";
import type { StartingXIPlan, SquadValidation } from "@/types/squad";
import { selectStartingXI, type StartingXIOptions } from "./startingXI";

export interface CaptainPlan {
  captainId: number;
  viceCaptainId: number;
}

function starterIds(starters: StartingXIPlan | readonly number[]): Set<number> {
  return new Set("playerIds" in starters ? starters.playerIds : starters);
}

export function validateCaptainVice(
  players: readonly Player[],
  captainId: number | undefined,
  viceCaptainId: number | undefined,
  starters?: StartingXIPlan | readonly number[],
): SquadValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set(players.map((player) => player.id));
  const starting = starters ? starterIds(starters) : starterIds(selectStartingXI(players));

  if (captainId === undefined) errors.push("A captain must be selected.");
  else if (!ids.has(captainId)) errors.push("Captain must belong to the squad.");
  else if (!starting.has(captainId)) errors.push("Captain must be a starter.");

  if (viceCaptainId === undefined) errors.push("A vice-captain must be selected.");
  else if (!ids.has(viceCaptainId)) errors.push("Vice-captain must belong to the squad.");
  else if (!starting.has(viceCaptainId)) errors.push("Vice-captain must be a starter.");

  if (captainId !== undefined && captainId === viceCaptainId) {
    errors.push("Captain and vice-captain must be different players.");
  }
  return { legal: errors.length === 0, errors, warnings };
}

export function chooseCaptainVice(
  players: readonly Player[],
  starters?: StartingXIPlan | readonly number[],
  options: StartingXIOptions = {},
): CaptainPlan {
  const plan = starters ?? selectStartingXI(players, options);
  const ids = starterIds(plan);
  const byId = new Map(players.map((player) => [player.id, player]));
  const ordered = [...ids]
    .map((id) => byId.get(id)!)
    .sort((a, b) => {
      const aScore = options.expectedPoints?.[a.id] ?? a.projection?.nextGW ?? a.current.pointsPer90 ?? 0;
      const bScore = options.expectedPoints?.[b.id] ?? b.projection?.nextGW ?? b.current.pointsPer90 ?? 0;
      return bScore - aScore || a.id - b.id;
    });
  if (ordered.length < 2) throw new Error("Captain and vice-captain need two starters.");
  return { captainId: ordered[0].id, viceCaptainId: ordered[1].id };
}

export const validateCaptaincy = validateCaptainVice;
export const selectCaptainVice = chooseCaptainVice;
