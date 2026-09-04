import { describe, expect, it } from "vitest";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { enrichPlayersWithHistory } from "@/lib/historical/enrichPlayers";
import { weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import type { FplBootstrapPayload, FplFixturePayload } from "@/lib/fpl/schemas";

describe("live gameweek expected points for unplayed players", () => {
  it("retains live gameweek fixtures in projection when planning moves to next gameweek", () => {
    // GW3 is active with one started fixture, so currentGameweek advances to GW4
    const events = [
      { id: 1, name: "Gameweek 1", finished: true, is_current: false, is_next: false },
      { id: 2, name: "Gameweek 2", finished: true, is_current: false, is_next: false },
      { id: 3, name: "Gameweek 3", finished: false, is_current: true, is_next: false },
      { id: 4, name: "Gameweek 4", finished: false, is_current: false, is_next: true },
    ];

    const teams = [
      { id: 1, name: "Arsenal", short_name: "ARS" },
      { id: 2, name: "Aston Villa", short_name: "AVL" },
      { id: 3, name: "Chelsea", short_name: "CHE" },
      { id: 4, name: "Everton", short_name: "EVE" },
    ];

    const elements = [
      {
        id: 10,
        web_name: "Saka",
        first_name: "Bukayo",
        second_name: "Saka",
        team: 1,
        element_type: 3, // MID
        now_cost: 100,
        selected_by_percent: "25.0",
        status: "a",
        total_points: 15,
        minutes: 180,
        goals_scored: 1,
        assists: 1,
      },
    ];

    const fixturesPayload: FplFixturePayload = [
      // GW3 fixture that has started
      { id: 301, event: 3, team_h: 3, team_a: 4, started: true, finished: false },
      // GW3 fixture for Saka that has NOT started yet
      { id: 302, event: 3, team_h: 1, team_a: 2, started: false, finished: false },
      // GW4 fixture for Saka
      { id: 401, event: 4, team_h: 2, team_a: 1, started: false, finished: false },
    ];

    const bootstrapPayload = {
      events,
      teams,
      elements,
      total_players: 10000000,
    } as unknown as FplBootstrapPayload;

    const normalized = normalizeBootstrap(bootstrapPayload, fixturesPayload);

    // Planner moves to GW4 because GW3 fixtures have kicked off
    expect(normalized.currentGameweek).toBe(4);
    // Live gameweek remains GW3
    expect(normalized.liveGameweek).toBe(3);

    const enriched = enrichPlayersWithHistory(
      normalized.players,
      normalized.teams,
      normalized.events,
      null,
      undefined,
      undefined,
      undefined,
      normalized.liveGameweek,
    );

    const saka = enriched.players.find((p) => p.id === 10)!;
    expect(saka).toBeDefined();

    // Saka should have fixture projections for BOTH live GW3 and planning GW4
    const gw3Fixture = saka.projection?.fixtures.find((f) => f.gameweek === 3);
    const gw4Fixture = saka.projection?.fixtures.find((f) => f.gameweek === 4);
    expect(gw3Fixture).toBeDefined();
    expect(gw4Fixture).toBeDefined();

    // In GW3, before his match starts, xP must be > 0 (not 0.0)
    const liveMetrics = weeklyPlayerMetrics(saka, 3);
    expect(liveMetrics.points).toBeGreaterThan(0);
    expect(gw3Fixture!.expectedPoints).toBeGreaterThan(0);

    // Planning metrics nextGW must still target the upcoming deadline (GW4)
    expect(saka.projection?.nextGW).toBe(gw4Fixture!.expectedPoints);
  });
});
