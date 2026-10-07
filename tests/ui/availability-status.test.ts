import { describe, expect, it } from "vitest";
import { availabilityOf } from "@/lib/availability/status";

const p = (status: string, chanceOfPlaying?: number) => ({ status, chanceOfPlaying });

describe("availabilityOf", () => {
  it.each(["i", "u", "n", "s"])("treats status %s as unavailable", (s) => {
    expect(availabilityOf(p(s))).toBe("UNAVAILABLE");
  });
  it("treats d as doubtful", () => expect(availabilityOf(p("d"))).toBe("DOUBTFUL"));
  it("treats a chance under 75 as doubtful", () => expect(availabilityOf(p("a", 50))).toBe("DOUBTFUL"));
  it("treats a chance of 75 as available", () => expect(availabilityOf(p("a", 75))).toBe("AVAILABLE"));
  it("ignores case and spaces in status", () => expect(availabilityOf(p(" I "))).toBe("UNAVAILABLE"));
  it("treats a plain player as available", () => expect(availabilityOf(p("a"))).toBe("AVAILABLE"));
});
