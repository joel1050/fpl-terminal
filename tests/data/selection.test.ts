import { describe, expect, it } from "vitest";
import type { Player } from "@/types/player";
import { buildPlayerSelections } from "@/lib/availability/selection";
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
  it("normalizes scenarios and gives the predicted XI a strong start signal", () => {
    const selections = buildPlayerSelections([player(1), player(2)], {
      rotowire: { snapshot: { fetchedAt: "2026-08-20T12:00:00.000Z" }, mappings: [mapping(1, "STARTER")] },
      updatedAt: "2026-08-20T12:00:00.000Z",
    });
    const starter = selections.get(1)!;
    const absent = selections.get(2)!;
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

  it("keeps an uncovered, unmapped player on a conservative prior", () => {
    const selection = buildPlayerSelections([player(1, 2, 0)], { updatedAt: "snapshot" }).get(1)!;
    expect(selection.nailedRating).toBe(2);
    expect(selection.expectedMinutes).toBeLessThan(25);
    expect(selection.expectedMinutes).not.toBe(62);
  });
});
