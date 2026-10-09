import { TokenShirt } from "@/components/terminal/squad/TokenShirt";
import { fixtureChip, fixtureTag, playerValueLabel, roleMarkerFor } from "@/lib/leagues/display";
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
        title={player.fixtures.map((fixture) => fixtureTag(fixture, shortNames)).join(", ") || undefined}
      >
        <TokenShirt club={info?.teamShortName ?? "—"}>
          {marker && <span className={`token-role ${player.isCaptain ? "captain" : "vice"}`} data-testid="token-role">{marker}</span>}
        </TokenShirt>
        <span className="token-name">{name}</span>
        <span className="token-line">
          <span className="token-fixture">
            {player.fixtures.length
              ? player.fixtures.map((fixture) => {
                const chip = fixtureChip(fixture, shortNames);
                return (
                  <span key={fixture.fixtureId} className={`fc live-opponent ${fixture.state.toLowerCase().replace("_", "-")}`} data-testid="live-opponent-tag" title={fixtureTag(fixture, shortNames)}>
                    {chip.opponent}{chip.status && <span className="chip-status"> {chip.status}</span>}
                  </span>
                );
              })
              : <span className="token-blank live-opponent blank">No fixture</span>}
          </span>
          <b className={`token-xp live-value ${value.started ? "actual" : "projected"}`} data-testid="live-player-value">
            {value.value} <small>{value.unit}</small>
          </b>
        </span>
        <span className="token-price">{info ? `£${(info.priceTenths / 10).toFixed(1)}` : "—"}</span>
        {benchLabel && <span className="token-bench" data-testid="token-bench">{benchLabel}</span>}
      </article>
    </div>
  );
}
