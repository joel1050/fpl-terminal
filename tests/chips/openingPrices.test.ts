import { describe, expect, it } from "vitest";
import { openingPriceFromSummary, openingPricesFromSummaries } from "@/lib/chips/openingPrices";

describe("opening prices", () => {
  it("reads the price at the requested gameweek", () => {
    const summary = { history: [{ round: 1, value: 45 }, { round: 2, value: 46 }] };
    expect(openingPriceFromSummary(summary, 1)).toEqual({ priceTenths: 45, exact: true });
    expect(openingPriceFromSummary(summary, 2)).toEqual({ priceTenths: 46, exact: true });
  });

  it("falls back to the earliest later row and marks it inexact", () => {
    // Blanked in GW1, so the first observation is GW2.
    const summary = { history: [{ round: 3, value: 48 }, { round: 2, value: 46 }] };
    expect(openingPriceFromSummary(summary, 1)).toEqual({ priceTenths: 46, exact: false });
  });

  it("returns undefined when no row is at or after the gameweek", () => {
    expect(openingPriceFromSummary({ history: [] }, 1)).toBeUndefined();
    expect(openingPriceFromSummary({ history: [{ round: 1, value: 45 }] }, 5)).toBeUndefined();
  });

  it("ignores rows missing a round or a value", () => {
    const summary = { history: [{ round: 1 }, { value: 45 }, { round: 2, value: 46 }] };
    expect(openingPriceFromSummary(summary, 1)).toEqual({ priceTenths: 46, exact: false });
  });

  it("truncates fractional values to integer tenths", () => {
    expect(openingPriceFromSummary({ history: [{ round: 1, value: 45.9 }] }, 1))
      .toEqual({ priceTenths: 45, exact: true });
  });

  it("maps many summaries and skips nulls", () => {
    const summaries = new Map([
      [115, { history: [{ round: 1, value: 45 }] }],
      [112, { history: [{ round: 1, value: 50 }] }],
      [1, null],
    ]);
    expect(openingPricesFromSummaries(summaries, 1)).toEqual({
      115: { priceTenths: 45, exact: true },
      112: { priceTenths: 50, exact: true },
    });
  });
});
