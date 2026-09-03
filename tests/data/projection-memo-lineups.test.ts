import { describe, expect, it, vi } from "vitest";
import type { RotowireRefreshResult } from "@/lib/availability/refreshLineups";

const mocks = vi.hoisted(() => ({ ensureFreshRotowireLineups: vi.fn() }));
vi.mock("@/lib/availability/refreshLineups", () => ({
  ensureFreshRotowireLineups: mocks.ensureFreshRotowireLineups,
}));

const { enrichBootstrapWithProjections, normalizeBootstrap } = await import("@/lib/fpl/normalize");
const { FplBootstrapSchema } = await import("@/lib/fpl/schemas");

function normalized() {
  const payload = FplBootstrapSchema.parse({
    events: [{ id: 1, name: "Gameweek 1", is_next: true, finished: false }],
    teams: [
      { id: 1, name: "Test City", short_name: "TST" },
      { id: 2, name: "Test United", short_name: "TUN" },
    ],
    element_types: [{ id: 3, plural_name_short: "MID" }],
    elements: [{
      id: 10, code: 100, first_name: "Test", second_name: "Player", web_name: "Player",
      team: 1, element_type: 3, now_cost: 75, status: "a", minutes: 900, total_points: 60,
    }],
    total_players: 1,
  });
  return normalizeBootstrap(payload, [{ id: 100, event: 1, team_h: 1, team_a: 2 }]);
}

/** Same snapshot, checked again later: the key holds, the age does not. */
const checkedAt = (ageSeconds: number): RotowireRefreshResult => ({
  refreshed: false,
  reason: "fresh",
  fetchedAt: "2026-09-01T00:00:00Z",
  ageSeconds,
});

describe("lineup freshness on a cache hit", () => {
  it("reports the current lineup check, not the one the cache was filled with", async () => {
    mocks.ensureFreshRotowireLineups.mockResolvedValueOnce(checkedAt(3_600));
    const first = await enrichBootstrapWithProjections(normalized(), null, { cacheKey: "gen-1" });
    expect(first.metadata.lineups?.ageSeconds).toBe(3_600);

    mocks.ensureFreshRotowireLineups.mockResolvedValueOnce(checkedAt(7_200));
    const second = await enrichBootstrapWithProjections(normalized(), null, { cacheKey: "gen-1" });

    // Still a cache hit — the expensive part was not recomputed...
    expect(second.bootstrap).toBe(first.bootstrap);
    // ...but the snapshot is an hour older than it was, and says so.
    expect(second.metadata.lineups?.ageSeconds).toBe(7_200);
  });
});
