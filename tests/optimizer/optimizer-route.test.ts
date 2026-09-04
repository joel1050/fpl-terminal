import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Player, Position } from "@/types/player";

const mocks = vi.hoisted(() => ({
  bootstrapData: {} as unknown,
  normalized: {} as { players: Player[]; teams: never[]; fixtures: never[]; events: Array<{ id: number; isCurrent: boolean; isNext: boolean }> },
  optimize: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("@/lib/fpl/client", () => ({
  getBootstrap: vi.fn(async () => mocks.bootstrapData ? { data: mocks.bootstrapData } : { data: null, error: "offline" }),
  getFixtures: vi.fn(async () => ({ data: [] })),
}));
vi.mock("@/lib/historical/load", () => ({ loadHistoricalBundle: vi.fn(async () => null) }));
vi.mock("@/lib/historical/loadInSeasonForm", () => ({
  loadInSeasonTeamXG: vi.fn(async () => ({})),
  loadInSeasonPlayerRates: vi.fn(async () => ({})),
  loadInSeasonStarts: vi.fn(async () => ({})),
}));
vi.mock("@/lib/historical/enrichPlayers", () => ({
  enrichPlayersWithHistory: vi.fn((players: Player[]) => ({ players })),
}));
vi.mock("@/lib/optimizer/exactOptimizer", () => ({
  exactOptimizeFullSquad: mocks.optimize,
  exactCompletePartialSquad: mocks.complete,
}));

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

vi.mock("@/lib/fpl/normalize", () => ({ normalizeBootstrap: vi.fn(() => mocks.normalized) }));

mocks.normalized = { players, teams: [], fixtures: [], events: [{ id: 3, isCurrent: true, isNext: false }] };

import { POST } from "@/app/api/optimizer/route";

const body = (extra: Record<string, unknown>) => JSON.stringify({
  mode: "OPTIMIZE",
  squad: players.map((item) => item.id),
  lockedPlayerIds: [],
  horizon: 1,
  bench: "CHEAP",
  ...extra,
});

function post(payload: string) {
  return POST(new Request("http://localhost/api/optimizer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  }));
}

describe("optimizer route", () => {
  beforeEach(() => {
    mocks.bootstrapData = {};
    mocks.optimize.mockReset().mockResolvedValue({ legal: true, playerIds: [], errors: [], warnings: [] });
    mocks.complete.mockReset().mockResolvedValue({ legal: true, playerIds: [], errors: [], warnings: [] });
  });

  it("optimizes the requested planning gameweek", async () => {
    const response = await post(body({ gameweek: 7 }));
    expect(response.status).toBe(200);
    expect(mocks.optimize).toHaveBeenCalledWith(expect.objectContaining({ gameweek: 7, horizon: 1, bench: "CHEAP" }));
    expect(mocks.optimize.mock.calls[0][0]).not.toHaveProperty("risk");
  });

  it("falls back to the current gameweek when none is requested", async () => {
    const response = await post(body({}));
    expect(response.status).toBe(200);
    expect(mocks.optimize).toHaveBeenCalledWith(expect.objectContaining({ gameweek: 3 }));
  });

  it("falls back to the next gameweek between gameweeks", async () => {
    mocks.normalized = { ...mocks.normalized, events: [{ id: 9, isCurrent: false, isNext: true }] };
    await post(body({}));
    expect(mocks.optimize).toHaveBeenCalledWith(expect.objectContaining({ gameweek: 9 }));
    mocks.normalized = { ...mocks.normalized, events: [{ id: 3, isCurrent: true, isNext: false }] };
  });

  it("rejects a gameweek outside the season", async () => {
    const response = await post(body({ gameweek: 39 }));
    expect(response.status).toBe(400);
    expect(mocks.optimize).not.toHaveBeenCalled();
  });

  it("rejects the retired risk option", async () => {
    const response = await post(body({ risk: "SAFE" }));
    expect(response.status).toBe(400);
    expect(mocks.optimize).not.toHaveBeenCalled();
  });

  it("accepts planning-week bank and purchase ledger in the transfer-suggestion style", async () => {
    await post(body({ bankTenths: 12, purchasePricesTenths: { 1: 50 } }));
    expect(mocks.optimize).toHaveBeenCalledWith(expect.objectContaining({
      bankTenths: 12,
      purchasePricesTenths: { 1: 50 },
    }));
  });

  it("rejects a purchase price for a player outside the submitted squad", async () => {
    const response = await post(body({ purchasePricesTenths: { 999: 50 } }));
    expect(response.status).toBe(400);
    expect(mocks.optimize).not.toHaveBeenCalled();
  });

  it("rejects more than fifteen purchase prices or negative values", async () => {
    const tooMany = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [index + 1, 50]));
    const negative = await post(body({ purchasePricesTenths: { 1: -5 } }));
    const oversized = await post(body({ purchasePricesTenths: tooMany }));
    expect(negative.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(mocks.optimize).not.toHaveBeenCalled();
  });

  it("passes the planning gameweek through the COMPLETE mode too", async () => {
    await post(body({ mode: "COMPLETE", squad: players.slice(0, 9).map((item) => item.id), gameweek: 12 }));
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ gameweek: 12 }));
    expect(mocks.optimize).not.toHaveBeenCalled();
  });
});
