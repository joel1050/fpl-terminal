import { describe, expect, it } from "vitest";
import { projectPlayer } from "@/lib/projections/projectPlayer";
import { expectedPoints, playerRates } from "@/scripts/backtest/xp";
import { BASELINE } from "@/scripts/backtest/variants";
import type { Player, Position } from "@/types/player";
import type { PlayerMatchRate, ProjectionComponents, TeamStrength } from "@/types/projection";

const GAMEWEEK = 12;
const fixture = {
  gameweek: GAMEWEEK,
  opponentTeamId: 2,
  opponentShortName: "OPP",
  isHome: true,
  difficulty: 2,
} as const;

const strengths: Record<number, TeamStrength> = {
  1: { teamId: 1, attackHome: 1.12, attackAway: 1.08, defenceHome: 1.04, defenceAway: 1.01, overall: 1.06 },
  2: { teamId: 2, attackHome: 0.96, attackAway: 0.92, defenceHome: 0.95, defenceAway: 0.91, overall: 0.94 },
  3: { teamId: 3, attackHome: 0.96, attackAway: 0.92, defenceHome: 0.95, defenceAway: 0.91, overall: 0.94 },
};

function player(id: number, position: Position, historical: boolean): Player {
  return {
    id,
    firstName: "Parity",
    lastName: position,
    displayName: `Parity ${position}`,
    teamId: 1,
    teamName: "Test",
    teamShortName: "TST",
    position,
    priceTenths: position === "MID" ? 60 : position === "FWD" ? 75 : 50,
    ownership: 0,
    status: "a",
    current: {
      totalPoints: 30,
      minutes: 540,
      goals: 2,
      assists: 3,
      cleanSheets: 2,
      bonus: 4,
      saves: position === "GK" ? 24 : 0,
      expectedGoals: 1.8,
      expectedAssists: 1.2,
      defensiveContribution: position === "GK" ? 0 : 48,
      yellowCards: 2,
      redCards: 0,
    },
    historical: historical ? {
      season: "2025/26",
      minutes: 1_800,
      starts: 20,
      goals: 4,
      assists: 5,
      expectedGoals: 3.6,
      expectedAssists: 2.4,
      bonus: 12,
      saves: position === "GK" ? 72 : 0,
      defensiveContribution: position === "GK" ? 0 : 160,
      yellowCards: 5,
      redCards: 1,
    } : undefined,
    fixtures: [fixture],
  };
}

const form: readonly PlayerMatchRate[] = [
  { xg: 0.1, xa: 0.05, minutes: 30 },
  { xg: 0.7, xa: 0.2, minutes: 90 },
  { xg: 0.3, xa: 0.4, minutes: 75 },
];

function productionComponents(
  candidate: Player,
  minutes: number,
  playerForm?: readonly PlayerMatchRate[],
): ProjectionComponents {
  const projection = projectPlayer(candidate, {
    currentGameweek: GAMEWEEK,
    horizon: 1,
    expectedMinutes: minutes,
    teamStrengths: strengths,
    playerForm: playerForm ? { [candidate.id]: playerForm } : undefined,
  });
  const components = projection.fixtures[0]?.components;
  if (!components) throw new Error("Expected fixture components");
  return components;
}

describe("backtest harness parity", () => {
  it.each([
    ["GK", true, undefined],
    ["DEF", true, form],
    ["MID", true, undefined],
    ["FWD", false, form],
  ] as const)("matches production component by component for %s", (position, historical, playerForm) => {
    const candidate = player(position === "GK" ? 1 : position === "DEF" ? 2 : position === "MID" ? 3 : 4, position, historical);
    const minutes = position === "GK" ? 90 : position === "DEF" ? 84 : position === "MID" ? 78 : 72;
    const production = productionComponents(candidate, minutes, playerForm);
    const harness = expectedPoints(
      candidate,
      fixture,
      minutes,
      playerRates(candidate, playerForm, GAMEWEEK, undefined, strengths),
      strengths,
      BASELINE,
    );

    for (const key of Object.keys(production) as (keyof ProjectionComponents)[]) {
      expect(harness[key], key).toBeCloseTo(production[key], 12);
    }
  });

  it("lets bonus follow fixture difficulty", () => {
    const easy = { ...fixture, opponentTeamId: 2, difficulty: 1 };
    const hard = { ...fixture, opponentTeamId: 3, difficulty: 5 };
    const candidate = { ...player(5, "MID", true), fixtures: [easy, hard] };
    const projection = projectPlayer(candidate, {
      currentGameweek: GAMEWEEK,
      horizon: 1,
      expectedMinutes: 90,
      teamStrengths: strengths,
    });

    expect(projection.fixtures[0]?.components?.bonus).toBeGreaterThan(
      projection.fixtures[1]?.components?.bonus ?? Number.POSITIVE_INFINITY,
    );
  });
});
