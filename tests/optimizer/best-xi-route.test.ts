import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Player, Position } from "@/types/player";

const mocks = vi.hoisted(() => ({
  bootstrapData: {} as unknown,
  normalized: {} as { players: Player[]; teams: never[]; fixtures: never[]; events: Array<{ id: number; isCurrent: boolean; isNext: boolean }> },
  solve: vi.fn(),
}));

vi.mock("@/lib/fpl/client", () => ({
  getBootstrap: vi.fn(async () => mocks.bootstrapData ? { data: mocks.bootstrapData } : { data: null, error: "offline" }),
  getFixtures: vi.fn(async () => ({ data: [] })),
}));
vi.mock("@/lib/historical/load", () => ({ loadHistoricalBundle: vi.fn(async () => null) }));
vi.mock("@/lib/optimizer/bestPossibleXI", () => ({ exactBestPossibleXI: mocks.solve }));

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

import { POST } from "@/app/api/best-xi/route";

const request = (body: unknown) => new Request("http://localhost/api/best-xi", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("best possible XI route", () => {
  beforeEach(() => {
    mocks.bootstrapData = {};
    mocks.solve.mockReset().mockResolvedValue({
      legal: true,
      playerIds: players.slice(1).map((item) => item.id),
      costTenths: 500,
      projectedXI: 60,
      captainId: 13,
      captainBonus: 6,
      projectedTotal: 66,
      solver: "HIGHS",
      errors: [],
    });
  });

  it("rejects an unknown request field before solving", async () => {
    const response = await POST(request({ gameweek: 4, squad: [] }));
    expect(response.status).toBe(400);
    expect(mocks.solve).not.toHaveBeenCalled();
  });

  it("solves the current projected gameweek when none is requested", async () => {
    const response = await POST(request({ budgetTenths: 800 }));
    expect(response.status).toBe(200);
    expect(mocks.solve).toHaveBeenCalledWith(expect.objectContaining({ gameweek: 3, budgetTenths: 800 }));
    await expect(response.json()).resolves.toMatchObject({ gameweek: 3, budgetTenths: 800, projectedXI: 60, projectedTotal: 66 });
  });

  it("solves a requested planning gameweek", async () => {
    const response = await POST(request({ gameweek: 12 }));
    expect(response.status).toBe(200);
    expect(mocks.solve).toHaveBeenCalledWith(expect.objectContaining({ gameweek: 12, budgetTenths: 1000 }));
    await expect(response.json()).resolves.toMatchObject({ gameweek: 12 });
  });

  it("passes an illegal solver result back as an unprocessable request", async () => {
    mocks.solve.mockResolvedValue({ legal: false, playerIds: [], costTenths: 0, projectedXI: 0, captainId: 0, captainBonus: 0, projectedTotal: 0, errors: ["No XI."] });
    const response = await POST(request({ gameweek: 5 }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "No XI." });
  });

  it("reports unavailable FPL data without solving", async () => {
    mocks.bootstrapData = null;
    const response = await POST(request({ gameweek: 5 }));
    expect(response.status).toBe(503);
    expect(mocks.solve).not.toHaveBeenCalled();
  });
});
