import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

import { clearFplCache } from "@/lib/fpl/cache";
import { getClassicLeagueStandings, getEntryHistory, getEntryPicks } from "@/lib/fpl/client";

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

describe("dynamic FPL endpoints", () => {
  beforeEach(() => {
    clearFplCache();
    fetchMock.mockReset();
  });

  it("builds the picks path from the entry id and requested gameweek", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      picks: [{ element: 7, position: 1, element_type: 1, multiplier: 1 }],
    }));
    const result = await getEntryPicks(123, 7);
    expect(result.data?.picks[0]?.element).toBe(7);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/entry/123/event/7/picks/");
    expect(url).not.toContain("event/1/");
  });

  it("never assumes Gameweek 1 for later gameweeks", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ picks: [] }));
    await getEntryPicks(999, 26);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("entry/999/event/26/picks/");
    expect(url).not.toMatch(/event\/1\//);
  });

  it("caches picks per entry and gameweek combination", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ picks: [] }));
    await getEntryPicks(123, 7);
    await getEntryPicks(123, 7);
    await getEntryPicks(123, 8);
    await getEntryPicks(124, 7);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid gameweeks without hitting the network", async () => {
    const result = await getEntryPicks(123, 39);
    expect(result.data).toBeNull();
    expect(result.error).toContain("Gameweek");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches manager history from its own endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ chips: [], current: [], past: [] }));
    await getEntryHistory(55, { persistSnapshot: false });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/entry/55/history/");
  });

  it("requests classic standings pages through page_standings", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      league: { id: 77 },
      standings: { page: 2, has_next: false, results: [{ entry: 9, entry_name: "FC", total: 1000 }] },
    }));
    const result = await getClassicLeagueStandings(77, 2, { persistSnapshot: false });
    expect(result.data?.standings.results).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("leagues-classic/77/standings/?page_standings=2");
  });
});
