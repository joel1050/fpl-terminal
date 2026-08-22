import { describe, expect, it } from "vitest";
import type { Player } from "@/types/player";
import { buildPlayerSelections } from "@/lib/availability/selection";
import { buildCurrentMatchStats } from "@/lib/availability/currentMatchStats";
import type { RotowireMappedRecord } from "@/lib/availability/rotowireMapping";

function player(id: number, teamId = 1, minutes = 2_700): Player {
  return {
    id,
    firstName: `Player ${id}`,
    lastName: "Test",
    displayName: `Player ${id}`,
    teamId,
    teamName: teamId === 1 ? "Alpha" : "Beta",
    teamShortName: teamId === 1 ? "ALP" : "BET",
    position: "MID",
    priceTenths: 50,
    ownership: 0,
    status: "a",
    chanceOfPlaying: null,
    current: { totalPoints: 0, minutes, goals: 0, assists: 0, cleanSheets: 0, bonus: 0 },
    fixtures: [],
  };
}

function mapping(playerId: number, source: RotowireMappedRecord["source"], status?: string): RotowireMappedRecord {
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
    ...(status ? { availabilityStatus: status } : {}),
    playerId,
    method: "EXACT_NAME",
  };
}

describe("player selection model", () => {
  const played = (minutes: readonly number[], playerId = 1) =>
    minutes.map((value, index) => ({ playerId, gameweek: index + 1, minutes: value }));

  it("reads a role from recent matches rather than a season-long count", () => {
    const started = Array.from({ length: 5 }, () => 90);
    const benched = Array.from({ length: 5 }, () => 0);
    // Same ten matches, same five starts. Only the order differs.
    const droppedRecently = buildPlayerSelections([player(1)], {
      currentMatchStats: played([...started, ...benched]),
    });
    const recalled = buildPlayerSelections([player(1)], {
      currentMatchStats: played([...benched, ...started]),
    });

    expect(recalled.get(1)!.startProbability).toBeGreaterThan(0.6);
    expect(droppedRecently.get(1)!.startProbability).toBeLessThan(0.32);
    expect(recalled.get(1)!.startProbability).toBeGreaterThan(droppedRecently.get(1)!.startProbability * 2);
  });

  it("lets last season fade as this season accumulates", () => {
    const lastSeason = {
      players: [],
      playerMappings: [{ currentPlayerId: 1, historicalPlayerId: 1, confidence: "EXACT" as const }],
      matchStats: Array.from({ length: 38 }, (_, index) => ({
        historicalPlayerId: 1,
        gameweek: index + 1,
        fixtureId: index + 1,
        opponentTeamId: 2,
        minutes: 90,
        totalPoints: 0,
        goals: 0,
        assists: 0,
        expectedGoals: 0,
        expectedAssists: 0,
        bonus: 0,
        bps: 0,
        wasHome: true,
      })),
      generatedAt: "2026-08-20T00:00:00.000Z",
    };
    // An ever-present last season who has not started a match this season.
    const at = (matches: number) => buildPlayerSelections([player(1)], {
      historical: lastSeason,
      currentMatchStats: played(Array.from({ length: matches }, () => 0)),
    }).get(1)!.startProbability;

    expect(at(0)).toBeGreaterThan(0.65);
    expect(at(3)).toBeLessThan(at(0) / 1.5);
    expect(at(10)).toBeLessThan(at(3));
    expect(at(10)).toBeLessThan(0.3);
  });

  it("keeps one row per player per match and orders them by gameweek", () => {
    const rows = buildCurrentMatchStats([
      { gameweek: 2, elements: [{ playerId: 7, stats: { minutes: 45 } }] },
      { gameweek: 1, elements: [{ playerId: 7, stats: { minutes: "90" } }, { playerId: 9, stats: { minutes: null } }] },
    ]);
    expect(rows).toEqual([
      { playerId: 7, gameweek: 1, minutes: 90 },
      { playerId: 7, gameweek: 2, minutes: 45 },
    ]);
  });

  it("normalizes scenarios and gives the predicted XI a strong start signal", () => {
    const selections = buildPlayerSelections([player(1), player(2)], {
      rotowire: { snapshot: { fetchedAt: "2026-08-20T12:00:00.000Z" }, mappings: [mapping(1, "STARTER")] },
      updatedAt: "2026-08-20T12:00:00.000Z",
    });
    const starter = selections.get(1)!;
    const absent = selections.get(2)!;
    expect(starter.startProbability).toBe(0.875);
    expect(starter.cameoProbability).toBe(0.068);
    expect(absent.startProbability).toBe(0.275);
    expect(absent.cameoProbability).toBe(0.12);
    expect(starter.startProbability).toBeGreaterThan(absent.startProbability * 3);
    expect(starter.evidence.some((item) => item.source === "ROTOWIRE_XI")).toBe(true);
    expect(absent.evidence.some((item) => item.detail.includes("Not in the RotoWire predicted XI"))).toBe(true);
    for (const selection of selections.values()) {
      expect(selection.startProbability + selection.cameoProbability + selection.noAppearanceProbability).toBeCloseTo(1, 6);
      expect(selection.updatedAt).toBe("2026-08-20T12:00:00.000Z");
    }
  });

  it("uses player-specific historical start duration for predicted starters", () => {
    const rows = (playerId: number, minutes: number[]) => minutes.map((value, index) => ({
      historicalPlayerId: playerId,
      gameweek: index + 1,
      minutes: value,
      totalPoints: 0,
      goals: 0,
      assists: 0,
      bonus: 0,
      bps: 0,
    }));
    const selections = buildPlayerSelections([player(1), player(2)], {
      rotowire: {
        snapshot: { fetchedAt: "2026-08-20T12:00:00.000Z" },
        mappings: [mapping(1, "STARTER"), mapping(2, "STARTER")],
      },
      historical: {
        generatedAt: "2026-08-20T12:00:00.000Z",
        players: [
          { historicalPlayerId: 101, displayName: "Player 1", stats: { season: "2025/26", minutes: 145, starts: 2 } },
          { historicalPlayerId: 102, displayName: "Player 2", stats: { season: "2025/26", minutes: 185, starts: 2 } },
        ],
        matchStats: [...rows(101, [65, 60, 20]), ...rows(102, [90, 90, 5])],
        playerMappings: [
          { currentPlayerId: 1, historicalPlayerId: 101, confidence: "EXACT" },
          { currentPlayerId: 2, historicalPlayerId: 102, confidence: "EXACT" },
        ],
      },
    });

    expect(selections.get(1)?.expectedStartMinutes).toBe(62.5);
    expect(selections.get(2)?.expectedStartMinutes).toBe(90);
    expect(selections.get(1)?.expectedMinutes).toBeLessThan(selections.get(2)?.expectedMinutes ?? 0);
    expect(selections.get(1)?.expectedMinutes).not.toBe(73);
    expect(selections.get(2)?.expectedMinutes).not.toBe(73);
  });

  it("caps RotoWire OUT/SUS and lowers QUES", () => {
    const selections = buildPlayerSelections([player(1), player(2), player(3), player(4, 2)], {
      rotowire: {
        snapshot: { fetchedAt: "2026-08-20T12:00:00.000Z" },
        mappings: [mapping(1, "UNAVAILABLE", "OUT"), mapping(2, "UNAVAILABLE", "SUS"), mapping(3, "UNAVAILABLE", "QUES")],
      },
    });
    expect(selections.get(1)!.startProbability).toBeLessThan(0.05);
    expect(selections.get(2)!.startProbability).toBeLessThan(0.05);
    expect(selections.get(3)!.startProbability).toBeLessThan(selections.get(4)!.startProbability);
    expect(selections.get(3)!.evidence.some((item) => item.source === "ROTOWIRE_AVAILABILITY")).toBe(true);
  });

  it("never lets a RotoWire starter signal raise injured or suspended probabilities", () => {
    const injured = { ...player(1), status: "i" };
    const suspended = { ...player(2), status: "s" };
    const selections = buildPlayerSelections([injured, suspended], {
      rotowire: {
        mappings: [
          mapping(1, "STARTER"),
          mapping(1, "UNAVAILABLE", "OUT"),
          mapping(2, "STARTER"),
          mapping(2, "UNAVAILABLE", "SUS"),
        ],
      },
    });

    for (const selection of selections.values()) {
      expect(selection.startProbability).toBeLessThanOrEqual(0.01);
      expect(selection.cameoProbability).toBeLessThanOrEqual(0.01);
    }
  });

  it("keeps an uncovered, unmapped player on a conservative prior", () => {
    const selection = buildPlayerSelections([player(1, 2, 0)], { updatedAt: "snapshot" }).get(1)!;
    expect(selection.nailedRating).toBe(2);
    expect(selection.expectedMinutes).toBeLessThan(25);
    expect(selection.expectedMinutes).not.toBe(62);
  });
});
