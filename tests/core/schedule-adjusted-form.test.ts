import { describe, expect, it } from "vitest";
import type { Player } from "@/types/player";
import type { PlayerMatchRate, TeamStrength } from "@/types/projection";
import { projectPlayer } from "@/lib/projections";
import { blendPlayerRate, PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES } from "@/lib/projections/playerForm";
import { HOME_ATTACK_MULTIPLIER } from "@/lib/projections/fixtureAdjustment";

// Both sides exactly average, so ownAttack / opponentDefence is 1 and the only
// surviving term is the home venue multiplier. That makes every match's
// multiplier exactly HOME_ATTACK_MULTIPLIER and the anchor divisor exactly 1,
// so the expected rate can be written down rather than recomputed by the code
// under test.
const neutral = (teamId: number): TeamStrength => ({
  teamId, attackHome: 1, attackAway: 1, defenceHome: 1, defenceAway: 1, overall: 1,
});
const strengths: Record<number, TeamStrength> = { 1: neutral(1), 2: neutral(2) };

const GOAL_CONVERSION_FWD = 0.988;
const GOAL_POINTS_FWD = 4;

function striker(form: PlayerMatchRate[]): { player: Player; form: PlayerMatchRate[] } {
  const player: Player = {
    id: 7,
    firstName: "Test",
    lastName: "Striker",
    displayName: "Test Striker",
    teamId: 1,
    teamName: "Test",
    teamShortName: "TST",
    position: "FWD",
    priceTenths: 100,
    ownership: 0,
    status: "a",
    current: { totalPoints: 0, minutes: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0 },
    // Anchor rate: 9 xG in 900 minutes = 0.9 per 90.
    historical: { season: "prev", minutes: 900, expectedGoals: 9, expectedAssists: 0 },
    fixtures: [{ gameweek: 1, opponentTeamId: 2, opponentShortName: "OPP", isHome: true, difficulty: 3 }],
  } as Player;
  return { player, form };
}

const goalsFor = (player: Player, form: PlayerMatchRate[]) =>
  projectPlayer(player, {
    currentGameweek: 1,
    horizon: 1,
    expectedMinutes: 90,
    teamStrengths: strengths,
    playerForm: { 7: form },
  }).components!.goals;

describe("schedule-adjusted form", () => {
  it("divides each match out by the fixture it was played in", () => {
    const matches: PlayerMatchRate[] = [0.5, 0.5, 0.5].map((xg) => ({
      xg, xa: 0, minutes: 90, opponentTeamId: 2, wasHome: true,
    }));
    const { player, form } = striker(matches);

    // Every match was played at the same multiplier, so the normalized rate is
    // 0.5 / HOME_ATTACK_MULTIPLIER; the 0.9 anchor is divided by ownAttack = 1.
    const expectedRate = blendPlayerRate(
      matches.map(() => 0.5 / HOME_ATTACK_MULTIPLIER),
      0.9,
      PLAYER_FORM_DECAY,
      PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
    );

    expect(goalsFor(player, form)).toBeCloseTo(
      expectedRate * GOAL_CONVERSION_FWD * HOME_ATTACK_MULTIPLIER * GOAL_POINTS_FWD,
      8,
    );
  });

  it("counts the fixture once: a soft run no longer inflates the projection", () => {
    const soft = [0.5, 0.5, 0.5].map((xg) => ({ xg, xa: 0, minutes: 90, opponentTeamId: 2, wasHome: true }));

    const adjusted = goalsFor(striker(soft).player, soft);
    const unadjusted = goalsFor(
      striker(soft).player,
      soft.map((m) => ({ xg: m.xg, xa: m.xa, minutes: m.minutes })),
    );

    expect(adjusted).toBeLessThan(unadjusted);
  });

  it("falls back to the raw blend when a match has no fixture context", () => {
    const bare: PlayerMatchRate[] = [{ xg: 0.5, xa: 0, minutes: 90 }];
    const { player, form } = striker(bare);

    const expectedRate = blendPlayerRate([0.5], 0.9, PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES);

    expect(goalsFor(player, form)).toBeCloseTo(
      expectedRate * GOAL_CONVERSION_FWD * HOME_ATTACK_MULTIPLIER * GOAL_POINTS_FWD,
      8,
    );
  });

  it("falls back to the raw blend when the opponent has no strength entry", () => {
    const unknownOpponent: PlayerMatchRate[] = [
      { xg: 0.5, xa: 0, minutes: 90, opponentTeamId: 99, wasHome: true },
    ];
    const { player, form } = striker(unknownOpponent);

    const expectedRate = blendPlayerRate([0.5], 0.9, PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES);

    expect(goalsFor(player, form)).toBeCloseTo(
      expectedRate * GOAL_CONVERSION_FWD * HOME_ATTACK_MULTIPLIER * GOAL_POINTS_FWD,
      8,
    );
  });
});
