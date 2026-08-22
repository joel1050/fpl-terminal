import { describe, expect, it } from "vitest";
import { classifyFreshness } from "@/components/terminal/TerminalApp";

describe("terminal freshness labels", () => {
  it("keeps a live response live when the stale flag is false", () => {
    expect(classifyFreshness({ source: "live", stale: false })).toBe("LIVE");
  });

  it("marks a stale snapshot response stale", () => {
    expect(classifyFreshness({ source: "snapshot", stale: true })).toBe("STALE");
  });
});
