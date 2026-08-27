import { describe, expect, it } from "vitest";
import type { Player } from "@/types/player";
import {
  aggregateFixturePointsByGameweek,
  calculateFixtureAdjustment,
  estimateExpectedMinutes,
  fixturePointsForGameweek,
  projectPlayer,
  regressPer90,
} from "@/lib/projections";

function player(fixtures: Player["fixtures"], selection?: Player["selection"]): Player {
  return {
    id: 1,
    firstName: "Test",
    lastName: "Player",
    displayName: "Test Player",
    teamId: 1,
    teamName: "Test",
    teamShortName: "TST",
    position: "MID",
    priceTenths: 70,
    ownership: 0,
    status: "a",
    current: { totalPoints: 0, minutes: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0 },
    historical: { season: "2025/26", minutes: 2_700, starts: 30, goals: 8, assists: 8, expectedGoals: 8, expectedAssists: 8 },
    selection,
    fixtures,
  };
}

describe("transparent projection model", () => {
  it("shrinks a tiny per-90 sample toward its prior", () => {
    expect(regressPer90(1.7, 90, 0.3)).toBeLessThan(1.7);
    expect(regressPer90(1.7, 90, 0.3)).toBeGreaterThan(0.3);
  });

  it("prefers an easy home fixture to an elite away fixture", () => {
    expect(calculateFixtureAdjustment({ gameweek: 1, opponentTeamId: 2, opponentShortName: "E", isHome: true, difficulty: 2 }).attackMultiplier)
      .toBeGreaterThan(calculateFixtureAdjustment({ gameweek: 1, opponentTeamId: 3, opponentShortName: "H", isHome: false, difficulty: 5 }).attackMultiplier);
  });

  it("does not give a relegation defence a 25% clean-sheet floor", () => {
    const elite = { teamId: 1, attackHome: 1.16, attackAway: 1.16, defenceHome: 1.16, defenceAway: 1.16, overall: 1.16 };
    const weak = { teamId: 2, attackHome: 0.84, attackAway: 0.84, defenceHome: 0.84, defenceAway: 0.84, overall: 0.84 };
    const weakAway = calculateFixtureAdjustment(
      { gameweek: 1, opponentTeamId: 1, opponentShortName: "ARS", isHome: false, difficulty: 5 },
      { ownTeam: weak, opponentTeam: elite },
    );
    const eliteHome = calculateFixtureAdjustment(
      { gameweek: 1, opponentTeamId: 2, opponentShortName: "COV", isHome: true, difficulty: 1 },
      { ownTeam: elite, opponentTeam: weak },
    );

    expect(weakAway.cleanSheetProbability).toBeLessThan(0.12);
    expect(eliteHome.cleanSheetProbability).toBeGreaterThan(0.4);
    expect(eliteHome.cleanSheetProbability).toBeGreaterThan(weakAway.cleanSheetProbability * 4);
  });

  it("keeps scoring components visible and responds to minutes", () => {
    const healthy = projectPlayer(player([{ gameweek: 1, opponentTeamId: 2, opponentShortName: "E", isHome: true, difficulty: 2 }]), { currentGameweek: 1, horizon: 1, expectedMinutes: 85 });
    const reduced = projectPlayer(player([{ gameweek: 1, opponentTeamId: 2, opponentShortName: "E", isHome: true, difficulty: 2 }]), { currentGameweek: 1, horizon: 1, expectedMinutes: 25 });
    expect(healthy.nextGW).toBeGreaterThan(reduced.nextGW);
    expect(healthy.components?.goals).toBeGreaterThan(0);
    expect(healthy.confidence).toBe("HIGH");
    expect(reduced.riskScore).toBeGreaterThan(healthy.riskScore);
  });

  it("weights start and cameo scenarios with FPL appearance thresholds", () => {
    const fixture = [{ gameweek: 1, opponentTeamId: 2, opponentShortName: "E", isHome: true, difficulty: 2 }];
    const projection = projectPlayer(player(fixture, {
      startProbability: 0.5,
      cameoProbability: 0.25,
      noAppearanceProbability: 0.25,
      expectedMinutes: 45,
      nailedRating: 3,
      confidence: "MEDIUM",
      updatedAt: "2026-08-20T00:00:00.000Z",
      evidence: [],
    }), { currentGameweek: 1, horizon: 1 });

    expect(projection.expectedMinutes).toBe(45);
    expect(projection.confidence).toBe("MEDIUM");
    expect(projection.fixtures[0]?.expectedMinutes).toBe(45);
    expect(projection.components?.appearance).toBeCloseTo(1.25, 6);
    expect(projection.components?.cleanSheets).toBeGreaterThan(0);

    const cameoOnly = projectPlayer(player(fixture, {
      startProbability: 0,
      cameoProbability: 1,
      noAppearanceProbability: 0,
      expectedMinutes: 20,
      nailedRating: 1,
      confidence: "LOW",
      updatedAt: "2026-08-20T00:00:00.000Z",
      evidence: [],
    }), { currentGameweek: 1, horizon: 1 });
    expect(cameoOnly.components?.appearance).toBe(1);
    expect(cameoOnly.components?.cleanSheets).toBe(0);
  });

  it("lets explicit minutes override selection scenarios and stays conservative for unknowns", () => {
    const fixture = [{ gameweek: 1, opponentTeamId: 2, opponentShortName: "E", isHome: true, difficulty: 2 }];
    const selection = {
      startProbability: 1,
      cameoProbability: 0,
      noAppearanceProbability: 0,
      expectedMinutes: 80,
      nailedRating: 5 as const,
      confidence: "HIGH" as const,
      updatedAt: "2026-08-20T00:00:00.000Z",
      evidence: [],
    };
    const projection = projectPlayer(player(fixture, selection), { currentGameweek: 1, horizon: 1, expectedMinutes: 25 });
    expect(projection.expectedMinutes).toBe(25);
    expect(projection.components?.appearance).toBe(1);

    const unknown = { ...player([]), historical: undefined, current: { ...player([]).current, minutes: 0 } };
    expect(estimateExpectedMinutes(unknown)).toBe(0);

    const lowStart = {
      ...player([]),
      historical: { ...player([]).historical!, minutes: 3_420, starts: 0 },
    };
    const regularStarter = {
      ...lowStart,
      historical: { ...lowStart.historical!, starts: 38 },
    };
    expect(estimateExpectedMinutes(lowStart)).toBeLessThan(30);
    expect(estimateExpectedMinutes(regularStarter)).toBeGreaterThan(80);
  });

  it("uses a doubtful player's chanceOfPlaying directly instead of stacking a flat penalty on top of it", () => {
    const base = { ...player([]), status: "d" as const };
    const highChance = { ...base, chanceOfPlaying: 90 };
    const noChance = { ...base, chanceOfPlaying: null };
    // FPL's own 90% estimate should leave this player *more* available than
    // the generic 70% fallback used when no percentage is supplied - the
    // old code applied a flat 0.75 factor for any doubtful player and then
    // multiplied a *known* chance on top (0.75 * 0.9 = 0.675), which would
    // have made a 90%-likely player look less available than one with no
    // estimate at all (flat 0.75).
    expect(estimateExpectedMinutes(highChance)).toBeGreaterThan(estimateExpectedMinutes(noChance));
  });

  it("discounts an unavailable player without a selection model as severely as officialAvailability does with one", () => {
    const injured = { ...player([]), status: "i" as const };
    expect(estimateExpectedMinutes(injured)).toBeLessThan(1);
  });

  it("aggregates doubles for nextGW and counts distinct gameweeks for horizons", () => {
    const projection = projectPlayer(player([
      { gameweek: 1, opponentTeamId: 2, opponentShortName: "A", isHome: true, difficulty: 2 },
      { gameweek: 1, opponentTeamId: 3, opponentShortName: "B", isHome: false, difficulty: 3 },
      { gameweek: 2, opponentTeamId: 4, opponentShortName: "C", isHome: true, difficulty: 3 },
      { gameweek: 4, opponentTeamId: 5, opponentShortName: "D", isHome: false, difficulty: 4 },
      { gameweek: 5, opponentTeamId: 6, opponentShortName: "E", isHome: true, difficulty: 2 },
      { gameweek: 8, opponentTeamId: 7, opponentShortName: "F", isHome: true, difficulty: 3 },
    ]), { currentGameweek: 1, horizon: 5, expectedMinutes: 90 });
    const totals = aggregateFixturePointsByGameweek(projection.fixtures);
    const sum = (start: number, count: number) => Array.from({ length: count }, (_, offset) => start + offset)
      .reduce((total, gameweek) => total + (totals.get(gameweek) ?? 0), 0);

    expect(projection.nextGW).toBeCloseTo(sum(1, 1), 6);
    expect(projection.next3).toBeCloseTo(sum(1, 3), 6);
    expect(projection.next5).toBeCloseTo(sum(1, 5), 6);
    expect(projection.next10).toBeCloseTo(sum(1, 10), 6);
    expect(projection.nextGW).toBeGreaterThan(projection.fixtures[0]?.expectedPoints ?? 0);
    expect(fixturePointsForGameweek(projection.fixtures, 3)).toBe(0);

    const blankCurrentGameweek = projectPlayer(player(projection.fixtures.map(({ fixture }) => fixture)), {
      currentGameweek: 3,
      horizon: 5,
      expectedMinutes: 90,
    });
    expect(blankCurrentGameweek.nextGW).toBe(0);
  });

  it("can retain fixtures beyond the five-gameweek summary horizon", () => {
    const projection = projectPlayer(player([
      { gameweek: 1, opponentTeamId: 2, opponentShortName: "A", isHome: true, difficulty: 2 },
      { gameweek: 8, opponentTeamId: 3, opponentShortName: "B", isHome: false, difficulty: 4 },
    ]), { currentGameweek: 1, horizon: 5, fixtureHorizon: 8, expectedMinutes: 90 });

    expect(projection.fixtures.map(({ gameweek }) => gameweek)).toEqual([1, 8]);
    expect(projection.next5).toBeCloseTo(projection.nextGW, 6);
  });
});
