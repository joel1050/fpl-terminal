import { describe, expect, it } from "vitest";
import { classifyFreshness, computeDataAgeMs, formatDataAge } from "@/components/terminal/TerminalApp";

describe("terminal freshness labels", () => {
  it("keeps a live response live when the stale flag is false", () => {
    expect(classifyFreshness({ source: "live", stale: false })).toBe("LIVE");
  });

  it("marks a stale snapshot response stale", () => {
    expect(classifyFreshness({ source: "snapshot", stale: true })).toBe("STALE");
  });
});

describe("data age display", () => {
  it("anchors the age to the server ageSeconds measured at client receipt, ignoring clock skew", () => {
    const anchor = { ageMs: 120_000, receivedAt: 1_000_000 };
    expect(computeDataAgeMs(1_030_000, anchor, "2999-01-01T00:00:00.000Z")).toBe(150_000);
  });

  it("falls back to the fetchedAt timestamp when no anchor exists", () => {
    const fetchedAt = new Date(1_000_000 - 45_000).toISOString();
    expect(computeDataAgeMs(1_000_000, null, fetchedAt)).toBe(45_000);
  });

  it("returns no age without an anchor or timestamp", () => {
    expect(computeDataAgeMs(1_000_000, null, null)).toBeNull();
    expect(computeDataAgeMs(1_000_000, null, "not-a-date")).toBeNull();
  });

  it("never displays a negative age from a future timestamp", () => {
    expect(computeDataAgeMs(1_000_000, null, new Date(1_000_000 + 60_000).toISOString())).toBe(0);
  });

  it("hides the age while the data is under an hour old", () => {
    expect(formatDataAge(4_000)).toBe("");
    expect(formatDataAge(59 * 60_000)).toBe("");
  });

  it("formats hours and days", () => {
    expect(formatDataAge(60 * 60_000)).toBe("1h ago");
    expect(formatDataAge(3 * 3_600_000)).toBe("3h ago");
    expect(formatDataAge(27 * 3_600_000)).toBe("1d ago");
  });
});
