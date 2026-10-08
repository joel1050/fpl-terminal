import type { PlayerColumnKey, SortKey } from "@/store/terminalStore";

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
