import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { clearFplCache } from "@/lib/fpl/cache";
import { getEntryPicks } from "@/lib/fpl/client";

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

describe("FPL client request headers", () => {
  beforeEach(() => {
    clearFplCache();
    fetchMock.mockReset();
  });

  it("sends the JSON Accept and descriptive User-Agent headers", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      picks: [{ element: 7, position: 1, element_type: 1, multiplier: 1 }],
    }));

    const result = await getEntryPicks(123, 7, { persistSnapshot: false });

    expect(result.data?.picks[0]?.element).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Accept: "application/json",
        "User-Agent": "FPL-Terminal/0.1 (+https://github.com/joel1050/fpl-terminal)",
      },
      cache: "no-store",
    });
  });
});
