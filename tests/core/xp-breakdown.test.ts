import { describe, expect, it } from "vitest";
import type { Player, Position } from "@/types/player";
import type { ProjectionComponents } from "@/types/projection";
import {
  BREAKDOWN_COMPONENT_KEYS,
  gameweekBreakdown,
  packComponents,
  unpackComponents,
} from "@/lib/projections/breakdown";
import { weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";

function components(overrides: Partial<ProjectionComponents> = {}): ProjectionComponents {
  const base: ProjectionComponents = {
    appearance: 1.8,
    goals: 0.42,
    assists: 0.19,
    cleanSheets: 0.31,
    goalsConceded: -0.24,
    saves: 0,
    defensiveContribution: 0.36,
    bonus: 0.28,
    cards: -0.07,
    penalties: 0,
    total: 0,
  };
  const merged = { ...base, ...overrides };
  merged.total = BREAKDOWN_COMPONENT_KEYS.reduce((sum, key) => sum + merged[key], 0);
  return merged;
}

function player(
  position: Position,
  fixtures: { gameweek: number; components: ProjectionComponents }[],
  extra: Partial<Pick<Player, "current" | "historical" | "selection">> = {},
): Player {
  return {
    id: 1,
    firstName: "P",
    lastName: "One",
    displayName: "P One",
    teamId: 1,
    teamName: "Team",
    teamShortName: "TEA",
    position,
    priceTenths: 50,
    ownership: 0,
    status: "a",
    current: { totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 900 },
    fixtures: [],
    ...extra,
    projection: {
      playerId: 1,
      fixtures: fixtures.map((entry) => ({
        gameweek: entry.gameweek,
        expectedPoints: Math.round(entry.components.total * 100) / 100,
        expectedMinutes: 90,
        fixture: { gameweek: entry.gameweek, opponentTeamId: 9, opponentShortName: "OPP", isHome: true },
        components: entry.components,
      })),
      nextGW: 0,
      next3: 0,
      next5: 0,
      next10: 0,
      expectedMinutes: 90,
      valueNext5: 0,
      riskScore: 0,
      confidence: "HIGH",
      factors: [],
    },
  };
}

describe("packed projection components", () => {
  it("survives a round trip through the wire format", () => {
    const source = components();
    const restored = unpackComponents(packComponents(source));
    for (const key of BREAKDOWN_COMPONENT_KEYS) {
      expect(restored[key]).toBeCloseTo(source[key], 2);
    }
    expect(restored.total).toBeCloseTo(source.total, 2);
  });

  it("packs one number per scoring key, in that order", () => {
    const packed = packComponents(components());
    expect(packed).toHaveLength(BREAKDOWN_COMPONENT_KEYS.length);
    expect(packed[BREAKDOWN_COMPONENT_KEYS.indexOf("goals")]).toBeCloseTo(0.42, 2);
  });

  it("rounds every value to two decimals so the payload stays small", () => {
    const packed = packComponents(components({ goals: 0.123456789 }));
    expect(packed[BREAKDOWN_COMPONENT_KEYS.indexOf("goals")]).toBe(0.12);
  });

  it("covers every scoring field on ProjectionComponents", () => {
    const keys = Object.keys(components()).filter((key) => key !== "total" && key !== "penalties");
    expect([...BREAKDOWN_COMPONENT_KEYS].sort()).toEqual(keys.sort());
  });
});

describe("gameweek points breakdown", () => {
  it("totals the same points the weekly metrics show", () => {
    const subject = player("MID", [{ gameweek: 5, components: components() }]);
    const breakdown = gameweekBreakdown(subject, 5);
    expect(breakdown).not.toBeNull();
    expect(breakdown!.total).toBeCloseTo(weeklyPlayerMetrics(subject, 5).points, 2);
  });

  it("sums both matches of a double gameweek", () => {
    const subject = player("MID", [
      { gameweek: 7, components: components() },
      { gameweek: 7, components: components() },
    ]);
    const breakdown = gameweekBreakdown(subject, 7);
    const goals = breakdown!.rows.find((row) => row.key === "goals");
    expect(breakdown!.matches).toBe(2);
    expect(goals!.points).toBeCloseTo(0.84, 2);
  });

  it("returns nothing for a gameweek with no match", () => {
    const subject = player("MID", [{ gameweek: 5, components: components() }]);
    expect(gameweekBreakdown(subject, 6)).toBeNull();
  });

  it("returns nothing when the breakdown was not shipped", () => {
    const subject = player("MID", [{ gameweek: 5, components: components() }]);
    subject.projection!.fixtures[0].components = undefined;
    expect(gameweekBreakdown(subject, 5)).toBeNull();
  });

  it("hides rows a goalkeeper can never score", () => {
    const subject = player("GK", [{ gameweek: 5, components: components({ goals: 0, saves: 0.9 }) }]);
    const keys = gameweekBreakdown(subject, 5)!.rows.map((row) => row.key);
    expect(keys).not.toContain("goals");
    expect(keys).toContain("saves");
  });

  it("hides goalkeeper rows for an outfield player", () => {
    const subject = player("FWD", [{ gameweek: 5, components: components({ cleanSheets: 0, goalsConceded: 0 }) }]);
    const keys = gameweekBreakdown(subject, 5)!.rows.map((row) => row.key);
    expect(keys).not.toContain("saves");
    expect(keys).not.toContain("goalsConceded");
    expect(keys).not.toContain("cleanSheets");
  });

  it("keeps a scoreable row at zero rather than dropping it", () => {
    const subject = player("MID", [{ gameweek: 5, components: components({ goals: 0 }) }]);
    const goals = gameweekBreakdown(subject, 5)!.rows.find((row) => row.key === "goals");
    expect(goals?.points).toBe(0);
  });

  it("says how much a clean sheet is worth, which differs by position", () => {
    const defender = player("DEF", [{ gameweek: 5, components: components() }]);
    const midfielder = player("MID", [{ gameweek: 5, components: components() }]);
    const noteFor = (subject: Player) =>
      gameweekBreakdown(subject, 5)!.rows.find((row) => row.key === "cleanSheets")!.note;

    expect(noteFor(defender)).toContain("4 points");
    expect(noteFor(midfielder)).toContain("1 point");
  });

  it("marks deductions so the display can read them as subtractions", () => {
    const subject = player("DEF", [{ gameweek: 5, components: components() }]);
    const rows = gameweekBreakdown(subject, 5)!.rows;
    expect(rows.find((row) => row.key === "cards")!.deduction).toBe(true);
    expect(rows.find((row) => row.key === "goals")!.deduction).toBe(false);
  });

  it("reads a packed breakdown as readily as an unpacked one", () => {
    const subject = player("MID", [{ gameweek: 5, components: components() }]);
    const fixture = subject.projection!.fixtures[0];
    fixture.packedComponents = packComponents(fixture.components!);
    fixture.components = undefined;
    expect(gameweekBreakdown(subject, 5)!.total).toBeCloseTo(weeklyPlayerMetrics(subject, 5).points, 2);
  });
});

describe("evidence behind each row", () => {
  const CURRENT = {
    totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 6, minutes: 900,
    expectedGoals: 8.1, expectedAssists: 2.7, expectedGoalsConceded: 10.8,
    goalsConceded: 12, saves: 24, defensiveContribution: 91, yellowCards: 2,
  };
  const PREVIOUS = {
    season: "2025/26", minutes: 1_800, expectedGoals: 12.6, expectedAssists: 3.6,
    expectedGoalsConceded: 14.4, goalsConceded: 18, saves: 32, defensiveContribution: 168,
    bonus: 8, yellowCards: 6,
  };

  function rowFor(key: string, position: Position = "MID", extra: Partial<Pick<Player, "current" | "historical" | "selection">> = {}) {
    const subject = player(position, [{ gameweek: 5, components: components() }], {
      current: CURRENT, historical: PREVIOUS, ...extra,
    });
    return gameweekBreakdown(subject, 5)!.rows.find((row) => row.key === key)!;
  }

  it("shows the per-90 rate behind goals for both seasons", () => {
    const row = rowFor("goals");
    expect(row.metric).toBe("xG per 90");
    expect(row.evidence).toEqual([
      { label: "This season", value: "0.81" },
      { label: "Previous season", value: "0.63" },
    ]);
  });

  it("labels the seasons plainly rather than by their year", () => {
    const labels = rowFor("assists").evidence.map((entry) => entry.label);
    expect(labels).toEqual(["This season", "Previous season"]);
  });

  it("leaves the fixture out of the goals evidence", () => {
    const values = rowFor("goals").evidence.map((entry) => entry.value).join(" ");
    expect(values).not.toMatch(/difficulty|opp/i);
  });

  it("says a player is expected to start, and for how long", () => {
    const row = rowFor("appearance", "MID", {
      selection: {
        startProbability: 0.92, cameoProbability: 0.04, noAppearanceProbability: 0.04,
        expectedMinutes: 84.4, nailedRating: 5, confidence: "HIGH",
        updatedAt: "2026-09-01T10:00:00.000Z", evidence: [],
      },
    });
    expect(row.evidence).toEqual([
      { label: "Selection", value: "Expected to start this game" },
      { label: "Minutes", value: "84 expected" },
    ]);
  });

  it("does not claim a start for a player unlikely to feature", () => {
    const row = rowFor("appearance", "MID", {
      selection: {
        startProbability: 0.08, cameoProbability: 0.2, noAppearanceProbability: 0.72,
        expectedMinutes: 7, nailedRating: 1, confidence: "LOW",
        updatedAt: "2026-09-01T10:00:00.000Z", evidence: [],
      },
    });
    expect(row.evidence[0]).toEqual({ label: "Selection", value: "Unlikely to feature" });
  });

  it("says how many defensive actions earn the points", () => {
    const row = rowFor("defensiveContribution", "DEF");
    expect(row.metric).toBe("Defensive actions per 90");
    expect(row.evidence).toContainEqual({ label: "Needed", value: "10 a match" });
  });

  it("refuses to quote a rate off a handful of minutes", () => {
    const row = rowFor("goals", "MID", { current: { ...CURRENT, minutes: 40 } });
    expect(row.evidence[0]).toEqual({ label: "This season", value: "not enough minutes yet" });
  });

  it("omits the previous season when the player has no record of one", () => {
    const row = rowFor("goals", "MID", { historical: undefined });
    expect(row.evidence.map((entry) => entry.label)).toEqual(["This season"]);
  });

  it("gives every row something to stand on", () => {
    const subject = player("GK", [{ gameweek: 5, components: components() }], { current: CURRENT, historical: PREVIOUS });
    for (const row of gameweekBreakdown(subject, 5)!.rows) {
      expect(row.evidence.length).toBeGreaterThan(0);
    }
  });
});
