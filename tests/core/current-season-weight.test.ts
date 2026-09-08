import { describe, expect, it } from "vitest";
import type { Player } from "@/types/player";
import type { PlayerMatchRate } from "@/types/projection";
import { projectPlayer } from "@/lib/projections";
import {
  PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
  PLAYER_FORM_PRIOR_WEIGHT_RARE_EVENTS,
} from "@/lib/projections/playerForm";

/**
 * Components on the regressedPlayerRate path (bonus, cards, saves, defensive
 * contribution) used to take their current-season share from the calendar:
 * min(currentGameweek / 10, 0.6). These pin the replacement, which counts the
 * player's own appearances instead.
 */
function midfielder(overrides: Partial<Player> = {}): Player {
  return {
    id: 1,
    firstName: "Test",
    lastName: "Midfielder",
    displayName: "Test Midfielder",
    teamId: 1,
    teamName: "Test",
    teamShortName: "TST",
    position: "MID",
    priceTenths: 50,
    ownership: 0,
    status: "a",
    current: { totalPoints: 0, minutes: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0 },
    fixtures: [{ gameweek: 11, opponentTeamId: 2, opponentShortName: "OPP", isHome: true, difficulty: 3 }],
    ...overrides,
  };
}

const fullMatches = (count: number): PlayerMatchRate[] =>
  Array.from({ length: count }, () => ({ xg: 0, xa: 0, minutes: 90 }));

/** Bonus points per 90 that the projection implies, isolated from every other component. */
function bonusRate(player: Player, form: PlayerMatchRate[] | undefined): number {
  const projection = projectPlayer(player, {
    currentGameweek: 11,
    horizon: 1,
    expectedMinutes: 90,
    ...(form ? { playerForm: { 1: form } } : {}),
  });
  return projection.components?.bonus ?? 0;
}

describe("current-season weight on the regressedPlayerRate path", () => {
  // A player whose current season is far above his previous one, so any change
  // in the current-season share moves the answer.
  const hotStreak = (appearances: number) => midfielder({
    historical: { season: "2024/25", minutes: 3000, bonus: 3 },
    current: {
      totalPoints: 60, minutes: appearances * 90, goals: 0, assists: 0, cleanSheets: 0, bonus: appearances * 2,
    },
  });

  it("gives a player with one appearance far less current-season weight than one with ten", () => {
    const barelyPlayed = bonusRate(hotStreak(1), fullMatches(1));
    const everPresent = bonusRate(hotStreak(10), fullMatches(10));
    expect(everPresent).toBeGreaterThan(barelyPlayed);
  });

  it("no longer reads the share off the gameweek number", () => {
    // Same player, same appearances, two different points in the calendar. The
    // old ramp gave 40% at GW4 and 60% at GW10; the appearance count is what
    // should decide, and it has not changed.
    const player = hotStreak(3);
    const form = fullMatches(3);
    const early = projectPlayer(player, {
      currentGameweek: 4, horizon: 1, expectedMinutes: 90, playerForm: { 1: form },
    });
    const later = projectPlayer(player, {
      currentGameweek: 10, horizon: 1, expectedMinutes: 90, playerForm: { 1: form },
    });
    expect(early.components?.bonus).toBeCloseTo(later.components?.bonus ?? 0, 10);
  });

  it("falls back to the calendar ramp when no form history is wired up", () => {
    // Without form the old behaviour must survive, so a caller that has not
    // wired up the loader is not silently changed.
    const player = hotStreak(3);
    const early = projectPlayer(player, { currentGameweek: 4, horizon: 1, expectedMinutes: 90 });
    const later = projectPlayer(player, { currentGameweek: 10, horizon: 1, expectedMinutes: 90 });
    expect(later.components?.bonus).not.toBeCloseTo(early.components?.bonus ?? 0, 10);
  });

  it("holds cards closer to the previous season than bonus, at the same appearance count", () => {
    // Cards carry the rare-event weight, so ten appearances buy 10/50 of the
    // blend where bonus gets 10/20. Same player, same appearances, both stats
    // running at exactly twice their previous-season rate: bonus should have
    // travelled most of the way to the new rate while cards still lag.
    const doubling = (appearances: number): Player => midfielder({
      historical: { season: "2024/25", minutes: 3000, bonus: 3, yellowCards: 2 },
      current: {
        totalPoints: 10,
        minutes: appearances * 90,
        goals: 0,
        assists: 0,
        cleanSheets: 0,
        bonus: (3 / 3000) * appearances * 90 * 2,
        yellowCards: (2 / 3000) * appearances * 90 * 2,
      },
    });
    const project = (appearances: number) => projectPlayer(doubling(appearances), {
      currentGameweek: 11,
      horizon: 1,
      expectedMinutes: 90,
      playerForm: { 1: fullMatches(appearances) },
    });
    // A hair above zero appearances: effectively the previous season alone.
    const anchored = project(0.0001);
    const tenGames = project(10);
    const travelled = (now: number, before: number) => Math.abs((now - before) / before);
    const bonusGap = travelled(tenGames.components!.bonus, anchored.components!.bonus);
    const cardGap = travelled(tenGames.components!.cards, anchored.components!.cards);
    // Both still short of the doubled rate, but bonus is much closer to it.
    expect(bonusGap).toBeLessThan(cardGap);
    expect(PLAYER_FORM_PRIOR_WEIGHT_RARE_EVENTS).toBeGreaterThan(PLAYER_FORM_PRIOR_WEIGHT_MATCHES);
  });
});
