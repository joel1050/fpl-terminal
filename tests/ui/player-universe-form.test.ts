import { describe, expect, it } from "vitest";
import { normalizeBootstrap } from "@/components/terminal/TerminalApp";

function payload(current: Record<string, unknown> | undefined) {
  return {
    players: [{
      id: 1,
      displayName: "Test Player",
      teamId: 1,
      teamShortName: "TST",
      position: "MID",
      priceTenths: 75,
      ...(current ? { current } : {}),
    }],
  };
}

describe("player universe form column", () => {
  it("carries current form through the browser normalizer", () => {
    const normalized = normalizeBootstrap(payload({ minutes: 180, totalPoints: 12, form: 6.3 }));
    expect(normalized.players[0]?.current.form).toBe(6.3);
  });

  it("keeps a real zero form distinct from a missing one", () => {
    expect(normalizeBootstrap(payload({ minutes: 90, totalPoints: 0, form: "0.0" })).players[0]?.current.form).toBe(0);
    expect(normalizeBootstrap(payload({ minutes: 0, totalPoints: 0 })).players[0]?.current.form).toBeUndefined();
  });
});
