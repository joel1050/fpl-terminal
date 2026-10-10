import { FixtureChip, RunStrip } from "@/components/terminal/fixtures/FixtureChips";
import { startChanceOf } from "@/lib/availability/startChance";
import { availabilityOf } from "@/lib/availability/status";
import { points } from "@/lib/display/format";
import { projectedPointsForGameweeks } from "@/lib/projections/projectPlayer";
import { weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import type { Player } from "@/types/player";
import type { ChipKind } from "@/types/chips";
import { PlayerNameLink } from "@/components/terminal/PlayerNameLink";
import { squadFixturesForGameweek } from "./PitchToken";

export interface SquadTableProps {
  starters: Player[];
  /** Bench in order. A slot with no player is left out of the table. */
  bench: Array<{ player?: Player; label: string }>;
  gameweek: number;
  captainId?: number;
  viceCaptainId?: number;
  chip?: ChipKind | null;
  /** Opens the same action sheet that a pitch token opens. */
  onOpen: (player: Player) => void;
  /** A click on a name opens the player's details. Leave it out while a swap is pending. */
  onOpenDetails?: (playerId: number) => void;
}

/** A start chance under this percentage shows in orange. */
const START_WARN_BELOW = 80;

interface SquadTableRowProps {
  player: Player;
  gameweek: number;
  captain: boolean;
  vice: boolean;
  benchLabel?: string;
  onOpen: (player: Player) => void;
  onOpenDetails?: (playerId: number) => void;
}

function SquadTableRow({ player, gameweek, captain, vice, benchLabel, onOpen, onOpenDetails }: SquadTableRowProps) {
  const availability = availabilityOf(player);
  const fixtures = squadFixturesForGameweek(player, gameweek);
  const projectedFixtures = player.projection?.fixtures ?? [];
  const startChance = startChanceOf(player);
  const startPercent = startChance === undefined ? undefined : Math.round(startChance * 100);
  const role = captain ? "captain" : vice ? "vice-captain" : "";
  return (
    <tr data-player={player.displayName} className={benchLabel ? "bench-row" : undefined}>
      <td className="sq-pos">{player.position}</td>
      <td className="sq-player">
        <button type="button" className="sq-row-button" aria-label={[`${player.displayName}, ${player.teamShortName}`, role].filter(Boolean).join(", ")} aria-haspopup="dialog" onClick={() => onOpen(player)}>
          <span className="sq-name"><PlayerNameLink playerId={player.id} name={player.displayName} onOpenDetails={onOpenDetails} /></span>
          {captain && <span className="sq-badge captain" data-testid="table-role" aria-hidden="true">C</span>}
          {vice && <span className="sq-badge vice" data-testid="table-role" aria-hidden="true">V</span>}
          {availability !== "AVAILABLE" && <span className={`sq-flag ${availability === "UNAVAILABLE" ? "bad" : "warn"}`} aria-hidden="true">!</span>}
          <small className="sq-team">{player.teamShortName}{benchLabel ? ` · ${benchLabel}` : ""}</small>
        </button>
      </td>
      <td className="num wide-only">{player.priceTenths > 0 ? (player.priceTenths / 10).toFixed(1) : "—"}</td>
      <td className="sq-next">
        <span className="sq-fixtures">
          {fixtures.length ? fixtures.map((fixture, index) => <FixtureChip key={index} fixture={fixture} />) : <span className="token-blank">BLANK</span>}
        </span>
      </td>
      <td className="num sq-gw">{points(weeklyPlayerMetrics(player, gameweek).points)}</td>
      <td className="num wide-only">{points(projectedPointsForGameweeks(projectedFixtures, gameweek, 3))}</td>
      <td className="num wide-only">{points(projectedPointsForGameweeks(projectedFixtures, gameweek, 5))}</td>
      <td className={`num sq-start ${startPercent !== undefined && startPercent < START_WARN_BELOW ? "warn" : ""}`}>{startPercent === undefined ? "—" : `${startPercent}%`}</td>
      <td className="num wide-only roomy">{player.current.form === undefined ? "—" : player.current.form.toFixed(1)}</td>
      <td className="wide-only roomy"><RunStrip fixtures={player.fixtures} fromGameweek={gameweek} count={5} /></td>
    </tr>
  );
}

/** The squad as one row per player: starters in pitch order, then a dimmed bench. Rows open the same action sheet as tokens. */
export function SquadTable({ starters, bench, gameweek, captainId, viceCaptainId, chip, onOpen, onOpenDetails }: SquadTableProps) {
  const benchPlayers = bench.flatMap((slot) => slot.player ? [{ player: slot.player, label: slot.label }] : []);
  return (
    <table className="squad-table" aria-label="Squad table">
      <thead>
        <tr>
          <th scope="col" className="sq-pos">Pos</th>
          <th scope="col" className="sq-player">Player</th>
          <th scope="col" className="num wide-only">£m</th>
          <th scope="col" className="sq-next">Next</th>
          <th scope="col" className="num sq-gw">GW</th>
          <th scope="col" className="num wide-only">3GW</th>
          <th scope="col" className="num wide-only">5GW</th>
          <th scope="col" className="num sq-start">Start</th>
          <th scope="col" className="num wide-only roomy">Form</th>
          <th scope="col" className="wide-only roomy">Run</th>
        </tr>
      </thead>
      <tbody>
        {starters.length + benchPlayers.length === 0 && <tr className="squad-table-empty"><td colSpan={10}>No players yet. Add them from the Players list.</td></tr>}
        {starters.map((player) => <SquadTableRow key={player.id} player={player} gameweek={gameweek} captain={player.id === captainId} vice={player.id === viceCaptainId} onOpen={onOpen} onOpenDetails={onOpenDetails} />)}
        {benchPlayers.length > 0 && <tr className="squad-table-divider"><td colSpan={10}><span>Bench</span>{chip === "bboost" && <span> · Counts</span>}</td></tr>}
        {benchPlayers.map(({ player, label }) => <SquadTableRow key={player.id} player={player} gameweek={gameweek} captain={player.id === captainId} vice={player.id === viceCaptainId} benchLabel={label} onOpen={onOpen} onOpenDetails={onOpenDetails} />)}
      </tbody>
    </table>
  );
}
