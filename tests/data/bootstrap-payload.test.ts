import { describe, expect, it } from "vitest";
import { enrichBootstrapWithProjections, normalizeBootstrap } from "@/lib/fpl/normalize";
import { FplBootstrapSchema } from "@/lib/fpl/schemas";
import { projectPlayer } from "@/lib/projections/projectPlayer";
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
      id: 10, code: 100, first_name: "Test", second_name: "Player", web_name: "Player",
      team: 1, element_type: 3, now_cost: 75, selected_by_percent: "12.4", status: "a",
      chance_of_playing_next_round: null, minutes: 900, total_points: 60, goals_scored: 4,
      assists: 3, clean_sheets: 2, bonus: 5, expected_goals: "0.5", expected_assists: "0.4",
    }],
    total_players: 1,
  });
  return normalizeBootstrap(payload, [
    { id: 100, event: 1, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
    { id: 101, event: 2, team_h: 2, team_a: 1, team_h_difficulty: 3, team_a_difficulty: 3 },
  ]);
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

describe("bootstrap payload weight", () => {
  it("drops the per-fixture component breakdown, which only the aggregation reads", async () => {
    const enriched = await enrichBootstrapWithProjections(normalized(), HISTORICAL);
    const projection = enriched.bootstrap.players[0]?.projection;
    const fixtures = projection?.fixtures ?? [];

    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      expect(fixture.components).toBeUndefined();
    }
  });

  it("keeps everything the breakdown fed into", async () => {
    const enriched = await enrichBootstrapWithProjections(normalized(), HISTORICAL);
    const projection = enriched.bootstrap.players[0]?.projection;

    // The player-level aggregate is built from the per-fixture components, so
    // it stands as proof they were computed before being dropped.
    expect(projection?.components?.total).toBeGreaterThan(0);
    expect(projection?.fixtures[0]?.expectedPoints).toBeGreaterThan(0);
    expect(projection?.fixtures[0]?.expectedMinutes).toBeGreaterThan(0);
    expect(projection?.fixtures[0]?.fixture).toBeDefined();
    expect(projection?.next5).toBeGreaterThan(0);
  });

  it("still exposes the breakdown to server-side callers of projectPlayer", () => {
    // Backtests and the projection tests read this; only the wire drops it.
    const player = normalized().players[0]!;
    const projection = projectPlayer(player, { horizon: 5, currentGameweek: 1 });

    expect(projection.fixtures[0]?.components).toBeDefined();
    expect(projection.fixtures[0]?.components?.appearance).toEqual(expect.any(Number));
  });
});
