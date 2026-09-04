import { describe, expect, it } from "vitest";
import {
  isChipAvailable,
  remainingInventory,
  validateChipSelection,
} from "@/lib/chips/seasonPolicy";
import type { ChipKind } from "@/types/chips";

describe("chip season policy", () => {
  it("grants one of each chip per window when nothing is used", () => {
    const inventory = remainingInventory([]);
    for (const kind of ["wildcard", "freehit", "bboost", "3xc"] as ChipKind[]) {
      expect(inventory[kind]).toHaveLength(38);
    }
  });

  it("expires unused first-window chips independently of the second window", () => {
    const inventory = remainingInventory([{ kind: "wildcard", gameweek: 5 }]);
    expect(inventory.wildcard).toEqual(Array.from({ length: 19 }, (_, index) => index + 20));
    expect(inventory.freehit).toHaveLength(38);
  });

  it("allows the second-window copy after the first-window copy is used", () => {
    expect(isChipAvailable("wildcard", 7, [{ kind: "wildcard", gameweek: 5 }])).toBe(false);
    expect(isChipAvailable("wildcard", 25, [{ kind: "wildcard", gameweek: 5 }])).toBe(true);
  });

  it("rejects duplicate usage within the same window", () => {
    const used = [{ kind: "bboost" as ChipKind, gameweek: 3 }];
    expect(validateChipSelection("bboost", 10, used, {}, 1).legal).toBe(false);
    expect(validateChipSelection("bboost", 10, used, {}, 1).reason).toMatch(/already used/);
    expect(validateChipSelection("bboost", 25, used, {}, 1).legal).toBe(true);
  });

  it("rejects a planned duplicate in the same window", () => {
    expect(validateChipSelection("3xc", 12, [], { 8: "3xc" }, 1).legal).toBe(false);
    expect(validateChipSelection("3xc", 22, [], { 8: "3xc" }, 1).legal).toBe(true);
  });

  it("enforces one chip per gameweek", () => {
    const result = validateChipSelection("freehit", 9, [], { 9: "wildcard" }, 1);
    expect(result.legal).toBe(false);
    expect(result.reason).toMatch(/one chip/i);
    expect(validateChipSelection("wildcard", 9, [], { 9: "wildcard" }, 1).legal).toBe(true);
    const official = validateChipSelection("freehit", 9, [{ kind: "wildcard", gameweek: 9 }], {}, 1);
    expect(official.legal).toBe(false);
    expect(official.reason).toMatch(/one chip/i);
    expect(validateChipSelection("wildcard", 9, [{ kind: "wildcard", gameweek: 9 }], {}, 1).legal).toBe(true);
    expect(validateChipSelection("wildcard", 10, [{ kind: "wildcard", gameweek: 9 }], {}, 1).legal).toBe(false);
  });

  it("rejects free hits in consecutive gameweeks", () => {
    expect(validateChipSelection("freehit", 6, [{ kind: "freehit", gameweek: 5 }], {}, 1).legal).toBe(false);
    expect(validateChipSelection("freehit", 7, [], { 6: "freehit" }, 1).legal).toBe(false);
    // The same window only holds one Free Hit, so a second plan there is a duplicate.
    expect(validateChipSelection("freehit", 8, [], { 6: "freehit" }, 1).reason).toMatch(/already planned/);
    // Consecutive gameweeks can only collide across the window boundary (GW19/GW20).
    expect(validateChipSelection("freehit", 20, [{ kind: "freehit", gameweek: 19 }], {}, 1).legal).toBe(false);
    expect(validateChipSelection("freehit", 20, [{ kind: "freehit", gameweek: 19 }], {}, 1).reason).toMatch(/consecutive/i);
    expect(validateChipSelection("freehit", 20, [{ kind: "freehit", gameweek: 18 }], {}, 1).legal).toBe(true);
  });

  it("accepts clearing a chip", () => {
    expect(validateChipSelection(null, 9, [], { 9: "wildcard" }, 1).legal).toBe(true);
  });
});
