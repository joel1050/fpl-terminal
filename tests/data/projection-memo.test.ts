import { describe, expect, it } from "vitest";
import { getFreshness } from "@/lib/fpl/cache";
import {
  enrichBootstrapWithProjections,
  normalizeBootstrap,
  projectionCacheKey,
} from "@/lib/fpl/normalize";
import { FplBootstrapSchema } from "@/lib/fpl/schemas";
import type { HistoricalBundle } from "@/lib/historical/types";

function normalized() {
  const payload = FplBootstrapSchema.parse({
    events: [{ id: 1, name: "Gameweek 1", is_next: true, finished: false }],
    teams: [
      { id: 1, name: "Test City", short_name: "TST", strength_overall_home: 5, strength_overall_away: 5 },
      { id: 2, name: "Test United", short_name: "TUN", strength_overall_home: 3, strength_overall_away: 3 },
    ],
    element_types: [{ id: 3, plural_name_short: "MID" }],
    elements: [{
      id: 10,
      code: 100,
      first_name: "Test",
      second_name: "Player",
      web_name: "Player",
      team: 1,
      element_type: 3,
      now_cost: 75,
      selected_by_percent: "12.4",
      status: "a",
      chance_of_playing_next_round: null,
      minutes: 900,
      total_points: 60,
      goals_scored: 4,
      assists: 3,
      clean_sheets: 2,
      bonus: 5,
      expected_goals: "0.5",
      expected_assists: "0.4",
    }],
    total_players: 1,
  });
  return normalizeBootstrap(payload, [{
    id: 100,
    event: 1,
    team_h: 1,
    team_a: 2,
    team_h_difficulty: 2,
    team_a_difficulty: 4,
  }]);
}

const HISTORICAL: HistoricalBundle = {
  sourceSeason: "2025/26",
  players: [{
    historicalPlayerId: 10,
    code: 100,
    displayName: "Player",
    stats: { season: "2025/26", minutes: 1_800, starts: 20, totalPoints: 140, goals: 12, assists: 10, pointsPer90: 7 },
  }],
  matchStats: [],
  teamStrength: [],
  playerMappings: [{ currentPlayerId: 10, historicalPlayerId: 10, confidence: "EXACT" }],
};

const at = (iso: string) => getFreshness(Date.parse(iso), 300_000);

describe("projectionCacheKey", () => {
  it("is null when either freshness is unknown", () => {
    const known = at("2026-09-02T12:00:00Z");
    expect(projectionCacheKey(null, known)).toBeNull();
    expect(projectionCacheKey(known, null)).toBeNull();
    expect(projectionCacheKey(null, null)).toBeNull();
  });

  it("changes when the bootstrap is refetched", () => {
    const fixtures = at("2026-09-02T12:00:00Z");
    const first = projectionCacheKey(at("2026-09-02T12:00:00Z"), fixtures);
    const later = projectionCacheKey(at("2026-09-02T12:05:00Z"), fixtures);
    expect(first).not.toBeNull();
    expect(later).not.toBe(first);
  });

  it("changes when the fixtures are refetched", () => {
    const bootstrap = at("2026-09-02T12:00:00Z");
    const first = projectionCacheKey(bootstrap, at("2026-09-02T12:00:00Z"));
    const later = projectionCacheKey(bootstrap, at("2026-09-02T12:15:00Z"));
    expect(later).not.toBe(first);
  });
});

describe("enrichBootstrapWithProjections caching", () => {
  it("reuses the projections computed for the same data generation", async () => {
    const key = "gen-1";
    const first = await enrichBootstrapWithProjections(normalized(), HISTORICAL, { cacheKey: key });
    const second = await enrichBootstrapWithProjections(normalized(), HISTORICAL, { cacheKey: key });

    expect(second.bootstrap).toBe(first.bootstrap);
  });

  it("recomputes once the data generation moves on", async () => {
    const first = await enrichBootstrapWithProjections(normalized(), HISTORICAL, { cacheKey: "gen-1" });
    const second = await enrichBootstrapWithProjections(normalized(), HISTORICAL, { cacheKey: "gen-2" });

    expect(second.bootstrap).not.toBe(first.bootstrap);
    expect(second.bootstrap.players[0]?.projection?.next5).toBeGreaterThan(0);
  });

  it("recomputes when the caller forces a refresh", async () => {
    const key = "gen-forced";
    const first = await enrichBootstrapWithProjections(normalized(), HISTORICAL, { cacheKey: key });
    const forced = await enrichBootstrapWithProjections(normalized(), HISTORICAL, {
      cacheKey: key,
      forceRefresh: true,
    });

    expect(forced.bootstrap).not.toBe(first.bootstrap);
  });

  it("never caches when the caller supplies no key", async () => {
    // `?refresh=1` aside, a caller that cannot say which generation it holds
    // must not be served another caller's projections.
    const bootstrap = normalized();
    const withHistory = await enrichBootstrapWithProjections(bootstrap, HISTORICAL);
    const withoutHistory = await enrichBootstrapWithProjections(bootstrap, null);

    expect(withHistory.metadata.historical.available).toBe(true);
    expect(withoutHistory.metadata.historical.available).toBe(false);
  });
});
