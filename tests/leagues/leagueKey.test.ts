import { describe, expect, it } from "vitest";
import { isLeagueKey, parseLeagueKey } from "@/lib/leagues/leagueKey";

describe("league keys", () => {
  it("reads the three shapes the workspace uses", () => {
    expect(parseLeagueKey("overall")).toEqual({ type: "OVERALL" });
    expect(parseLeagueKey("classic-342328")).toEqual({ type: "CLASSIC", id: 342328 });
    expect(parseLeagueKey("h2h-77")).toEqual({ type: "H2H", id: 77 });
  });

  it("rejects anything else, including a saved key from a broken write", () => {
    for (const key of [null, undefined, "", "classic-", "classic-0", "classic-abc", "cup-1", "overall-1"]) {
      expect(parseLeagueKey(key)).toBeNull();
      expect(isLeagueKey(key)).toBe(false);
    }
  });
});
