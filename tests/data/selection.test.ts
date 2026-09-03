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
    expect(starter.startProbability).toBe(0.875);
    expect(starter.cameoProbability).toBe(0.068);
    expect(absent.startProbability).toBe(0.275);
    expect(absent.cameoProbability).toBe(0.12);
    expect(starter.startProbability).toBeGreaterThan(absent.startProbability * 3);
    expect(starter.evidence.some((item) => item.source === "PREDICTED_XI")).toBe(true);
    expect(absent.evidence.some((item) => item.detail.includes("Not in the predicted XI"))).toBe(true);
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
    expect(selections.get(3)!.evidence.some((item) => item.source === "TEAM_NEWS")).toBe(true);
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

  it("uses a doubtful player's chanceOfPlaying directly instead of stacking a flat penalty on top of it", () => {
    const highChance = { ...player(1), status: "d", chanceOfPlaying: 75 };
    const noChance = { ...player(2), status: "d", chanceOfPlaying: null };
    const selections = buildPlayerSelections([highChance, noChance]);
    // FPL's own 75% estimate should leave this player *more* available than
    // the generic 70% fallback used when no percentage is supplied. The old
    // code stacked them (0.7 * 0.75 = 52.5%), which would have made the
    // player with the higher known chance look *less* available than the
    // player with no specific estimate at all.
    expect(selections.get(1)!.startProbability).toBeGreaterThan(selections.get(2)!.startProbability);
  });

  it("still applies a flat discount for a doubtful player with no chanceOfPlaying figure", () => {
    const available = { ...player(1), status: "a" };
    const doubtfulNoChance = { ...player(2), status: "d", chanceOfPlaying: null };
    const selections = buildPlayerSelections([available, doubtfulNoChance]);
    expect(selections.get(2)!.startProbability).toBeLessThan(selections.get(1)!.startProbability);
  });

  it("surfaces FPL news text in the evidence trail", () => {
    const injured: Player = { ...player(1), status: "i", news: "Hamstring injury - Expected back 15 Sep" };
    const evidence = buildPlayerSelections([injured]).get(1)!.evidence;
    expect(evidence.some((item) => item.source === "FPL_STATUS" && item.detail.includes("Hamstring injury"))).toBe(true);
  });
});

describe("current-season start history", () => {
  const observations = (pattern: string) =>
    [...pattern].map((mark) => ({ started: mark === "S", appeared: mark !== "-" }));

  it("lifts a fringe player who starts five in a row", () => {
    const cold = buildPlayerSelections([player(1, 1, 0)]).get(1)!;
    const hot = buildPlayerSelections([player(1, 1, 0)], {
      startHistory: { 1: observations("SSSSS") },
    }).get(1)!;
    expect(cold.startProbability).toBeLessThan(0.2);
    expect(hot.startProbability).toBeGreaterThan(0.90);
    expect(hot.nailedRating).toBe(5);
  });

  it("drops a player who loses his place", () => {
    const dropped = buildPlayerSelections([player(1)], {
      startHistory: { 1: observations("SSSSS-----") },
    }).get(1)!;
    expect(dropped.startProbability).toBeLessThan(0.1);
    expect(dropped.cameoProbability).toBeLessThan(0.1);
    expect(dropped.noAppearanceProbability).toBeGreaterThan(0.8);
  });

  it("never lets start history raise an unavailable player", () => {
    const injured = { ...player(1), status: "i", chanceOfPlaying: 0 };
    const selection = buildPlayerSelections([injured], {
      startHistory: { 1: observations("SSSSS") },
    }).get(1)!;
    expect(selection.startProbability).toBeLessThanOrEqual(0.01);
    expect(selection.cameoProbability).toBeLessThanOrEqual(0.01);
  });

  it("leaves a player with no observations exactly where he was", () => {
    const without = buildPlayerSelections([player(1)]).get(1)!;
    const withEmpty = buildPlayerSelections([player(1)], { startHistory: { 1: [] } }).get(1)!;
    expect(withEmpty.startProbability).toBe(without.startProbability);
    expect(withEmpty.cameoProbability).toBe(without.cameoProbability);
  });

  it("does not count current-season minutes twice for a player with no history", () => {
    // A promoted club's player or a new signing has no historical sample, so
    // the seed would otherwise come from fallbackStartRate - which reads this
    // season's running minutes, the same evidence the recursion is about to
    // replay. 900 minutes with only two observations (the rest lost to double
    // gameweeks) is where that bites hardest.
    const heavyMinutes = buildPlayerSelections([player(1, 1, 900)], {
      startHistory: { 1: observations("SS") },
    }).get(1)!;
    const noMinutes = buildPlayerSelections([player(1, 1, 0)], {
      startHistory: { 1: observations("SS") },
    }).get(1)!;
    // Identical: the minutes reach the estimate only through the observations.
    expect(heavyMinutes.startProbability).toBe(noMinutes.startProbability);
    expect(heavyMinutes.startProbability).toBeCloseTo(0.694, 3);
  });

  it("still seeds from current-season minutes when there is nothing else at all", () => {
    // No history and no observations yet: the fallback is the only evidence
    // there is, so it must keep working exactly as before.
    const busy = buildPlayerSelections([player(1, 1, 900)]).get(1)!;
    const idle = buildPlayerSelections([player(1, 1, 0)]).get(1)!;
    expect(busy.startProbability).toBeGreaterThan(idle.startProbability);
  });

  it("records the run of starts as current-season evidence", () => {
    const evidence = buildPlayerSelections([player(1)], {
      startHistory: { 1: observations("SSsS-S") },
    }).get(1)!.evidence;
    expect(evidence).toContainEqual({
      source: "CURRENT_SEASON",
      detail: "4 starts in 6 matches this season (last 5: SsS-S)",
    });
  });

  it("raises confidence once five matches have been observed", () => {
    const thin = buildPlayerSelections([player(1, 1, 0)], { startHistory: { 1: observations("S") } }).get(1)!;
    const settled = buildPlayerSelections([player(1, 1, 0)], { startHistory: { 1: observations("SSSSS") } }).get(1)!;
    expect(thin.confidence).toBe("MEDIUM");
    expect(settled.confidence).toBe("HIGH");
  });
});
