import { describe, expect, it } from "vitest";
import { millions, ownershipPercent } from "@/lib/display/format";

describe("millions", () => {
  it("shows tenths as millions with one decimal and no symbol", () => {
    expect(millions(96)).toBe("9.6");
    expect(millions(150)).toBe("15.0");
  });
  it("shows a dash for missing or zero prices", () => {
    expect(millions(undefined)).toBe("—");
    expect(millions(0)).toBe("—");
  });
});

describe("ownershipPercent", () => {
  it("rounds to a whole percent from 1% up", () => {
    expect(ownershipPercent(14.6)).toBe("15%");
    expect(ownershipPercent(73.9)).toBe("74%");
    expect(ownershipPercent(1)).toBe("1%");
  });
  it("keeps one decimal below 1%", () => {
    expect(ownershipPercent(0.3)).toBe("0.3%");
  });
  it("shows a dash for zero or missing ownership", () => {
    expect(ownershipPercent(0)).toBe("—");
    expect(ownershipPercent(undefined)).toBe("—");
  });
});
