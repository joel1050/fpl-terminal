import type { ReactNode } from "react";
import type { Position } from "@/types/player";

export interface PitchRow<T> {
  position: Position;
  players: T[];
  slotCount: number;
}

export interface BenchSlot<T> {
  player?: T;
  position: Position;
  label: string;
}

export interface PitchLayoutProps<T> {
  /** Accessible names of the two sections, for example "Starting XI" and "Bench". */
  startingLabel: string;
  benchLabel: string;
  rows: PitchRow<T>[];
  bench: BenchSlot<T>[];
  renderPlayer: (player: T, role: "starter" | "bench", benchLabel?: string) => ReactNode;
  /** Draws a free slot. Leave out where slots are never empty. */
  renderEmpty?: (position: Position, key: string) => ReactNode;
}

/** The starters by line on a pitch, then the bench strip. Shared by the Planner and the Leagues live squad. */
export function PitchLayout<T>({ startingLabel, benchLabel, rows, bench, renderPlayer, renderEmpty }: PitchLayoutProps<T>) {
  return (
    <>
      <section className="starting-xi pitch" aria-label={startingLabel} data-popover-bounds>
        {rows.map(({ position, players, slotCount }) => (
          <div className="position-section starting-position pitch-row" key={position}>
            <div className="position-heading visually-hidden"><span>{position}</span><span>{players.length}/{slotCount}</span></div>
            <div className="pitch-tokens">
              {Array.from({ length: slotCount }, (_, index) => players[index]
                ? renderPlayer(players[index], "starter")
                : renderEmpty?.(position, `${position}-${index}`))}
            </div>
          </div>
        ))}
      </section>
      <section className="bench-section" aria-label={benchLabel}>
        <h3 className="visually-hidden">Bench</h3>
        <div className="bench-strip" data-popover-bounds>
          {bench.map((slot) => slot.player
            ? renderPlayer(slot.player, "bench", slot.label)
            : renderEmpty?.(slot.position, slot.label))}
        </div>
      </section>
    </>
  );
}
