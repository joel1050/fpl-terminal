import { describe, expect, it } from "vitest";
import { applyBaselineCheck, verifyBaselineValue } from "@/lib/chips/verifyBaseline";
import type { TransferBaseline } from "@/types/chips";
import type { Position } from "@/types/player";

const BY_POSITION = { GK: [1, 2], DEF: [3, 4, 5, 6, 7], MID: [8, 9, 10, 11, 12], FWD: [13, 14, 15] } as Record<Position, number[]>;
const SQUAD = Array.from({ length: 15 }, (_, index) => index + 1);

function baselineOf(purchase: Record<number, number>, bankTenths = 3): TransferBaseline {
  return {
    squadPlayerIds: [...SQUAD],
    byPosition: BY_POSITION,
    bankTenths,
    freeTransfers: 1,
    purchasePricesTenths: purchase,
    financialConfidence: "EXACT",
    startGameweek: 3,
    warnings: [],
  };
}

describe("baseline value checksum", () => {
  it("matches when purchase prices are right", () => {
    // 14 players flat at 50, one riser bought at 45 now 47 -> sells for 46.
    const purchase = Object.fromEntries(SQUAD.map((id) => [id, id === 15 ? 45 : 50]));
    const current = Object.fromEntries(SQUAD.map((id) => [id, id === 15 ? 47 : 50]));
    const check = verifyBaselineValue(baselineOf(purchase), current, 14 * 50 + 46 + 3);
    expect(check).toMatchObject({ matches: true, deltaTenths: 0 });
    expect(check.impliedValueTenths).toBe(749);
  });

  it("detects a current-price stand-in on a riser", () => {
    // Purchase recorded as 47 (today's price) instead of the real 45.
    const purchase = Object.fromEntries(SQUAD.map((id) => [id, id === 15 ? 47 : 50]));
    const current = Object.fromEntries(SQUAD.map((id) => [id, id === 15 ? 47 : 50]));
    const check = verifyBaselineValue(baselineOf(purchase), current, 14 * 50 + 46 + 3);
    expect(check.matches).toBe(false);
    expect(check.deltaTenths).toBe(1); // implied 750 vs reported 749
  });

  it("treats a missing current price as a mismatch", () => {
    const purchase = Object.fromEntries(SQUAD.map((id) => [id, 50]));
    const current = Object.fromEntries(SQUAD.filter((id) => id !== 7).map((id) => [id, 50]));
    expect(verifyBaselineValue(baselineOf(purchase), current, 753).matches).toBe(false);
  });

  it("falls back to the current price when a purchase price is absent", () => {
    const current = Object.fromEntries(SQUAD.map((id) => [id, 50]));
    const check = verifyBaselineValue(baselineOf({}), current, 753);
    expect(check).toMatchObject({ impliedValueTenths: 753, matches: true });
  });

  it("accepts a Map of current prices", () => {
    const purchase = Object.fromEntries(SQUAD.map((id) => [id, 50]));
    const current = new Map(SQUAD.map((id) => [id, 50]));
    expect(verifyBaselineValue(baselineOf(purchase), current, 753).matches).toBe(true);
  });

  it("downgrades to ESTIMATED on a mismatch and names the delta", () => {
    const baseline = baselineOf(Object.fromEntries(SQUAD.map((id) => [id, 50])));
    const applied = applyBaselineCheck(baseline, {
      impliedValueTenths: 750, reportedValueTenths: 749, deltaTenths: 1, matches: false,
    });
    expect(applied.financialConfidence).toBe("ESTIMATED");
    expect(applied.warnings.join(" ")).toContain("£0.1m");
  });

  it("never upgrades confidence on a match", () => {
    const baseline = { ...baselineOf({}), financialConfidence: "ESTIMATED" as const };
    const applied = applyBaselineCheck(baseline, {
      impliedValueTenths: 753, reportedValueTenths: 753, deltaTenths: 0, matches: true,
    });
    expect(applied.financialConfidence).toBe("ESTIMATED");
    expect(applied.warnings).toEqual([]);
  });
});
