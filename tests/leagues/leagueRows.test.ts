import { describe, expect, it } from "vitest";
import { buildLeagueRows, movementLabel } from "@/components/leagues/MyLeaguesPanel";
import type { ManagerProfile } from "@/types/leagues";

const profile: ManagerProfile = {
  entryId: 4827193,
  summaryOverallRank: 6258145,
  leagues: {
    classic: [
      { id: 19, name: "Spurs", leagueType: "s", entryRank: 184065, entryLastRank: 0, size: 284648 },
      { id: 342328, name: "Super JoPo", leagueType: "x", entryRank: 4, entryLastRank: 2, size: 4 },
    ],
    h2h: [],
    cup: [],
  },
};

describe("my leagues rows", () => {
  it("keeps the league size FPL reports", () => {
    const rows = buildLeagueRows(profile, null);
    expect(rows.find((row) => row.key === "classic-19")?.teams).toBe(284648);
  });

  it("claims no movement when there is no previous rank", () => {
    expect(movementLabel(0, 184065).label).toBe("—");
    expect(movementLabel(undefined, 12).label).toBe("—");
  });

  it("still reports a real rise or fall", () => {
    expect(movementLabel(2, 4)).toEqual({ label: "▼ 2", className: "red" });
    expect(movementLabel(9, 4)).toEqual({ label: "▲ 5", className: "green" });
  });
});
