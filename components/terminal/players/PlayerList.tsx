import { FixtureRun } from "@/components/terminal/fixtures/FixtureChips";
import { universeWeekFor, type UniverseWeekMetrics } from "@/lib/analysis/universeWeek";
import { money, ownershipPercent } from "@/lib/display/format";
import type { SortKey } from "@/store/terminalStore";
import { SORT_LABELS, sortStat } from "./columns";
import type { TerminalPlayer } from "./PlayersTable";

/** The phone row shows four Gameweeks of fixtures. */
const LIST_FIXTURE_COUNT = 4;

const SORT_KEYS = Object.keys(SORT_LABELS) as SortKey[];

export interface PlayerSortLineProps {
  sortKey: SortKey;
  sortDirection: "asc" | "desc";
  onSort: (key: SortKey) => void;
}

/** The phone's sort control. A new key sorts descending; the same key again reverses the order. */
export function PlayerSortLine({ sortKey, sortDirection, onSort }: PlayerSortLineProps) {
  return (
    <div className="player-sort-line">
      <label>
        <span>Sorted by</span>
        <select value={sortKey} onChange={(event) => onSort(event.target.value as SortKey)} aria-label="Sort players">
          {SORT_KEYS.map((key) => <option value={key} key={key}>{SORT_LABELS[key]}</option>)}
        </select>
      </label>
      <button type="button" className="sort-direction" onClick={() => onSort(sortKey)} aria-label="Reverse sort order">
        {sortDirection === "desc" ? "↓" : "↑"}
      </button>
    </div>
  );
}

export interface PlayerListProps {
  rows: TerminalPlayer[];
  weeks: Map<number, UniverseWeekMetrics>;
  gameweek: number;
  sortKey: SortKey;
  inSquadIds: ReadonlySet<number>;
  onOpen: (id: number) => void;
  onAdd: (player: TerminalPlayer) => void;
}

/** The phone market: one row per player with its fixtures, the stat it is sorted by (GW xP by default) and Add. The desktop table is PlayersTable. */
export function PlayerList({ rows, weeks, gameweek, sortKey, inSquadIds, onOpen, onAdd }: PlayerListProps) {
  return (
    <ul className="player-list" aria-label="Players">
      {rows.map((player) => {
        const week = weeks.get(player.id) ?? universeWeekFor(player, gameweek);
        const stat = sortStat(sortKey, player, week);
        const inSquad = inSquadIds.has(player.id);
        return (
          <li key={player.id} className={`player-row${inSquad ? " in" : ""}`} data-testid="player-row">
            <button type="button" className="player-row-main" onClick={() => onOpen(player.id)}>
              <strong>{player.displayName}</strong>
              <small>{`${player.position} · ${player.teamShortName} · ${money(player.priceTenths)} · ${ownershipPercent(player.ownership)} owned`}</small>
            </button>
            <span className="player-row-fixtures">
              <FixtureRun fixtures={player.fixtures} fromGameweek={gameweek} count={LIST_FIXTURE_COUNT} />
            </span>
            <span className="player-row-xp">
              <strong>{stat.text}</strong>
              <small>{stat.label}</small>
            </span>
            <button type="button" className="add-button" disabled={inSquad} aria-label={`Add ${player.displayName}`} onClick={() => onAdd(player)}>
              {inSquad ? "In" : "+"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
