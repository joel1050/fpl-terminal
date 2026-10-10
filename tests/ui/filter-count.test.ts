import { describe, expect, it } from "vitest";
import { activeFilterChips, countActiveFilters } from "@/lib/display/filterCount";
import type { TerminalFilters } from "@/store/terminalStore";

const DEFAULTS: TerminalFilters = {
  position: "ALL",
  club: "",
  minPrice: "",
  maxPrice: "",
  minOwnership: "",
  maxOwnership: "",
  availability: "ALL",
  confidence: "ALL",
  risk: "ALL",
  affordableOnly: false,
  excludeSelected: false,
  quick: "ALL",
};

const EVERY_NARROWING_FILTER: TerminalFilters = {
  position: "FWD",
  club: "ARS",
  minPrice: "4.5",
  maxPrice: "9.0",
  minOwnership: "1",
  maxOwnership: "30",
  availability: "DOUBTFUL",
  confidence: "HIGH",
  risk: "LOW",
  affordableOnly: true,
  excludeSelected: true,
  quick: "VALUE",
};

describe("active filter count", () => {
  it("is zero when every filter is at its default", () => {
    expect(countActiveFilters(DEFAULTS)).toBe(0);
    expect(activeFilterChips(DEFAULTS)).toEqual([]);
  });

  it("does not count position, because the filter row shows it", () => {
    expect(countActiveFilters({ ...DEFAULTS, position: "MID" })).toBe(0);
  });

  it("counts each narrowing filter once, and treats an empty text box as the default", () => {
    expect(countActiveFilters(EVERY_NARROWING_FILTER)).toBe(11);
    expect(countActiveFilters({ ...DEFAULTS, maxPrice: "" })).toBe(0);
    expect(countActiveFilters({ ...DEFAULTS, maxPrice: "5.0", minOwnership: "2" })).toBe(2);
  });

  it("gives each active filter a readable chip whose clear patch restores its default", () => {
    expect(activeFilterChips({ ...DEFAULTS, maxPrice: "5.0" })).toEqual([
      { key: "maxPrice", label: "Max £5.0m", clear: { maxPrice: "" } },
    ]);
    expect(activeFilterChips({ ...DEFAULTS, availability: "DOUBTFUL" })[0]).toMatchObject({ key: "availability", label: "Doubtful" });
    expect(activeFilterChips({ ...DEFAULTS, quick: "DIFFERENTIAL" })[0]).toMatchObject({ key: "quick", label: "Differential" });
  });

  it("returns to the defaults once every chip has been cleared", () => {
    const cleared = activeFilterChips(EVERY_NARROWING_FILTER).reduce<TerminalFilters>(
      (filters, chip) => ({ ...filters, ...chip.clear }),
      EVERY_NARROWING_FILTER,
    );
    expect(cleared).toEqual({ ...DEFAULTS, position: "FWD" });
  });
});
