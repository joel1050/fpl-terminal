import { describe, expect, it } from "vitest";
// data/snapshots is gitignored, so use the tracked team list: the same 20 clubs.
import teamStrengths from "@/data/manual/team-strengths.json";
import { UNKNOWN_CLUB_COLOUR, clubColour } from "@/lib/display/clubColours";

describe("club colours", () => {
  it("falls back to grey for an unknown club", () => {
    expect(clubColour("ZZZ")).toBe("#3a3f45");
    expect(clubColour("ZZZ")).toBe(UNKNOWN_CLUB_COLOUR);
  });

  it("knows Arsenal", () => {
    expect(clubColour("ARS")).toBe("#ef0107");
  });

  it.each([
    ["ARS", "#ef0107"],
    ["BHA", "#0057b8"],
    ["IPS", "#3a64a3"],
    ["NEW", "#2a2526"],
    ["CHE", "#034694"],
    ["BRE", "#e30613"],
    ["HUL", "#c98a1b"],
    ["LIV", "#c8102e"],
    ["MCI", "#6cabdd"],
    ["BOU", "#da291c"],
    ["MUN", "#da291c"],
    ["NFO", "#dd0000"],
  ])("returns the mock colour for %s", (shortName, colour) => {
    expect(clubColour(shortName)).toBe(colour);
  });

  it("gives every club this season its own colour", () => {
    const shortNames = teamStrengths.teams.map((team) => team.shortName);
    expect(shortNames).toHaveLength(20);
    for (const shortName of shortNames) {
      expect(clubColour(shortName), shortName).not.toBe(UNKNOWN_CLUB_COLOUR);
      expect(clubColour(shortName), shortName).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("does not resolve object prototype keys as clubs", () => {
    expect(clubColour("constructor")).toBe(UNKNOWN_CLUB_COLOUR);
    expect(clubColour("__proto__")).toBe(UNKNOWN_CLUB_COLOUR);
    expect(clubColour("toString")).toBe(UNKNOWN_CLUB_COLOUR);
  });
});
