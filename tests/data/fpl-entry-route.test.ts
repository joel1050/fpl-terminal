import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEntry: vi.fn(),
  getEntryPicks: vi.fn(),
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
      data: { picks },
      freshness: null,
    });
  });

  it("imports and groups all 15 Gameweek 1 picks", async () => {
    const response = await GET(new Request("http://localhost/api/fpl/entry/4827193"), { params: Promise.resolve({ id: "4827193" }) });
    expect(response.status).toBe(200);
    expect(mocks.getEntry).toHaveBeenCalledWith(4827193);
    expect(mocks.getEntryPicks).toHaveBeenCalledWith(4827193);
    await expect(response.json()).resolves.toMatchObject({ data: {
      teamName: "Test XI",
      managerName: "Test Manager",
      squad: { byPosition: { GK: [1, 2], DEF: [3, 4, 5, 6, 7], MID: [8, 9, 10, 11, 12], FWD: [13, 14, 15] } },
      lineup: { gameweek: 1, benchGoalkeeperId: 2, benchOrder: [6, 7, 15], captainId: 13, viceCaptainId: 14 },
    } });
  });

  it("rejects malformed IDs and incomplete squads", async () => {
    const invalidId = await GET(new Request("http://localhost/api/fpl/entry/nope"), { params: Promise.resolve({ id: "nope" }) });
    expect(invalidId.status).toBe(400);
    mocks.getEntryPicks.mockResolvedValue({ data: { picks: [] }, freshness: null });
    const incomplete = await GET(new Request("http://localhost/api/fpl/entry/1"), { params: Promise.resolve({ id: "1" }) });
    expect(incomplete.status).toBe(422);
  });
});
