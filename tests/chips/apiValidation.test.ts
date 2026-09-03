import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  getBootstrap: vi.fn(),
  getFixtures: vi.fn(),
}));

vi.mock("@/lib/fpl/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fpl/client")>();
  return { ...actual, getBootstrap: clientMocks.getBootstrap, getFixtures: clientMocks.getFixtures };
});

import { POST } from "@/app/api/chip-suggestions/route";
import { getEntryTransfers } from "@/lib/fpl/client";
import { FplEntryTransfersSchema } from "@/lib/fpl/schemas";
import { normalizeEntryTransfers } from "@/lib/fpl/normalizeLeagues";

const timelineWeek = {
  playerIds: Array.from({ length: 15 }, (_, index) => index + 1),
  chip: null,
};

const validBody = {
  gameweek: 1,
  horizon: 5,
  risk: "BALANCED",
  timeline: { 1: timelineWeek },
  usedChips: [],
  lockedPlayerIds: [],
  baseline: {
    squadPlayerIds: Array.from({ length: 15 }, (_, index) => index + 1),
    byPosition: { GK: [1, 2], DEF: [3, 4, 5, 6, 7], MID: [8, 9, 10, 11, 12], FWD: [13, 14, 15] },
    bankTenths: 10,
    freeTransfers: 1,
    purchasePricesTenths: {},
    financialConfidence: "ESTIMATED",
    startGameweek: 1,
  },
};

describe("chip suggestions API", () => {
  beforeEach(() => {
    clientMocks.getBootstrap.mockResolvedValue({ data: null, freshness: null, error: "FPL returned HTTP 503" });
    clientMocks.getFixtures.mockResolvedValue({ data: null, freshness: null });
  });

  it("rejects malformed requests before touching upstream", async () => {
    for (const body of [
      {},
      { ...validBody, horizon: 0 },
      { ...validBody, horizon: 39 },
      { ...validBody, timeline: { 1: { ...timelineWeek, chip: "assistant-manager" } } },
      { ...validBody, baseline: { ...validBody.baseline, financialConfidence: "ROUGH" } },
      { ...validBody, extra: true },
    ]) {
      const response = await POST(new Request("http://localhost/api/chip-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(400);
    }
    expect(clientMocks.getBootstrap).not.toHaveBeenCalled();
  });

  it("reports upstream failure without solver work", async () => {
    const response = await POST(new Request("http://localhost/api/chip-suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
  });
});

describe("entry transfers endpoint", () => {
  it("rejects invalid team ids without fetching", async () => {
    await expect(getEntryTransfers(0)).resolves.toMatchObject({ data: null, error: expect.any(String) });
    await expect(getEntryTransfers(-3)).resolves.toMatchObject({ data: null, error: expect.any(String) });
  });

  it("normalizes element_in, element_out, costs, event, and time", () => {
    const parsed = FplEntryTransfersSchema.safeParse([
      { element_in: 16, element_out: 15, element_in_cost: 58, element_out_cost: 52, event: 2, time: "2026-08-24T12:00:00Z" },
    ]);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(normalizeEntryTransfers(parsed.data)).toEqual([
        { elementIn: 16, elementOut: 15, elementInCost: 58, elementOutCost: 52, event: 2, time: "2026-08-24T12:00:00Z" },
      ]);
    }
    expect(FplEntryTransfersSchema.safeParse([{ element_in: 16, event: 2 }]).success).toBe(false);
  });
});
