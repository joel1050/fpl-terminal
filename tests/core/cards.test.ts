import { describe, expect, it } from "vitest";
import type { Player, Position } from "@/types/player";
import { projectPlayer } from "@/lib/projections";

function player(position: Position, overrides: Partial<Player> = {}): Player {
  return {
    id: 1,
    firstName: "Test",
    lastName: "Player",
    displayName: "Test Player",
    teamId: 1,
    teamName: "Test",
    teamShortName: "TST",
    position,
    priceTenths: 50,
    ownership: 0,
    status: "a",
    current: { totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 0 },
    fixtures: [{ gameweek: 1, opponentTeamId: 2, opponentShortName: "OPP", isHome: true, difficulty: 3 }],
    ...overrides,
  };
}

const project = (p: Player, minutes = 90) =>
  projectPlayer(p, { currentGameweek: 1, horizon: 1, expectedMinutes: minutes });

describe("card deductions", () => {
  it("costs every outfield player points, sized by position", () => {
    const cards = (position: Position) => project(player(position)).components!.cards;
    // Measured over 2025/26: a defender loses roughly twice what a forward does.
    expect(cards("DEF")).toBeLessThan(cards("FWD"));
    expect(cards("FWD")).toBeLessThan(cards("GK"));
    for (const position of ["GK", "DEF", "MID", "FWD"] as const) {
      expect(cards(position)).toBeLessThan(0);
      expect(cards(position)).toBeGreaterThan(-0.5);
    }
  });

  it("matches the league-wide deduction per appearance", () => {
    // -0.135 points per appearance across every 2025/26 appearance.
    const full = (["GK", "DEF", "MID", "FWD"] as const).map((p) => project(player(p)).components!.cards);
    const average = full.reduce((s, v) => s + v, 0) / full.length;
    expect(average).toBeGreaterThan(-0.2);
    expect(average).toBeLessThan(-0.08);
  });

  it("scales with time on the pitch", () => {
    const full = project(player("DEF"), 90).components!.cards;
    const cameo = project(player("DEF"), 20).components!.cards;
    expect(cameo).toBeGreaterThan(full);
    expect(cameo).toBeLessThan(0);
  });

  it("uses a player's own record when he has one", () => {
    const booked = player("MID", {
      historical: { season: "2025/26", minutes: 1800, yellowCards: 12, redCards: 1 },
    });
    const clean = player("MID", {
      historical: { season: "2025/26", minutes: 1800, yellowCards: 0, redCards: 0 },
    });
    expect(project(booked).components!.cards).toBeLessThan(project(clean).components!.cards);
  });

  it("never implies more than one booking in a match", () => {
    const reckless = player("DEF", {
      historical: { season: "2025/26", minutes: 900, yellowCards: 40, redCards: 0 },
    });
    // The rate is a probability of being booked, not a count times minutes.
    expect(project(reckless).components!.cards).toBeGreaterThanOrEqual(-1);
  });
});
