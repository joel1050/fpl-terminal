import type { LiveEntryPlayer } from "@/types/leagues";
import type { Position } from "@/types/player";

export const PITCH_LINES: readonly Position[] = ["GK", "DEF", "MID", "FWD"];

export interface LivePitchRow {
  position: Position;
  players: LiveEntryPlayer[];
  slotCount: number;
}

export interface LiveBenchSlot {
  player: LiveEntryPlayer;
  position: Position;
  label: string;
}

export interface LivePitch {
  rows: LivePitchRow[];
  bench: LiveBenchSlot[];
  /** Outfield line sizes, for example "4-4-2". Empty when no outfield player starts. */
  formation: string;
}

const byPickOrder = (left: LiveEntryPlayer, right: LiveEntryPlayer) => left.position - right.position;

/**
 * Lays a live squad out as the Planner pitch does: starters by line in pick order,
 * then the bench in pick order. The bench goalkeeper reads "GK"; outfield subs read B1, B2, B3.
 * Rows hold only the players present, so a live pitch has no empty slots.
 */
export function buildLivePitch(players: readonly LiveEntryPlayer[]): LivePitch {
  const starters = players.filter((player) => !player.onBench);
  const rows = PITCH_LINES.map((position) => {
    const line = starters.filter((player) => player.positionCode === position).sort(byPickOrder);
    return { position, players: line, slotCount: line.length };
  });
  let outfield = 0;
  const bench = players
    .filter((player) => player.onBench)
    .sort(byPickOrder)
    .map((player) => ({
      player,
      position: player.positionCode,
      label: player.positionCode === "GK" ? "GK" : `B${++outfield}`,
    }));
  const lines = rows.filter((row) => row.position !== "GK" && row.players.length);
  return { rows, bench, formation: lines.map((row) => row.players.length).join("-") };
}
