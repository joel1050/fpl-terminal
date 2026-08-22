import { describe, expect, it } from "vitest";
import { formatSelectionUpdatedAt, parsePlayerSelection } from "@/components/terminal/TerminalApp";

describe("player selection payloads", () => {
  it("parses probabilities, rating, freshness, and evidence from the API shape", () => {
    expect(parsePlayerSelection({
      startProbability: 0.82,
      cameoProbability: 0.1,
      noAppearanceProbability: 0.08,
      expectedMinutes: 79,
      nailedRating: 5,
      confidence: "HIGH",
      updatedAt: "2026-08-20T18:00:00.000Z",
      evidence: [
        { source: "ROTOWIRE_XI", detail: "Named in predicted XI" },
        { source: "HISTORICAL_STARTS", detail: "Started 8 of last 10" },
      ],
    })).toEqual({
      startProbability: 0.82,
      cameoProbability: 0.1,
      noAppearanceProbability: 0.08,
      expectedMinutes: 79,
      nailedRating: 5,
      confidence: "HIGH",
      updatedAt: "2026-08-20T18:00:00.000Z",
      evidence: [
        { source: "ROTOWIRE_XI", detail: "Named in predicted XI" },
        { source: "HISTORICAL_STARTS", detail: "Started 8 of last 10" },
      ],
    });
  });

  it("keeps an absent or empty selection block explicitly unavailable", () => {
    expect(parsePlayerSelection(undefined)).toBeUndefined();
    expect(parsePlayerSelection({})).toBeUndefined();
    expect(formatSelectionUpdatedAt("")).toBe("—");
  });
});
