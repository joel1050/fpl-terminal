"use client";

import { useMemo } from "react";
import { PitchLayout } from "@/components/terminal/squad/PitchLayout";
import { buildLivePitch } from "@/lib/leagues/livePitch";
import type { LiveEntryCalculation } from "@/types/leagues";
import type { Player } from "@/types/player";
import { LivePitchToken } from "./LivePitchToken";

/**
 * The live roster uses the Planner's pitch layout: starters by line, then the
 * bench strip. Tokens are read-only status indicators.
 */
export default function LiveSquad({
  calculation,
  playersById,
  shortNames,
  loading,
}: {
  calculation: LiveEntryCalculation | null;
  playersById: ReadonlyMap<number, Player>;
  shortNames: ReadonlyMap<number, string>;
  loading: boolean;
}) {
  const pitch = useMemo(() => (calculation ? buildLivePitch(calculation.playerPoints) : null), [calculation]);
  if (loading || !calculation || !pitch) {
    return <div className="empty-state">{loading ? "Loading live squad…"
      : <><strong>No live squad yet</strong><span>Picks appear once the Gameweek deadline passes.</span></>}</div>;
  }
  return (
    <div className="lineup-roster" data-testid="live-roster">
      <div className="pitch-head">
        <h3>Starting XI {pitch.formation && <span>{pitch.formation}</span>}</h3>
      </div>
      <PitchLayout
        startingLabel="Live starting XI"
        benchLabel="Live bench"
        rows={pitch.rows}
        bench={pitch.bench}
        renderPlayer={(player, role, benchLabel) => (
          <LivePitchToken
            key={player.elementId}
            player={player}
            info={playersById.get(player.elementId)}
            shortNames={shortNames}
            benchLabel={role === "bench" ? benchLabel : undefined}
          />
        )}
      />
    </div>
  );
}
