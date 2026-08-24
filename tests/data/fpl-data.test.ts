import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getFreshness, readSnapshot, writeSnapshot } from "@/lib/fpl/cache";
import { enrichBootstrapWithProjections, normalizeBootstrap, normalizeLiveGameweek } from "@/lib/fpl/normalize";
import { FplBootstrapSchema, FplLiveResponseSchema } from "@/lib/fpl/schemas";
import { aggregateHistoricalPlayers, mapHistoricalPlayers, parseCsv } from "@/lib/historical/ingest";
import { deriveTeamStrengths } from "@/lib/historical/enrichPlayers";
import type { Player } from "@/types";
import type { HistoricalBundle } from "@/lib/historical/types";

describe("FPL data boundary", () => {
  it("maps the manual 1-5 consensus strength into projection ratios", () => {
    const payload = FplBootstrapSchema.parse({
      events: [],
      teams: [
        { id: 1, name: "Arsenal", short_name: "ARS", strength_overall_home: 1, strength_overall_away: 1 },
        { id: 11, name: "Hull City", short_name: "HUL", strength_overall_home: 5, strength_overall_away: 5 },
      ],
      element_types: [],
      elements: [],
    });
    const normalized = normalizeBootstrap(payload);
    expect(normalized.teams.map((team) => team.strength?.rating)).toEqual([5, 1]);

    const { strengths, fallbackCount } = deriveTeamStrengths(normalized.teams);
    expect(strengths[1]?.overall).toBeGreaterThan(strengths[11]?.overall ?? 0);
    expect(strengths[1]?.attackHome).toBeGreaterThan(strengths[11]?.defenceAway ?? 0);
    expect(fallbackCount).toBe(0);
  });

  it("gives attack and defence independent ratios for clubs with a manual split", () => {
    const payload = FplBootstrapSchema.parse({
      events: [],
      teams: [
        // Arsenal: attackStrength 5 > defenceStrength 4 in the manual file.
        { id: 1, name: "Arsenal", short_name: "ARS" },
        // Man City: defenceStrength 5 > attackStrength 4 in the manual file.
        { id: 2, name: "Manchester City", short_name: "MCI" },
      ],
      element_types: [],
      elements: [],
    });
    const normalized = normalizeBootstrap(payload);
    const { strengths } = deriveTeamStrengths(normalized.teams);

    expect(strengths[1]?.attackHome).toBeGreaterThan(strengths[1]?.defenceHome ?? 0);
    expect(strengths[2]?.defenceHome).toBeGreaterThan(strengths[2]?.attackHome ?? 0);
  });

  it("does not crush one team's ratio when consensus and raw-FPL fallback scales mix", () => {
    // A club missing from the manual consensus file falls back to raw FPL
    // strength fields, which run in the hundreds rather than the ~0.84-1.16
    // consensus band. Both groups must stay independently centred on 1.0
    // rather than being averaged into one pool.
    const { strengths } = deriveTeamStrengths([
      { id: 1, strength: { rating: 5 } },
      { id: 2, strength: { rating: 3 } },
      {
        id: 3,
        strength: {
          attackHome: 1050,
          attackAway: 1050,
          defenceHome: 1050,
          defenceAway: 1050,
          overallHome: 1050,
          overallAway: 1050,
        },
      },
    ]);

    for (const teamId of [1, 2, 3]) {
      expect(strengths[teamId]?.overall).toBeGreaterThan(0.5);
      expect(strengths[teamId]?.overall).toBeLessThan(1.5);
    }
  });

  it("parses quoted CSV fields without changing source values", () => {
    expect(parseCsv('name,note\n"Player, One","said ""ready"""\n')).toEqual([
      { name: "Player, One", note: 'said "ready"' },
    ]);
  });

  it("normalizes a validated bootstrap payload into domain players and fixtures", () => {
    const payload = FplBootstrapSchema.parse({
      events: [{ id: 1, name: "Gameweek 1", is_next: true, finished: false }],
      teams: [{ id: 1, name: "Test City", short_name: "TST" }, { id: 2, name: "Test United", short_name: "TUN" }],
      element_types: [{ id: 3, plural_name_short: "MID" }],
      elements: [{
        id: 10,
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
      }],
      total_players: 1,
    });
    const normalized = normalizeBootstrap(payload, [{
      id: 100,
      event: 1,
      team_h: 1,
      team_a: 2,
      kickoff_time: "2026-08-21T17:30:00Z",
      team_h_difficulty: 2,
      team_a_difficulty: 4,
    }]);
    expect(normalized.players[0]).toMatchObject({
      id: 10,
      position: "MID",
      priceTenths: 75,
      ownership: 12.4,
      teamShortName: "TST",
    });
    expect(normalized.players[0]?.fixtures[0]).toMatchObject({
      gameweek: 1,
      opponentTeamId: 2,
      opponentShortName: "TUN",
      isHome: true,
      difficulty: 2,
    });
    expect(normalized.players[0]?.current).toMatchObject({ minutes: 0, totalPoints: 0 });

    const started = normalizeBootstrap(payload, [{
      id: 100,
      event: 1,
      team_h: 1,
      team_a: 2,
      started: true,
    }]);
    expect(started.players[0]?.current).toMatchObject({ minutes: 900, totalPoints: 60 });
  });

  it("marks snapshot data stale while retaining its source timestamp", () => {
    const freshness = getFreshness(1_000, 300_000, "snapshot", 121_000);
    expect(freshness).toMatchObject({ source: "snapshot", ageSeconds: 120, stale: true });
    expect(freshness.fetchedAt).toBe("1970-01-01T00:00:01.000Z");
  });

  it("round-trips a last-success snapshot through the local cache", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fpl-snapshot-"));
    const previousDirectory = process.env.FPL_SNAPSHOT_DIR;
    process.env.FPL_SNAPSHOT_DIR = directory;
    try {
      await writeSnapshot("data-test", { players: 599 }, 1_000);
      await expect(readSnapshot("data-test", z.object({ players: z.number() }))).resolves.toEqual({
        data: { players: 599 },
        fetchedAt: 1_000,
      });
    } finally {
      if (previousDirectory === undefined) delete process.env.FPL_SNAPSHOT_DIR;
      else process.env.FPL_SNAPSHOT_DIR = previousDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aggregates historical match rows and maps by stable code first", () => {
    const historical = aggregateHistoricalPlayers(
      [
        "name,position,team,element,minutes,starts,total_points,goals_scored,assists,clean_sheets,bonus,bps,expected_goals,expected_assists,defensive_contribution,GW,fixture,opponent_team,was_home",
        "Player,MID,Test City,10,90,1,8,1,1,0,1,20,0.30,0.20,4,1,50,2,True",
        "Player,MID,Test City,10,45,0,2,0,0,0,0,4,0.00,0.10,1,2,51,3,False",
      ].join("\n"),
      "id,code,web_name\n10,100,Player\n",
    );
    const current = {
      id: 99,
      code: 100,
      firstName: "Player",
      lastName: "One",
      displayName: "Player",
      teamId: 7,
      teamName: "Test City",
      teamShortName: "TST",
      position: "MID",
      priceTenths: 75,
      ownership: 1,
      status: "a",
      current: { totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 0 },
      fixtures: [],
    } satisfies Player;
    expect(historical[0]?.stats).toMatchObject({ minutes: 135, totalPoints: 10, goals: 1, assists: 1 });
    expect(mapHistoricalPlayers([current], historical)).toEqual([
      { currentPlayerId: 99, historicalPlayerId: 10, confidence: "EXACT" },
    ]);
  });

  it("normalizes live event stats without inventing missing elements", () => {
    const payload = FplLiveResponseSchema.parse({
      elements: [{ id: 10, stats: { minutes: 90, total_points: 8 }, explain: [] }],
    });
    expect(normalizeLiveGameweek(1, payload)).toEqual({
      gameweek: 1,
      elements: [{ playerId: 10, stats: { minutes: 90, total_points: 8 }, explain: [] }],
    });
  });

  it("enriches a live-shaped bootstrap with mapped history and finite projections", async () => {
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
    const normalized = normalizeBootstrap(payload, [{
      id: 100,
      event: 1,
      team_h: 1,
      team_a: 2,
      team_h_difficulty: 2,
      team_a_difficulty: 4,
    }]);
    const historicalStats = {
      season: "2025/26",
      minutes: 1_800,
      starts: 20,
      totalPoints: 140,
      goals: 12,
      assists: 10,
      cleanSheets: 8,
      bonus: 15,
      expectedGoals: 8,
      expectedAssists: 7,
      pointsPer90: 7,
      xGIPer90: 0.75,
    };
    const historical: HistoricalBundle = {
      sourceSeason: "2025/26",
      players: [{ historicalPlayerId: 10, code: 100, displayName: "Player", stats: historicalStats }],
      matchStats: [],
      teamStrength: [],
      playerMappings: [{ currentPlayerId: 10, historicalPlayerId: 10, confidence: "EXACT" }],
    };
    const enriched = await enrichBootstrapWithProjections(normalized, historical);
    const player = enriched.bootstrap.players[0];
    expect(player?.historical).toEqual(historicalStats);
    expect(enriched.metadata.historical.mappedPlayers).toBe(1);
    expect(enriched.metadata.projectionsAttached).toBe(1);
    expect(player?.projection).toMatchObject({ playerId: 10 });
    for (const value of [player?.projection?.nextGW, player?.projection?.next3, player?.projection?.next5, player?.projection?.valueNext5, player?.projection?.riskScore]) {
      expect(value).toEqual(expect.any(Number));
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(player?.projection?.nextGW).toBeGreaterThan(0);
    expect(player?.projection?.next5).toBeGreaterThan(0);

    const withoutHistory = await enrichBootstrapWithProjections(normalized, null);
    expect(withoutHistory.metadata.historical.available).toBe(false);
    expect(withoutHistory.bootstrap.players[0]?.projection?.next5).toBeGreaterThan(0);
  });
});
