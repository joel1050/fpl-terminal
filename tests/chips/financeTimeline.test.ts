import { describe, expect, it } from "vitest";
import { accountNormalTransfers, freeTransfersAfterChipWeek, sellingPriceTenths } from "@/lib/chips/finance";
import { replayTimeline } from "@/lib/chips/timeline";
import { reconstructImportBaseline } from "@/lib/chips/importTeam";
import type { Position } from "@/types/player";

const BY_POSITION = { GK: [1, 2], DEF: [3, 4, 5, 6, 7], MID: [8, 9, 10, 11, 12], FWD: [13, 14, 15] } as Record<Position, number[]>;
const SQUAD = Array.from({ length: 15 }, (_, index) => index + 1);

function prices(overrides: Record<number, number> = {}): Map<number, number> {
  const map = new Map<number, number>();
  for (const id of SQUAD) map.set(id, 50);
  map.set(16, 60);
  map.set(17, 70);
  for (const [key, value] of Object.entries(overrides)) map.set(Number(key), value);
  return map;
}

describe("transfer finance", () => {
  it("prices sales in integer tenths with the configured profit fraction", () => {
    expect(sellingPriceTenths(50, 50)).toBe(50);
    expect(sellingPriceTenths(50, 45)).toBe(45);
    expect(sellingPriceTenths(50, 60)).toBe(55);
    expect(sellingPriceTenths(50, 61)).toBe(55); // floor(11 * 0.5) = 5
    expect(Number.isInteger(sellingPriceTenths(53, 68))).toBe(true);
  });

  it("banks one free transfer when idle and charges four points per extra transfer", () => {
    expect(accountNormalTransfers(0, 1)).toMatchObject({ paidTransfers: 0, hitCost: 0, freeTransfersAfter: 2 });
    expect(accountNormalTransfers(1, 1)).toMatchObject({ paidTransfers: 0, hitCost: 0, freeTransfersAfter: 1 });
    expect(accountNormalTransfers(2, 1)).toMatchObject({ paidTransfers: 1, hitCost: 4, freeTransfersAfter: 1 });
    expect(accountNormalTransfers(0, 5)).toMatchObject({ freeTransfersAfter: 5 });
  });

  it("caps rollover at five and transfers at twenty per gameweek", () => {
    expect(accountNormalTransfers(0, 5).freeTransfersAfter).toBe(5);
    const capped = accountNormalTransfers(25, 5);
    expect(capped.normalTransfers).toBe(20);
    expect(capped.paidTransfers).toBe(15);
    expect(capped.hitCost).toBe(60);
  });

  it("preserves saved transfers across wildcard and free hit weeks", () => {
    expect(freeTransfersAfterChipWeek(3)).toBe(3);
    expect(freeTransfersAfterChipWeek(5)).toBe(5);
  });
});

describe("timeline replay", () => {
  const baselineOf = (freeTransfers = 1) => ({
    squadPlayerIds: [...SQUAD],
    byPosition: { GK: [...BY_POSITION.GK], DEF: [...BY_POSITION.DEF], MID: [...BY_POSITION.MID], FWD: [...BY_POSITION.FWD] },
    bankTenths: 20,
    freeTransfers,
    purchasePricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
    financialConfidence: "EXACT" as const,
    startGameweek: 1,
    warnings: [] as string[],
  });

  it("costs normal transfers against the allowance and updates the bank", () => {
    // Sell 15 (50→50) to buy 16 (60): bank 20 + 50 − 60 = 10.
    const timeline = replayTimeline({
      baseline: baselineOf(1),
      plans: { 1: { playerIds: [...SQUAD.filter((id) => id !== 15), 16], chip: null } },
      priceById: prices(),
      fromGameweek: 1,
      toGameweek: 1,
    });
    expect(timeline[1].hitCost).toBe(0);
    expect(timeline[1].bankTenths).toBe(10);
    expect(timeline[1].freeTransfersAfter).toBe(1);
    expect(timeline[1].permanentSquadIds).toContain(16);
  });

  it("charges hits beyond the allowance", () => {
    const timeline = replayTimeline({
      baseline: baselineOf(1),
      plans: { 1: { playerIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16], chip: null } },
      priceById: prices(),
      fromGameweek: 1,
      toGameweek: 2,
    });
    // GW1 uses the single free transfer; GW2 has one free transfer again.
    expect(timeline[1].hitCost).toBe(0);
    expect(timeline[2].hitCost).toBe(0);
  });

  it("makes wildcard transfers unlimited, free, and permanent", () => {
    const wcSquad = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17];
    const timeline = replayTimeline({
      baseline: baselineOf(2),
      plans: { 5: { playerIds: wcSquad, chip: "wildcard" } },
      priceById: prices(),
      fromGameweek: 5,
      toGameweek: 6,
    });
    expect(timeline[5].hitCost).toBe(0);
    expect(timeline[5].isChipFree).toBe(true);
    expect(timeline[5].permanentSquadIds).toEqual(wcSquad);
    expect(timeline[5].activeSquadIds).toEqual(wcSquad);
    expect(timeline[5].freeTransfersAfter).toBe(2);
    // The wildcard squad persists into the following week.
    expect(timeline[6].permanentSquadIds).toEqual(wcSquad);
  });

  it("keeps free hit squads temporary and restores the permanent squad", () => {
    const fhSquad = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17];
    const timeline = replayTimeline({
      baseline: baselineOf(2),
      plans: { 5: { playerIds: fhSquad, chip: "freehit" } },
      priceById: prices(),
      fromGameweek: 5,
      toGameweek: 6,
    });
    expect(timeline[5].hitCost).toBe(0);
    expect(timeline[5].activeSquadIds).toEqual(fhSquad);
    expect(timeline[5].permanentSquadIds).toEqual(SQUAD);
    expect(timeline[5].freeTransfersAfter).toBe(2);
    expect(timeline[6].permanentSquadIds).toEqual(SQUAD);
    expect(timeline[6].activeSquadIds).toEqual(SQUAD);
  });
});

describe("import reconstruction", () => {
  it("reconstructs exact purchase prices from incoming transfer costs", () => {
    const result = reconstructImportBaseline({
      initialSquadIds: [...SQUAD],
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      verifiedInitialPriceIds: [...SQUAD],
      startedEvent: 1,
      currentGameweek: 3,
      currentSquadIds: [...SQUAD.filter((id) => id !== 15), 16],
      currentPricesTenths: { ...Object.fromEntries(SQUAD.map((id) => [id, 50])), 16: 60 },
      bankTenths: 10,
      transfers: [{ elementIn: 16, elementOut: 15, elementInCost: 58, elementOutCost: 52, event: 2 }],
      chips: [],
    });
    expect(result.baseline.purchasePricesTenths[16]).toBe(58);
    expect(result.baseline.financialConfidence).toBe("EXACT");
    // Into GW3 with one FT: GW2 spends it, leaving the fresh one for GW3.
    expect(result.baseline.freeTransfers).toBe(1);
  });

  it("marks late-starting histories estimated without blocking planning", () => {
    const result = reconstructImportBaseline({
      initialSquadIds: [...SQUAD],
      initialPricesTenths: {},
      startedEvent: 4,
      currentGameweek: 5,
      currentSquadIds: [...SQUAD],
      currentPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 55])),
      bankTenths: 5,
      transfers: [],
      chips: [],
    });
    expect(result.baseline.financialConfidence).toBe("ESTIMATED");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.baseline.squadPlayerIds).toHaveLength(15);
  });

  it("replays official hits and chip usage into the free-transfer balance", () => {
    const result = reconstructImportBaseline({
      initialSquadIds: [...SQUAD],
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      startedEvent: 1,
      currentGameweek: 4,
      currentSquadIds: [...SQUAD],
      currentPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      bankTenths: 0,
      transfers: [
        { elementIn: 16, elementOut: 15, elementInCost: 50, elementOutCost: 50, event: 2 },
        { elementIn: 15, elementOut: 16, elementInCost: 50, elementOutCost: 50, event: 2 },
      ],
      chips: [{ kind: "wildcard", gameweek: 3 }],
    });
    // Into GW2 with one FT: two GW2 transfers use it (one hit), banking a
    // fresh one; the GW3 wildcard preserves it for GW4.
    expect(result.baseline.freeTransfers).toBe(1);
  });

  it("banks idle weeks instead of counting gameweeks", () => {
    const idle = (currentGameweek: number) => reconstructImportBaseline({
      initialSquadIds: [...SQUAD],
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      startedEvent: 1,
      currentGameweek,
      currentSquadIds: [...SQUAD],
      currentPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      bankTenths: 0,
      transfers: [],
      chips: [],
    });
    expect(idle(2).baseline.freeTransfers).toBe(1);
    expect(idle(3).baseline.freeTransfers).toBe(2);
    expect(idle(5).baseline.freeTransfers).toBe(4);
    expect(idle(30).baseline.freeTransfers).toBe(5);
  });

  it("deducts transfers already made for the current gameweek", () => {
    const result = reconstructImportBaseline({
      initialSquadIds: [...SQUAD],
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      startedEvent: 1,
      currentGameweek: 3,
      currentSquadIds: [...SQUAD.filter((id) => id !== 15), 16],
      currentPricesTenths: { ...Object.fromEntries(SQUAD.map((id) => [id, 50])), 16: 60 },
      bankTenths: 10,
      transfers: [{ elementIn: 16, elementOut: 15, elementInCost: 58, elementOutCost: 52, event: 3 }],
      chips: [],
    });
    // Into GW3 with two banked; one already spent leaves one available.
    expect(result.baseline.freeTransfers).toBe(1);
  });

  it("treats starting-gameweek selections as unlimited", () => {
    const result = reconstructImportBaseline({
      initialSquadIds: [...SQUAD],
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      startedEvent: 1,
      currentGameweek: 2,
      currentSquadIds: [...SQUAD],
      currentPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      bankTenths: 0,
      transfers: [
        { elementIn: 16, elementOut: 15, elementInCost: 50, elementOutCost: 50, event: 1 },
        { elementIn: 15, elementOut: 16, elementInCost: 50, elementOutCost: 50, event: 1 },
        { elementIn: 17, elementOut: 14, elementInCost: 50, elementOutCost: 50, event: 1 },
      ],
      chips: [],
    });
    expect(result.baseline.freeTransfers).toBe(1);
  });

  it("keeps current-week wildcard transfers free", () => {
    const result = reconstructImportBaseline({
      initialSquadIds: [...SQUAD],
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      startedEvent: 1,
      currentGameweek: 3,
      currentSquadIds: [...SQUAD],
      currentPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      bankTenths: 0,
      transfers: Array.from({ length: 5 }, (_, index) => ({
        elementIn: 30 + index, elementOut: 3 + index, elementInCost: 50, elementOutCost: 50, event: 3,
      })),
      chips: [{ kind: "wildcard", gameweek: 3 }],
    });
    // GW2 idles to two banked; the GW3 wildcard consumes the new one only.
    expect(result.baseline.freeTransfers).toBe(2);
  });
});

describe("import price provenance", () => {
  const baseInput = {
    initialSquadIds: [...SQUAD],
    startedEvent: 1,
    currentGameweek: 3,
    currentSquadIds: [...SQUAD],
    currentPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 52])),
    bankTenths: 0,
    transfers: [],
    chips: [],
    byPosition: BY_POSITION,
  };

  it("marks ESTIMATED when initial prices are unverified stand-ins", () => {
    const result = reconstructImportBaseline({
      ...baseInput,
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 52])),
    });
    expect(result.baseline.financialConfidence).toBe("ESTIMATED");
    expect(result.baseline.warnings.join(" ")).toContain("current price");
  });

  it("keeps EXACT when every initial price is verified", () => {
    const result = reconstructImportBaseline({
      ...baseInput,
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      verifiedInitialPriceIds: [...SQUAD],
    });
    expect(result.baseline.financialConfidence).toBe("EXACT");
    expect(result.baseline.purchasePricesTenths[1]).toBe(50);
  });

  it("keeps EXACT when unverified players were all transferred in", () => {
    // Player 15 was sold; 16 was bought at 60, an exact price from the transfer row.
    const result = reconstructImportBaseline({
      ...baseInput,
      currentSquadIds: [...SQUAD.filter((id) => id !== 15), 16],
      currentPricesTenths: { ...baseInput.currentPricesTenths, 16: 62 },
      initialPricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
      verifiedInitialPriceIds: [...SQUAD],
      transfers: [{ elementIn: 16, elementOut: 15, elementInCost: 60, elementOutCost: 50, event: 2 }],
    });
    expect(result.baseline.financialConfidence).toBe("EXACT");
    expect(result.baseline.purchasePricesTenths[16]).toBe(60);
  });
});

describe("a squad mid-edit", () => {
  // Selling and buying are paired into transfers, but a squad being edited
  // passes through states where they are not: 14 players after a removal, 15
  // again after the replacement. The money has to move at each step.
  const baseline = {
    squadPlayerIds: [...SQUAD],
    byPosition: { GK: [...BY_POSITION.GK], DEF: [...BY_POSITION.DEF], MID: [...BY_POSITION.MID], FWD: [...BY_POSITION.FWD] },
    bankTenths: 10,
    freeTransfers: 1,
    purchasePricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
    financialConfidence: "EXACT" as const,
    startGameweek: 1,
    warnings: [] as string[],
  };
  const week = (playerIds: number[], overrides: Record<number, number> = {}) => replayTimeline({
    baseline,
    plans: { 1: { playerIds, chip: null } },
    priceById: prices(overrides),
    fromGameweek: 1,
    toGameweek: 1,
  })[1];

  it("credits the bank when a player is removed and not yet replaced", () => {
    // Player 15 was bought at 50 and is still 50, so it sells for 50.
    expect(week(SQUAD.filter((id) => id !== 15)).bankTenths).toBe(60);
  });

  it("credits only the selling price, never the risen market price", () => {
    // Bought at 50, now 60: the sale returns 50 + floor(10/2) = 55.
    expect(week(SQUAD.filter((id) => id !== 15), { 15: 60 }).bankTenths).toBe(65);
  });

  it("debits the bank when a player is added into an empty slot", () => {
    expect(week([...SQUAD, 16]).bankTenths).toBe(10 - 60);
  });

  it("charges no hit for a removal on its own", () => {
    // A transfer is an out and an in. Half of one is not a transfer yet.
    const removal = week(SQUAD.filter((id) => id !== 15));
    expect(removal.hitCost).toBe(0);
    expect(removal.transfers).toEqual([]);
    expect(removal.freeTransfersAfter).toBe(2);
  });

  it("forgets the purchase price of a player who has gone", () => {
    expect(week(SQUAD.filter((id) => id !== 15)).purchasePricesTenths[15]).toBeUndefined();
  });

  it("still costs a straight swap as one transfer", () => {
    const swap = week([...SQUAD.filter((id) => id !== 15), 16]);
    expect(swap.bankTenths).toBe(10 + 50 - 60);
    expect(swap.transfers).toHaveLength(1);
  });
});
