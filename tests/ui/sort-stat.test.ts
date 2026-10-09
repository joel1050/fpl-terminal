import { describe, expect, it } from "vitest";
import { SORT_LABELS, columnText, sortStat } from "@/components/terminal/players/columns";
import type { UniverseWeekMetrics } from "@/lib/analysis/universeWeek";
import type { SortKey } from "@/store/terminalStore";
import type { Player } from "@/types/player";

const week: UniverseWeekMetrics = { xp: 5.43, next3: 14.26, next5: 22.04, next10: 40.88, value: 3.51, value10: 6.62 };

const player = {
  priceTenths: 145,
  ownership: 31.4,
  status: "a",
  chanceOfPlaying: null,
  current: { form: 7.25, minutes: 900, expectedGoals: 3, expectedAssists: 2 },
  selection: { startProbability: 0.874 },
} as unknown as Player;

const bare = {
  priceTenths: 145,
  ownership: 0,
  status: "a",
  chanceOfPlaying: null,
  current: { minutes: 0 },
} as unknown as Player;

const zero: UniverseWeekMetrics = { xp: 0, next3: 0, next5: 0, next10: 0, value: 0, value10: 0 };

describe("sortStat", () => {
  it.each<[SortKey, string]>([
    ["price", "14.5"],
    ["nextGW", "5.4"],
    ["form", "7.3"],
    ["next3", "14.3"],
    ["next5", "22.0"],
    ["value", "3.5"],
    ["next10", "40.9"],
    ["value10", "6.6"],
    ["xgi", "0.50"],
    ["ownership", "31%"],
    ["start", "87%"],
  ])("%s shows the table text", (key, text) => {
    expect(sortStat(key, player, week)).toEqual({ label: SORT_LABELS[key], text });
  });

  it("falls back to GW xP when sorting by name", () => {
    expect(sortStat("name", player, week)).toEqual({ label: "GW xP", text: "5.4" });
  });

  it("shows the table's empty text for a missing value", () => {
    for (const key of ["form", "xgi", "start", "ownership", "next3", "nextGW"] as SortKey[]) {
      expect(sortStat(key, bare, zero).text).toBe("—");
    }
  });

  it("matches the table cell for every optional column", () => {
    expect(columnText("own", player, week)).toBe(sortStat("ownership", player, week).text);
    expect(columnText("value5", player, week)).toBe(sortStat("value", player, week).text);
    expect(columnText("value10", player, week)).toBe(sortStat("value10", player, week).text);
  });
});
