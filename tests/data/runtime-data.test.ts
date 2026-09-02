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
    // RotoWire publishes a rolling date window, so an auto-refreshed snapshot
    // can carry the tail of the previous gameweek alongside the next one. A
    // full gameweek is the floor; a partial page falls below it.
    expect(rotowire?.snapshot?.fixtures.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(rotowire?.mappings.length).toBeGreaterThan(200);
  });
});
