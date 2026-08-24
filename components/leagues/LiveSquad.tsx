"use client";

import type { CSSProperties } from "react";
import { fixtureTag, playerValueLabel, roleMarkerFor } from "@/lib/leagues/display";
import type { LiveEntryCalculation, LiveEntryPlayer } from "@/types/leagues";
import type { Player, Position } from "@/types/player";

const POSITION_ORDER: Position[] = ["GK", "DEF", "MID", "FWD"];

function LivePlayerCard({
  player,
  info,
  shortNames,
}: {
  player: LiveEntryPlayer;
  info: Player | undefined;
  shortNames: ReadonlyMap<number, string>;
}) {
  const name = info?.displayName ?? `Player ${player.elementId}`;
  const marker = roleMarkerFor(player);
  const value = playerValueLabel(player);
  return (
    <article
      className={`squad-slot filled live-slot${player.onBench ? " benched" : ""}`}
      data-testid="live-player-card"
      data-player={name}
      aria-label={`${name} live card`}
    >
      <div className="slot-main">
        <span className="slot-player">
          {name}
          {marker && <span className={`live-role ${marker === "C" ? "captain" : "vice"}`}>{marker}</span>}
        </span>
        <span className="slot-sub">{info?.teamShortName ?? "—"} · {info ? `£${(info.priceTenths / 10).toFixed(1)}` : "—"}</span>
        <span className="live-opponents">
          {player.fixtures.length
            ? player.fixtures.map((fixture) => (
              <span key={fixture.fixtureId} className={`live-opponent ${fixture.state.toLowerCase().replace("_", "-")}`} data-testid="live-opponent-tag">
                {fixtureTag(fixture, shortNames)}
              </span>
            ))
            : <span className="live-opponent blank">NO FIXTURE</span>}
        </span>
        <span className={`slot-value ${value.started ? "actual" : "projected"}`} data-testid="live-player-value">
          {value.value} <small>{value.unit}</small>
        </span>
      </div>
    </article>
  );
}

/**
 * The live roster mirrors the Planner Starting XI: centered position groups
 * (GK / DEF / MID / FWD) plus a four-card bench rail. Cards are read-only
 * status indicators — no role buttons, no bench labels.
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
  if (loading || !calculation) {
    return <div className="empty-state">{loading ? "SYNCING LIVE SQUAD…" : "LIVE SQUAD UNAVAILABLE"}</div>;
  }
  const starters = calculation.playerPoints.filter((player) => !player.onBench);
  const bench = calculation.playerPoints
    .filter((player) => player.onBench)
    .sort((left, right) => left.position - right.position);
  return (
    <div className="lineup-roster" data-testid="live-roster">
      <section className="starting-xi" aria-label="Live starting XI">
        {POSITION_ORDER.map((position) => {
          const players = starters
            .filter((player) => player.positionCode === position)
            .sort((left, right) => left.position - right.position);
          return (
            <div className="position-section starting-position" key={position}>
              <div className="position-heading"><span>{position}</span><span>{players.length}</span></div>
              <div className="slot-grid starting-slot-grid" style={{ "--slot-count": Math.max(players.length, 1) } as CSSProperties}>
                {players.map((player) => (
                  <LivePlayerCard
                    key={player.elementId}
                    player={player}
                    info={playersById.get(player.elementId)}
                    shortNames={shortNames}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </section>
      <section className="bench-section" aria-label="Live bench">
        <div className="lineup-roster-heading"><span>BENCH</span><span>{bench.length} PLAYERS</span></div>
        <div className="slot-grid bench-slot-grid">
          {bench.map((player) => (
            <LivePlayerCard
              key={player.elementId}
              player={player}
              info={playersById.get(player.elementId)}
              shortNames={shortNames}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
