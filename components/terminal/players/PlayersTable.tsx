import { FixtureRun } from "@/components/terminal/fixtures/FixtureChips";
import { universeWeekFor, type UniverseWeekMetrics } from "@/lib/analysis/universeWeek";
import { millions, points } from "@/lib/display/format";
import type { PlayerColumnKey, SortKey } from "@/store/terminalStore";
import type { Player } from "@/types/player";
import { COLUMNS_AFTER_GW, COLUMNS_BEFORE_GW, PLAYER_COLUMN_LABELS, PLAYER_COLUMN_SORT, columnText, startPercentOf } from "./columns";

export type TerminalPlayer = Player & {
  projection: NonNullable<Player["projection"]>;
};

/** A start chance under this percentage shows in orange. */
const START_WARN_BELOW = 80;

export interface PlayersTableProps {
  rows: TerminalPlayer[];
  weeks: Map<number, UniverseWeekMetrics>;
  gameweek: number;
  columns: PlayerColumnKey[];
  sortKey: SortKey;
  sortDirection: "asc" | "desc";
  onSort: (key: SortKey) => void;
  inSquadIds: ReadonlySet<number>;
  onOpen: (id: number) => void;
  onAdd: (player: TerminalPlayer) => void;
}

interface SortableHeadProps {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  direction: "asc" | "desc";
  onSort: (key: SortKey) => void;
  className?: string;
}

/** A sortable header. The active one carries aria-sort, and its arrow is hidden from the accessible name. */
function SortableHead({ label, sortKey, active, direction, onSort, className }: SortableHeadProps) {
  const isActive = active === sortKey;
  return (
    <th scope="col" className={className} aria-sort={isActive ? (direction === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" className={`sort-button ${isActive ? "active" : ""}`} onClick={() => onSort(sortKey)}>
        {label}
        {isActive && <span aria-hidden="true">{direction === "asc" ? " ↑" : " ↓"}</span>}
      </button>
    </th>
  );
}

function OptionalCell({ column, player, week }: { column: PlayerColumnKey; player: TerminalPlayer; week: UniverseWeekMetrics }) {
  const warn = column === "start" && (startPercentOf(player) ?? START_WARN_BELOW) < START_WARN_BELOW;
  return <td className={`num col-${column}${warn ? " warn" : ""}`} data-col={column}>{columnText(column, player, week)}</td>;
}

/** The market as one dense table. Fixed columns are Player, £m, GW xP, Next 5 and Add; the rest come from the Columns menu. */
export function PlayersTable({ rows, weeks, gameweek, columns, sortKey, sortDirection, onSort, inSquadIds, onOpen, onAdd }: PlayersTableProps) {
  const before = COLUMNS_BEFORE_GW.filter((key) => columns.includes(key));
  const after = COLUMNS_AFTER_GW.filter((key) => columns.includes(key));
  const head = (label: string, key: SortKey, className: string) => (
    <SortableHead key={key} label={label} sortKey={key} active={sortKey} direction={sortDirection} onSort={onSort} className={className} />
  );
  const optionalHead = (column: PlayerColumnKey) => head(PLAYER_COLUMN_LABELS[column], PLAYER_COLUMN_SORT[column], `num col-${column}`);
  return (
    <table className="players-table" aria-label="Players">
      <thead>
        <tr>
          {head("Player", "name", "col-player")}
          {head("£m", "price", "num col-price")}
          {before.map(optionalHead)}
          {head("GW xP", "nextGW", "num col-gw")}
          {after.map(optionalHead)}
          <th scope="col" className="col-fixtures">Next 5</th>
          <th scope="col" className="col-add"><span className="visually-hidden">Add</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((player) => {
          const week = weeks.get(player.id) ?? universeWeekFor(player, gameweek);
          const inSquad = inSquadIds.has(player.id);
          return (
            <tr key={player.id} className={inSquad ? "in" : undefined}>
              <td className="col-player">
                <button type="button" className="player-name-button" onClick={() => onOpen(player.id)}>
                  <strong>{player.displayName}</strong>
                  <small>{player.teamShortName} · {player.position}</small>
                </button>
              </td>
              <td className="num col-price">{millions(player.priceTenths)}</td>
              {before.map((key) => <OptionalCell key={key} column={key} player={player} week={week} />)}
              <td className="num col-gw">{points(week.xp)}</td>
              {after.map((key) => <OptionalCell key={key} column={key} player={player} week={week} />)}
              <td className="col-fixtures"><FixtureRun fixtures={player.fixtures} fromGameweek={gameweek} count={5} /></td>
              <td className="col-add">
                <button type="button" className="add-button" disabled={inSquad} aria-label={`Add ${player.displayName}`} onClick={() => onAdd(player)}>
                  {inSquad ? "In" : "+"}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
