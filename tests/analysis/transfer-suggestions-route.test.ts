import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Player, Position } from "@/types/player";

const mocks = vi.hoisted(() => ({
  bootstrapData: {} as unknown,
  normalized: {} as { players: Player[]; teams: never[]; fixtures: never[]; events: Array<{ id: number; isCurrent: boolean; isNext: boolean }> },
  find: vi.fn(),
}));

vi.mock("@/lib/fpl/client", () => ({
  getBootstrap: vi.fn(async () => mocks.bootstrapData ? { data: mocks.bootstrapData } : { data: null, error: "offline" }),
  getFixtures: vi.fn(async () => ({ data: [] })),
}));
vi.mock("@/lib/historical/load", () => ({ loadHistoricalBundle: vi.fn(async () => null) }));
vi.mock("@/lib/analysis/singleTransfers", () => ({ findBestSingleTransfers: mocks.find }));

function player(id: number, position: Position): Player {
  return {
    id,
    firstName: "P",
    lastName: String(id),
    displayName: `P${id}`,
    teamId: id,
    teamName: `T${id}`,
    teamShortName: `T${id}`,
    position,
    priceTenths: 50,
    ownership: 0,
    status: "a",
    current: { totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 90 },
    fixtures: [],
  };
}

const players = [
  player(1, "GK"), player(2, "GK"),
  player(3, "DEF"), player(4, "DEF"), player(5, "DEF"), player(6, "DEF"), player(7, "DEF"),
  player(8, "MID"), player(9, "MID"), player(10, "MID"), player(11, "MID"), player(12, "MID"),
  player(13, "FWD"), player(14, "FWD"), player(15, "FWD"),
];

vi.mock("@/lib/fpl/normalize", () => ({
  normalizeBootstrap: vi.fn(() => mocks.normalized),
  enrichBootstrapWithProjections: vi.fn((bootstrap) => ({ bootstrap, metadata: {} })),
  projectionCacheKey: vi.fn(() => "test-generation"),
}));

mocks.normalized = { players, teams: [], fixtures: [], events: [{ id: 3, isCurrent: true, isNext: false }] };

import { POST } from "@/app/api/transfer-suggestions/route";

describe("single-transfer route", () => {
  beforeEach(() => {
    mocks.bootstrapData = {};
    mocks.find.mockReset().mockReturnValue([{ outgoingPlayerId: 3, incomingPlayerId: 16 }]);
  });

  it("validates the request before searching", async () => {
    const response = await POST(new Request("http://localhost/api/transfer-suggestions", { method: "POST", body: "{}" }));
    expect(response.status).toBe(400);
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it("searches the current projected gameweek and returns five or fewer moves", async () => {
    const response = await POST(new Request("http://localhost/api/transfer-suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ squad: players.map((item) => item.id), lockedPlayerIds: [], budgetTenths: 750, horizon: 5, risk: "BALANCED" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ gameweek: 3, budgetTenths: 750, horizon: 5, risk: "BALANCED" }));
    await expect(response.json()).resolves.toMatchObject({ gameweek: 3, horizon: 5, suggestions: [{ outgoingPlayerId: 3, incomingPlayerId: 16 }] });
  });

  it("searches a requested gameweek", async () => {
    const response = await POST(new Request("http://localhost/api/transfer-suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ squad: players.map((item) => item.id), lockedPlayerIds: [], gameweek: 17, horizon: 1, risk: "SAFE" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ gameweek: 17, horizon: 1, risk: "SAFE" }));
    await expect(response.json()).resolves.toMatchObject({ gameweek: 17, horizon: 1 });
  });

  it("reports unavailable FPL data without searching", async () => {
    mocks.bootstrapData = null;
    const response = await POST(new Request("http://localhost/api/transfer-suggestions", {
      method: "POST",
      body: JSON.stringify({ squad: players.map((item) => item.id), lockedPlayerIds: [], horizon: 1, risk: "SAFE" }),
    }));
    expect(response.status).toBe(503);
    expect(mocks.find).not.toHaveBeenCalled();
  });
});
