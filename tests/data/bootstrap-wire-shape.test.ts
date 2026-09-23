import { describe, expect, it } from "vitest";
import { normalizeBootstrap as parseBootstrap } from "@/components/terminal/TerminalApp";
import { enrichBootstrapWithProjections, normalizeBootstrap, toWireBootstrap } from "@/lib/fpl/normalize";
import { FplBootstrapSchema } from "@/lib/fpl/schemas";
import { weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import type { NormalizedBootstrap } from "@/lib/fpl/normalize";
import type { Player } from "@/types/player";

function element(id: number, team: number, name: string) {
  return {
    id, code: id * 10, first_name: "Test", second_name: name, web_name: name,
    team, element_type: 3, now_cost: 75, selected_by_percent: "12.4", status: "a",
    chance_of_playing_next_round: null, minutes: 900, total_points: 60, goals_scored: 4,
    assists: 3, clean_sheets: 2, bonus: 5, expected_goals: "0.5", expected_assists: "0.4",
  };
}

/** Two teams, two players each, and a double gameweek for team 1 in Gameweek 2. */
function normalized(): NormalizedBootstrap {
  const payload = FplBootstrapSchema.parse({
    events: [
      { id: 1, name: "Gameweek 1", is_current: true, finished: false },
      { id: 2, name: "Gameweek 2", is_next: true, finished: false },
    ],
    teams: [
      { id: 1, name: "Test City", short_name: "TST", strength_overall_home: 5, strength_overall_away: 5 },
      { id: 2, name: "Test United", short_name: "TUN", strength_overall_home: 3, strength_overall_away: 3 },
      { id: 3, name: "Test Rovers", short_name: "TRV", strength_overall_home: 4, strength_overall_away: 4 },
    ],
    element_types: [{ id: 3, plural_name_short: "MID" }],
    elements: [element(10, 1, "One"), element(11, 1, "Two"), element(20, 2, "Three")],
    total_players: 3,
  });
  return normalizeBootstrap(payload, [
    { id: 100, event: 1, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
    // Gameweek 2 is a double for team 1: two fixtures, two different opponents.
    { id: 101, event: 2, team_h: 2, team_a: 1, team_h_difficulty: 3, team_a_difficulty: 3 },
    { id: 102, event: 2, team_h: 1, team_a: 3, team_h_difficulty: 2, team_a_difficulty: 5 },
  ]);
}

describe("bootstrap wire shape", () => {
  it("sends each team's schedule once instead of once per player", async () => {
    const enriched = await enrichBootstrapWithProjections(normalized(), null);
    const wire = toWireBootstrap(enriched.bootstrap);

    expect(Object.keys(wire.teamFixtures)).toEqual(["1", "2"]);
    expect(wire.teamFixtures[1]).toEqual(enriched.bootstrap.players.find((player) => player.teamId === 1)!.fixtures);
    for (const player of wire.players) {
      expect(player).not.toHaveProperty("fixtures");
    }
  });

  it("replaces each projection entry's fixture with the id that finds it", async () => {
    const enriched = await enrichBootstrapWithProjections(normalized(), null);
    const wire = toWireBootstrap(enriched.bootstrap);
    const entries = wire.players[0]!.projection!.fixtures;
    const ids = new Set(wire.teamFixtures[1]!.map((fixture) => fixture.fixtureId));

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("fixture");
      expect(ids.has(entry.fixtureId)).toBe(true);
    }
  });

  it("leaves the full shape to server-side callers", async () => {
    // best-xi, the optimizer and the transfer search read these in process.
    const enriched = await enrichBootstrapWithProjections(normalized(), null);
    const player = enriched.bootstrap.players[0]!;

    expect(player.fixtures.length).toBeGreaterThan(0);
    expect(player.projection!.fixtures[0]!.fixture).toBeDefined();
  });

  it("rebuilds the trimmed fields in the browser, double gameweek included", async () => {
    const enriched = await enrichBootstrapWithProjections(normalized(), null);
    const before = enriched.bootstrap.players.find((player) => player.teamId === 1)!;
    const wire = JSON.parse(JSON.stringify({ data: toWireBootstrap(enriched.bootstrap) }));

    const after = parseBootstrap(wire).players.find((player) => player.id === before.id)!;

    expect(after.fixtures.map((fixture) => fixture.fixtureId)).toEqual(before.fixtures.map((fixture) => fixture.fixtureId));
    expect(after.fixtures.map((fixture) => fixture.opponentShortName)).toEqual(before.fixtures.map((fixture) => fixture.opponentShortName));

    const doubleGameweek = after.projection.fixtures.filter((entry) => entry.gameweek === 2);
    expect(doubleGameweek).toHaveLength(2);
    // Both entries sit in Gameweek 2, so only the id tells them apart. Matching
    // on gameweek alone would give both rows the same opponent.
    expect(doubleGameweek.map((entry) => entry.fixture.opponentShortName).sort()).toEqual(["TRV", "TUN"]);
    for (const entry of after.projection.fixtures) {
      const expected = before.projection!.fixtures.find((row) => row.fixture.fixtureId === entry.fixture.fixtureId)!;
      expect(entry.fixture.opponentShortName).toBe(expected.fixture.opponentShortName);
      expect(entry.fixture.isHome).toBe(expected.fixture.isHome);
      expect(entry.expectedPoints).toBeCloseTo(expected.expectedPoints, 6);
    }
  });

  it("scores a wire player exactly as a full one, which is what the leagues page reads", async () => {
    // `useLeaguesData` takes the bootstrap players as they arrive and scores
    // them with `weeklyPlayerMetrics`; it has no parser of its own to put the
    // trimmed fields back. That works only while the weekly numbers depend on
    // nothing the wire drops.
    const enriched = await enrichBootstrapWithProjections(normalized(), null);
    const wire = JSON.parse(JSON.stringify(toWireBootstrap(enriched.bootstrap))) as { players: Player[] };

    for (const [index, player] of enriched.bootstrap.players.entries()) {
      for (const gameweek of [1, 2, 3]) {
        expect(weeklyPlayerMetrics(wire.players[index]!, gameweek)).toEqual(weeklyPlayerMetrics(player, gameweek));
      }
    }
  });

  it("keeps a projection entry whose fixture it cannot find", () => {
    // The points drive the weekly total; the fixture only labels the row.
    const parsed = parseBootstrap({
      data: {
        teamFixtures: { 1: [] },
        players: [{
          id: 1, displayName: "One", teamId: 1, position: "MID", priceTenths: 50,
          current: { totalPoints: 10, minutes: 90 },
          projection: { nextGW: 4, fixtures: [{ gameweek: 7, fixtureId: 999, expectedPoints: 4, expectedMinutes: 85 }] },
        }],
      },
    });
    const entry = parsed.players[0]!.projection.fixtures[0]!;

    expect(entry.expectedPoints).toBe(4);
    expect(entry.gameweek).toBe(7);
    expect(entry.fixture.opponentShortName).toBe("—");
  });
});
