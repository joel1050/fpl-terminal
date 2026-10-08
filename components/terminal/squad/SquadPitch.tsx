import type { ReactNode } from "react";
import type { Player, Position } from "@/types";
import { usePitchDrag, type PitchDragOptions } from "./usePitchDrag";

export interface PitchRow {
  position: Position;
  players: Player[];
  slotCount: number;
}

export interface BenchSlot {
  player?: Player;
  position: Position;
  label: string;
}

export interface SquadPitchProps {
  /** Formation and count shown beside the "Starting XI" heading, for example "3-4-3 · 11/11". */
  startingMeta: string;
  /** What the captain adds, for example "Captain counts double: Haaland 5.6 → 11.2". Desktop only. */
  captainCaption?: string;
  rows: PitchRow[];
  bench: BenchSlot[];
  /** Instruction shown while a swap waits for its second player. */
  hint?: string;
  renderPlayer: (player: Player, role: "starter" | "bench", benchLabel?: string) => ReactNode;
  renderEmpty: (position: Position, key: string) => ReactNode;
  /** Drag-to-swap. Leave out while there is no weekly plan to change. */
  drag?: Omit<PitchDragOptions, "enabled">;
}

/** The squad laid out as a pitch (starters by line) with a bench strip below. Both sections sit in one roster. */
export function SquadPitch({ startingMeta, captainCaption, rows, bench, hint, renderPlayer, renderEmpty, drag }: SquadPitchProps) {
  const noDrag = { canDrop: () => ({ legal: false, reason: null }), onDrop: () => {}, onReject: () => {} };
  const { rootRef, rootProps } = usePitchDrag({ enabled: Boolean(drag), ...(drag ?? noDrag) });
  return (
    <div className="squad-roster" data-testid="squad-roster" data-draggable={drag ? "true" : undefined} ref={rootRef} {...rootProps}>
      {hint && <p className="swap-hint">{hint}</p>}
      <div className="pitch-head">
        <h3>Starting XI <span>{startingMeta}</span></h3>
        {captainCaption && <p className="captain-caption">{captainCaption}</p>}
      </div>
      <section className="starting-xi pitch" aria-label="Starting XI">
        {rows.map(({ position, players, slotCount }) => (
          <div className="position-section starting-position pitch-row" key={position}>
            <div className="position-heading visually-hidden"><span>{position}</span><span>{players.length}/{slotCount}</span></div>
            <div className="pitch-tokens">
              {Array.from({ length: slotCount }, (_, index) => players[index]
                ? renderPlayer(players[index], "starter")
                : renderEmpty(position, `${position}-${index}`))}
            </div>
          </div>
        ))}
      </section>
      <section className="bench-section" aria-label="Bench">
        <h3 className="visually-hidden">Bench</h3>
        <div className="bench-strip">
          {bench.map((slot) => slot.player
            ? renderPlayer(slot.player, "bench", slot.label)
            : renderEmpty(slot.position, slot.label))}
        </div>
      </section>
    </div>
  );
}
