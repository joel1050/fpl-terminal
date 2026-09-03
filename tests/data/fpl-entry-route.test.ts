import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEntry: vi.fn(),
  getEntryPicks: vi.fn(),
  getEntryHistory: vi.fn(),
  getEntryTransfers: vi.fn(),
  getBootstrap: vi.fn(),
  getPlayerSummary: vi.fn(),
}));

vi.mock("@/lib/fpl/client", () => mocks);

import { GET } from "@/app/api/fpl/entry/[id]/route";

const picks = [
  { element: 1, position: 1, element_type: 1 },
  { element: 3, position: 2, element_type: 2 },
  { element: 4, position: 3, element_type: 2 },
  { element: 5, position: 4, element_type: 2 },
  { element: 8, position: 5, element_type: 3 },
  { element: 9, position: 6, element_type: 3 },
  { element: 10, position: 7, element_type: 3 },
  { element: 11, position: 8, element_type: 3 },
  { element: 12, position: 9, element_type: 3 },
  { element: 13, position: 10, element_type: 4, is_captain: true },
  { element: 14, position: 11, element_type: 4, is_vice_captain: true },
  { element: 2, position: 12, element_type: 1 },
  { element: 6, position: 13, element_type: 2 },
  { element: 7, position: 14, element_type: 2 },
  { element: 15, position: 15, element_type: 4 },
];

describe("FPL team import route", () => {
  beforeEach(() => {
    mocks.getEntry.mockResolvedValue({ data: { id: 4827193, name: "Test XI", player_first_name: "Test", player_last_name: "Manager" }, freshness: null });
    mocks.getEntryPicks.mockResolvedValue({
      data: { picks, entry_history: { bank: 10, value: 1003 } },
      freshness: null,
    });
    mocks.getEntryHistory.mockResolvedValue({ data: { chips: [], current: [], past: [] }, freshness: null });
    mocks.getEntryTransfers.mockResolvedValue({ data: [], freshness: null });
    mocks.getBootstrap.mockResolvedValue({ data: { elements: [] }, freshness: null });
    mocks.getPlayerSummary.mockResolvedValue({ data: { history: [], history_past: [] }, freshness: null });
  });

  /** Squad ids priced at market, with player 3 a riser from 45 to 47. */
  const squadIds = picks.map((pick) => pick.element);
  const marketPrices = squadIds.map((id) => ({ id, now_cost: id === 3 ? 47 : 50 }));

  it("imports and groups all 15 Gameweek 1 picks", async () => {
    const response = await GET(new Request("http://localhost/api/fpl/entry/4827193"), { params: Promise.resolve({ id: "4827193" }) });
    expect(response.status).toBe(200);
    expect(mocks.getEntry).toHaveBeenCalledWith(4827193);
    expect(mocks.getEntryPicks).toHaveBeenCalledWith(4827193, 1);
    await expect(response.json()).resolves.toMatchObject({ data: {
      teamName: "Test XI",
      managerName: "Test Manager",
      bankTenths: 10,
      budgetTenths: 1003,
      squad: { byPosition: { GK: [1, 2], DEF: [3, 4, 5, 6, 7], MID: [8, 9, 10, 11, 12], FWD: [13, 14, 15] } },
      lineup: { gameweek: 1, benchGoalkeeperId: 2, benchOrder: [6, 7, 15], captainId: 13, viceCaptainId: 14 },
    } });
  });

  it("imports picks for the requested gameweek", async () => {
    const response = await GET(new Request("http://localhost/api/fpl/entry/4827193?gameweek=7"), { params: Promise.resolve({ id: "4827193" }) });
    expect(response.status).toBe(200);
    expect(mocks.getEntryPicks).toHaveBeenCalledWith(4827193, 7);
    await expect(response.json()).resolves.toMatchObject({ data: { lineup: { gameweek: 7 } } });
  });

  it("imports the latest available picks when the app is planning the next gameweek", async () => {
    mocks.getEntry.mockResolvedValue({ data: { id: 4827193, current_event: 2 }, freshness: null });
    const response = await GET(new Request("http://localhost/api/fpl/entry/4827193?gameweek=3"), { params: Promise.resolve({ id: "4827193" }) });
    expect(response.status).toBe(200);
    expect(mocks.getEntryPicks).toHaveBeenCalledWith(4827193, 2);
    await expect(response.json()).resolves.toMatchObject({ data: { lineup: { gameweek: 2 } } });
  });

  it("imports the permanent squad when the current picks are a free hit", async () => {
    const fhPicks = picks.map((pick) => pick.element === 15 ? { ...pick, element: 30 } : pick);
    mocks.getEntryPicks.mockImplementation(async (entryId: number, gameweek: number) => {
      if (gameweek === 1) return { data: { picks, entry_history: { bank: 10, value: 1003 } }, freshness: null };
      return { data: { picks: fhPicks, active_chip: "freehit", entry_history: { bank: 5, value: 1005 } }, freshness: null };
    });
    mocks.getEntryHistory.mockResolvedValue({
      data: { chips: [{ name: "freehit", event: 2 }], current: [{ event: 1, bank: 10, value: 1003 }], past: [] },
      freshness: null,
    });
    const response = await GET(new Request("http://localhost/api/fpl/entry/4827193?gameweek=2"), { params: Promise.resolve({ id: "4827193" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: {
      freeHitImport: true,
      usedChips: [{ kind: "freehit", gameweek: 2 }],
      squad: { playerIds: expect.arrayContaining([15]) },
    } });
    const body = await (await GET(new Request("http://localhost/api/fpl/entry/4827193?gameweek=2"), { params: Promise.resolve({ id: "4827193" }) })).json();
    expect(body.data.squad.playerIds).not.toContain(30);
    expect(body.data.transferBaseline).toMatchObject({ financialConfidence: expect.any(String) });
  });

  it("rejects an invalid gameweek before fetching the entry", async () => {
    mocks.getEntry.mockClear();
    mocks.getEntryPicks.mockClear();
    const response = await GET(new Request("http://localhost/api/fpl/entry/4827193?gameweek=39"), { params: Promise.resolve({ id: "4827193" }) });
    expect(response.status).toBe(400);
    expect(mocks.getEntry).not.toHaveBeenCalled();
    expect(mocks.getEntryPicks).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs and incomplete squads", async () => {
    const invalidId = await GET(new Request("http://localhost/api/fpl/entry/nope"), { params: Promise.resolve({ id: "nope" }) });
    expect(invalidId.status).toBe(400);
    mocks.getEntryPicks.mockResolvedValue({ data: { picks: [] }, freshness: null });
    const incomplete = await GET(new Request("http://localhost/api/fpl/entry/1"), { params: Promise.resolve({ id: "1" }) });
    expect(incomplete.status).toBe(422);
  });

  describe("purchase prices", () => {
    beforeEach(() => {
      mocks.getBootstrap.mockResolvedValue({ data: { elements: marketPrices }, freshness: null });
    });

    const call = async () => {
      const response = await GET(
        new Request("http://localhost/api/fpl/entry/4827193"),
        { params: Promise.resolve({ id: "4827193" }) },
      );
      return (await response.json()).data;
    };

    it("reads opening prices for players never transferred in", async () => {
      // Player 3 was held since GW1 at 45 and is now 47. The purchase price is
      // 45, so the selling price is 46 — not today's 47.
      mocks.getPlayerSummary.mockImplementation(async (id: number) => ({
        data: { history: [{ round: 1, value: id === 3 ? 45 : 50 }], history_past: [] },
        freshness: null,
      }));

      const data = await call();

      expect(mocks.getPlayerSummary).toHaveBeenCalled();
      expect(data.transferBaseline.purchasePricesTenths[3]).toBe(45);
    });

    it("marks finances ESTIMATED when an opening price cannot be read", async () => {
      mocks.getPlayerSummary.mockResolvedValue({ data: { history: [], history_past: [] }, freshness: null });

      const data = await call();

      expect(data.financialConfidence).toBe("ESTIMATED");
      expect(data.transferBaseline.warnings.join(" ")).toContain("current price used");
    });

    it("earns EXACT when every price is verified and the checksum agrees", async () => {
      // 15 players held from GW1 at 50, none risen, plus £1.0m in the bank:
      // FPL's reported team value is 15 * 50 + 10 = 760.
      mocks.getBootstrap.mockResolvedValue({ data: { elements: squadIds.map((id) => ({ id, now_cost: 50 })) }, freshness: null });
      mocks.getEntryPicks.mockResolvedValue({ data: { picks, entry_history: { bank: 10, value: 760 } }, freshness: null });
      mocks.getPlayerSummary.mockResolvedValue({ data: { history: [{ round: 1, value: 50 }], history_past: [] }, freshness: null });

      const data = await call();

      expect(data.financialConfidence).toBe("EXACT");
    });

    it("downgrades when the checksum disagrees with the reported team value", async () => {
      // Prices verified, but FPL reports a value the reconstruction cannot reach.
      mocks.getBootstrap.mockResolvedValue({ data: { elements: squadIds.map((id) => ({ id, now_cost: 50 })) }, freshness: null });
      mocks.getEntryPicks.mockResolvedValue({ data: { picks, entry_history: { bank: 10, value: 999 } }, freshness: null });
      mocks.getPlayerSummary.mockResolvedValue({ data: { history: [{ round: 1, value: 50 }], history_past: [] }, freshness: null });

      const data = await call();

      expect(data.financialConfidence).toBe("ESTIMATED");
      expect(data.transferBaseline.warnings.join(" ")).toContain("FPL reports");
    });
  });
});
