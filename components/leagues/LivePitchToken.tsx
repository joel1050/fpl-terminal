import { TokenShirt } from "@/components/terminal/squad/TokenShirt";
import { fixtureTag, playerValueLabel, roleMarkerFor } from "@/lib/leagues/display";
import type { LiveEntryPlayer } from "@/types/leagues";
import type { Player } from "@/types/player";

/** One player of a live squad on the pitch or bench. Read-only: it is not a button and has no actions. */
export function LivePitchToken({
  player,
  info,
  shortNames,
  benchLabel,
}: {
  player: LiveEntryPlayer;
  info: Player | undefined;
  shortNames: ReadonlyMap<number, string>;
  benchLabel?: string;
}) {
  const name = info?.displayName ?? `Player ${player.elementId}`;
  const marker = roleMarkerFor(player);
  const value = playerValueLabel(player);
  return (
    <div className="token-cell">
      <article
        className={`pitch-token live-token${player.onBench ? " benched" : ""}`}
        data-testid="live-player-card"
        data-player={name}
        aria-label={`${name} live card`}
      >
        <TokenShirt club={info?.teamShortName ?? "—"}>
          {marker && <span className={`token-role ${player.isCaptain ? "captain" : "vice"}`} data-testid="token-role">{marker}</span>}
        </TokenShirt>
        <span className="token-name">{name}</span>
        <span className="token-price">{info ? `£${(info.priceTenths / 10).toFixed(1)}` : "—"}</span>
        <span className="token-fixture live-fixtures">
          {player.fixtures.length
            ? player.fixtures.map((fixture) => (
              <span key={fixture.fixtureId} className={`live-opponent ${fixture.state.toLowerCase().replace("_", "-")}`} data-testid="live-opponent-tag">
                {fixtureTag(fixture, shortNames)}
              </span>
            ))
            : <span className="live-opponent blank">No fixture</span>}
        </span>
        <b className={`live-value ${value.started ? "actual" : "projected"}`} data-testid="live-player-value">
          {value.value} <small>{value.unit}</small>
        </b>
        {benchLabel && <span className="token-bench" data-testid="token-bench">{benchLabel}</span>}
      </article>
    </div>
  );
}
