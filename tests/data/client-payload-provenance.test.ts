import { describe, expect, it } from "vitest";
import { loadRotowireSelectionData } from "@/lib/availability/loadSelectionData";
import { buildPlayerSelections } from "@/lib/availability/selection";
import { enrichBootstrapWithProjections, normalizeBootstrap } from "@/lib/fpl/normalize";
import { FplBootstrapSchema } from "@/lib/fpl/schemas";
import type { RotowireMappedRecord } from "@/lib/availability/rotowireMapping";
import type { Player } from "@/types/player";

/**
 * The lineup source is a courtesy scrape with no API and no licence to
 * redistribute. It may inform the model on the server; its name must not reach
 * a browser. These assertions sit on the payload rather than on any one
 * module, because every leak so far has come from somewhere new: an evidence
 * string, a badge class, an upstream error message forwarded as metadata.
 */
const PROVIDER = /rotowire/i;

function player(id: number): Player {
  return {
    id,
    firstName: `Player ${id}`,
    lastName: "Test",
    displayName: `Player ${id}`,
    teamId: 1,
    teamName: "Alpha",
    teamShortName: "ALP",
    position: "MID",
    priceTenths: 50,
    ownership: 0,
    status: "a",
    chanceOfPlaying: null,
    current: { totalPoints: 0, minutes: 2_700, goals: 0, assists: 0, cleanSheets: 0, bonus: 0 },
    fixtures: [],
  };
}

function mapping(
  playerId: number,
  source: RotowireMappedRecord["source"],
  extra: Partial<RotowireMappedRecord> = {},
): RotowireMappedRecord {
  return {
    fixtureIndex: 0,
    teamSide: "HOME",
    teamName: "Alpha",
    teamAbbreviation: "ALP",
    lineupStatus: "PREDICTED",
    rotowireId: 100 + playerId,
    name: `Player ${playerId}`,
    position: "M",
    source,
    playerId,
    method: "EXACT_NAME",
    ...extra,
  };
}

function normalized() {
  const payload = FplBootstrapSchema.parse({
    events: [{ id: 1, name: "Gameweek 1", is_next: true, finished: false }],
    teams: [
      { id: 1, name: "Alpha", short_name: "ALP", strength_overall_home: 4, strength_overall_away: 4 },
      { id: 2, name: "Beta", short_name: "BET", strength_overall_home: 3, strength_overall_away: 3 },
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
  ]);
}

describe("client payload provenance", () => {
  it("never names the lineup source in selection evidence", () => {
    // Every branch that emits evidence at once: a confirmed starter, a
    // predicted starter, a covered player left out of the XI, and a flag.
    const selections = buildPlayerSelections([player(1), player(2), player(3), player(4)], {
      rotowire: {
        snapshot: { fetchedAt: "2026-08-20T12:00:00.000Z" },
        mappings: [
          mapping(1, "STARTER", { lineupStatus: "CONFIRMED" }),
          mapping(2, "STARTER"),
          mapping(4, "UNAVAILABLE", { availabilityStatus: "QUES" }),
        ],
      },
      updatedAt: "2026-08-20T12:00:00.000Z",
    });

    const evidence = [...selections.values()].flatMap((selection) => selection.evidence);
    expect(evidence.length).toBeGreaterThan(4);
    expect(JSON.stringify(evidence)).not.toMatch(PROVIDER);
    for (const item of evidence) {
      expect(item.source).not.toMatch(PROVIDER);
      expect(item.detail).not.toMatch(PROVIDER);
    }
  });

  it("keeps the evidence built from the shipped snapshot clean", () => {
    // The cases above are hand-built. This one runs the selection model over
    // the snapshot actually in `data/generated`, so a label the scrape starts
    // emitting tomorrow is caught by the data rather than by a fixture.
    const data = loadRotowireSelectionData();
    expect(data?.mappings.length ?? 0).toBeGreaterThan(200);

    const players = data!.mappings.map((record) => player(record.playerId));
    const selections = buildPlayerSelections(players, { rotowire: data!, updatedAt: "2026-08-20T12:00:00.000Z" });
    const evidence = [...selections.values()].flatMap((selection) => selection.evidence);

    expect(evidence.length).toBeGreaterThan(200);
    expect(JSON.stringify(evidence)).not.toMatch(PROVIDER);
  });

  it("keeps the whole bootstrap response clean", async () => {
    // Breadth rather than depth: the projection block, the freshness metadata
    // and every field beside them, in one serialized body.
    const enriched = await enrichBootstrapWithProjections(normalized(), null);
    const body = JSON.stringify({ data: enriched.bootstrap, metadata: enriched.metadata });

    expect(enriched.bootstrap.players.length).toBeGreaterThan(0);
    // The lineup block is the one piece of metadata sourced from the scrape,
    // so it has to be present for this to be worth asserting on.
    expect(enriched.metadata.lineups?.fetchedAt).toEqual(expect.any(String));
    expect(body).not.toMatch(PROVIDER);
  });
});
