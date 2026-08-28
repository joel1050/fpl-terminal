import { describe, expect, it } from "vitest";
import { loadRotowireSelectionData } from "@/lib/availability/loadSelectionData";
import { loadHistoricalBundle } from "@/lib/historical/load";

describe("production projection data", () => {
  it("ships the generated inputs used by the bootstrap route", async () => {
    const [historical, rotowire] = await Promise.all([
      loadHistoricalBundle(),
      loadRotowireSelectionData(),
    ]);

    expect(historical?.players.length).toBeGreaterThan(500);
    expect(rotowire?.snapshot?.fixtures).toHaveLength(10);
    expect(rotowire?.mappings.length).toBeGreaterThan(200);
  });
});
