import { describe, expect, it } from "vitest";
import { compactCount, millions, ownershipPercent } from "@/lib/display/format";

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

describe("compactCount", () => {
  it("keeps counts below 100,000 exact", () => {
    expect(compactCount(795)).toBe("795");
    expect(compactCount(87_631)).toBe("87,631");
  });
  it("shortens larger counts to thousands or millions", () => {
    expect(compactCount(376_534)).toBe("376.5k");
    expect(compactCount(1_297_724)).toBe("1.30m");
    expect(compactCount(10_833_601)).toBe("10.8m");
  });
  it("moves up a unit rather than showing 1000.0k or 10.00m", () => {
    expect(compactCount(999_960)).toBe("1.00m");
    expect(compactCount(9_996_000)).toBe("10.0m");
  });
  it("keeps the sign and shows a dash when missing", () => {
    expect(compactCount(-250_000)).toBe("-250.0k");
    expect(compactCount(undefined)).toBe("—");
  });
});
