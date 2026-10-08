import { describe, expect, it } from "vitest";
import { clubColour, shirtTextColour } from "@/lib/display/clubColours";

const DARK_TEXT = "#111418";
const LIGHT_TEXT = "#ffffff";

describe("shirt text colour", () => {
  it("uses dark text on a white shirt, as Fulham wear", () => {
    expect(shirtTextColour("#ffffff")).toBe(DARK_TEXT);
    expect(shirtTextColour(clubColour("FUL"))).toBe(DARK_TEXT);
  });

  it("uses white text on a black shirt", () => {
    expect(shirtTextColour("#000000")).toBe(LIGHT_TEXT);
  });

  it.each([
    ["HUL", "#c98a1b"],
    ["MCI", "#6cabdd"],
    ["COV", "#59cbe8"],
  ])("uses dark text on the light shirt of %s", (_club, colour) => {
    expect(shirtTextColour(colour)).toBe(DARK_TEXT);
  });

  it.each([
    ["LIV", "#c8102e"],
    ["SUN", "#eb172b"],
    ["MUN", "#da291c"],
    ["TOT", "#132257"],
  ])("uses white text on the dark shirt of %s", (_club, colour) => {
    expect(shirtTextColour(colour)).toBe(LIGHT_TEXT);
  });
});
