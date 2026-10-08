import { describe, expect, it } from "vitest";
import { formatTimeLeft } from "@/components/shell/deadline";

describe("formatTimeLeft", () => {
  const deadline = "2026-08-29T10:00:00Z";
  const before = (minutes: number) => Date.parse(deadline) - minutes * 60_000;

  it("shows days and hours when a day or more is left", () => {
    expect(formatTimeLeft(deadline, before(3 * 1_440 + 5 * 60 + 30))).toBe("3d 5h");
  });

  it("shows hours and minutes inside a day", () => {
    expect(formatTimeLeft(deadline, before(5 * 60 + 12))).toBe("5h 12m");
  });

  it("shows minutes inside an hour, rounding part-minutes up", () => {
    expect(formatTimeLeft(deadline, before(12) + 30_000)).toBe("12m");
  });

  it("says Closed once the deadline passes, and a dash for a bad date", () => {
    expect(formatTimeLeft(deadline, before(-5))).toBe("Closed");
    expect(formatTimeLeft("not a date")).toBe("—");
  });
});
