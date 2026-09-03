import { describe, expect, it } from "vitest";
import { parseBankInput } from "@/components/terminal/TerminalApp";

describe("typing a bank figure", () => {
  it("reads a plain number as tenths", () => {
    expect(parseBankInput("12.5")).toBe(125);
    expect(parseBankInput("0")).toBe(0);
    expect(parseBankInput("4")).toBe(40);
    expect(parseBankInput("100.0")).toBe(1000);
  });

  it("ignores surrounding space and a typed pound sign", () => {
    expect(parseBankInput("  7.5 ")).toBe(75);
    expect(parseBankInput("£7.5")).toBe(75);
  });

  it("rounds to the nearest tenth, because money is integer tenths", () => {
    expect(parseBankInput("1.24")).toBe(12);
    expect(parseBankInput("1.26")).toBe(13);
  });

  it("accepts a figure written without its leading zero", () => {
    // Rejecting this reverted the field to whatever it held before, which
    // reads as the app changing the number rather than refusing it.
    expect(parseBankInput(".8")).toBe(8);
    expect(parseBankInput(".25")).toBe(3);
    expect(parseBankInput("£.8")).toBe(8);
  });

  it("accepts a figure left with a trailing dot", () => {
    expect(parseBankInput("1.")).toBe(10);
    expect(parseBankInput("12.")).toBe(120);
  });

  it("holds its peace on the half-typed states a person passes through", () => {
    // Returning null means "not ready" - the draft stands and nothing commits.
    for (const halfway of ["", " ", ".", "-"]) {
      expect(parseBankInput(halfway)).toBeNull();
    }
  });

  it("refuses nonsense and negatives rather than committing zero", () => {
    for (const bad of ["abc", "1.2.3", "-5", "-0.1", "NaN", "Infinity"]) {
      expect(parseBankInput(bad)).toBeNull();
    }
  });
});
