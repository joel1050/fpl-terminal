import { expectedInvolvementPer90 } from "@/lib/analysis/expectedInvolvement";
import type { UniverseWeekMetrics } from "@/lib/analysis/universeWeek";
import { startChanceOf } from "@/lib/availability/startChance";
import { millions, ownershipPercent, points } from "@/lib/display/format";
import type { PlayerColumnKey, SortKey } from "@/store/terminalStore";
import type { Player } from "@/types/player";

/** The short label for each sort key, in the order of the phone's sort select. */
export const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  price: "£m",
  nextGW: "GW xP",
  form: "Form",
  next3: "3GW",
  next5: "5GW",
  value: "5GW xP/£",
  next10: "10GW",
  value10: "10GW xP/£",
  xgi: "xGI/90",
  ownership: "Own",
  start: "Start",
};

/** Start chance as a whole percent, or undefined without evidence. */
export function startPercentOf(player: Player): number | undefined {
  const chance = startChanceOf(player);
  return chance === undefined ? undefined : Math.round(chance * 100);
}

/** The text of one optional table column for a player. The table and the phone list both call this. */
export function columnText(column: PlayerColumnKey, player: Player, week: UniverseWeekMetrics): string {
  switch (column) {
    case "own":
      return ownershipPercent(player.ownership);
    case "form":
      return player.current.form === undefined ? "—" : player.current.form.toFixed(1);
    case "next3":
      return points(week.next3);
    case "next5":
      return points(week.next5);
    case "value5":
      return points(week.value);
    case "next10":
      return points(week.next10);
    case "value10":
      return points(week.value10);
    case "xgi": {
      const value = expectedInvolvementPer90(player);
      return value === undefined ? "—" : value.toFixed(2);
    }
    case "start": {
      const percent = startPercentOf(player);
      return percent === undefined ? "—" : `${percent}%`;
    }
  }
}

/**
 * The value a sort key orders by, as the table shows it, with the key's label.
 * Name is not a stat, so it shows GW xP.
 */
export function sortStat(key: SortKey, player: Player, week: UniverseWeekMetrics): { label: string; text: string } {
  const shown = key === "name" ? "nextGW" : key;
  const label = SORT_LABELS[shown];
  switch (shown) {
    case "price":
      return { label, text: millions(player.priceTenths) };
    case "nextGW":
      return { label, text: points(week.xp) };
    case "ownership":
      return { label, text: columnText("own", player, week) };
    case "value":
      return { label, text: columnText("value5", player, week) };
    default:
      return { label, text: columnText(shown, player, week) };
  }
}

/** Header and Columns-menu label for each optional column. */
export const PLAYER_COLUMN_LABELS: Record<PlayerColumnKey, string> = {
  own: "Own",
  form: "Form",
  next3: "3GW",
  next5: "5GW",
  value5: "5GW xP / £",
  next10: "10GW",
  value10: "10GW xP / £",
  xgi: "xGI/90",
  start: "Start",
};

/** The sort key that each optional column's header sorts by. */
export const PLAYER_COLUMN_SORT: Record<PlayerColumnKey, SortKey> = {
  own: "ownership",
  form: "form",
  next3: "next3",
  next5: "next5",
  value5: "value",
  next10: "next10",
  value10: "value10",
  xgi: "xgi",
  start: "start",
};

/** Optional columns that sit before the fixed GW xP column, then those after it. The rest of the table keeps this order. */
export const COLUMNS_BEFORE_GW: PlayerColumnKey[] = ["own", "form"];
export const COLUMNS_AFTER_GW: PlayerColumnKey[] = ["next3", "next5", "value5", "next10", "value10", "xgi", "start"];
