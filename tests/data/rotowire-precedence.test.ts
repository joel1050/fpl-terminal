import { describe, expect, it } from "vitest";
import type { Player } from "@/types/player";
import { buildPlayerSelections } from "@/lib/availability/selection";

function player(overrides: Partial<Player> = {}): Player {
  return {
    id: 1,
    firstName: "Test",
    lastName: "Starter",
    displayName: "Test Starter",
    teamId: 1,
    teamName: "Test",
    teamShortName: "TST",
    position: "MID",
    priceTenths: 60,
    ownership: 5,
    status: "a",
    current: { totalPoints: 40, goals: 2, assists: 2, cleanSheets: 3, bonus: 3, minutes: 900 },
    fixtures: [],
    ...overrides,
  };
}

/** RotoWire records for our player, plus a teammate so the team counts as covered. */
function rotowire(...records: Record<string, unknown>[]) {
  return {
    snapshot: { fetchedAt: "2026-08-26T00:00:00.000Z" },
    mappings: [
      ...(records.length ? records : [{}]).map((r) => ({ playerId: 1, source: "STARTER", lineupStatus: "PREDICTED", ...r })),
      { playerId: 2, source: "STARTER", lineupStatus: "PREDICTED" },
    ],
  } as never;
}

/** A player RotoWire names in the XI and also flags as a doubt. */
const STARTER_AND_QUES = [{}, { source: "UNAVAILABLE", availabilityStatus: "QUES", lineupStatus: undefined }];

const teammate = player({ id: 2, displayName: "Teammate" });

function startProbability(subject: Player, rotowireSource: ReturnType<typeof rotowire>): number {
  return buildPlayerSelections([subject, teammate], { rotowire: rotowireSource }).get(subject.id)!.startProbability;
}

describe("RotoWire precedence over correlated FPL signals", () => {
  it("keeps a predicted starter a likely starter when FPL calls him doubtful", () => {
    const doubtful = startProbability(
      player({ status: "d", chanceOfPlaying: 75 }),
      rotowire({}),
    );
    // Multiplying the RotoWire blend by 0.75 used to land near 0.67 and, with
    // RotoWire's own QUES on top, near 0.43. He is still the named starter.
    expect(doubtful).toBeGreaterThanOrEqual(0.62);
    expect(doubtful).toBeLessThan(startProbability(player(), rotowire({})));
  });

  it("counts one injury once when RotoWire and FPL both report it", () => {
    const healthy = startProbability(player(), rotowire({}));
    const bothFlags = startProbability(
      player({ status: "d", chanceOfPlaying: 75 }),
      rotowire(...STARTER_AND_QUES),
    );
    // The old code multiplied both discounts: 0.825 * 0.65 * 0.75 = 0.402,
    // turning RotoWire's named starter into a rotation risk.
    expect(bothFlags).toBeGreaterThan(healthy * 0.65 * 0.75);
    expect(bothFlags).toBeLessThan(healthy);
  });

  it("never lets a predicted lineup override an FPL ruling-out", () => {
    for (const status of ["i", "u", "n", "s"]) {
      const out = startProbability(
        player({ status, chanceOfPlaying: 0 }),
        rotowire({}),
      );
      expect(out, `status ${status} must stay ruled out`).toBeLessThanOrEqual(0.01);
    }
  });

  it("rules out a named starter RotoWire itself flags OUT or suspended", () => {
    for (const availabilityStatus of ["OUT", "SUS"]) {
      const gated = startProbability(
        player(),
        rotowire({}, { source: "UNAVAILABLE", availabilityStatus, lineupStatus: undefined }),
      );
      expect(gated, `${availabilityStatus} must gate hard`).toBeLessThanOrEqual(0.01);
    }
  });

  it("holds a confirmed team sheet higher than a predicted one", () => {
    const confirmed = startProbability(
      player({ status: "d", chanceOfPlaying: 50 }),
      rotowire({ lineupStatus: "CONFIRMED" }),
    );
    const predicted = startProbability(
      player({ status: "d", chanceOfPlaying: 50 }),
      rotowire({}),
    );
    expect(confirmed).toBeGreaterThan(predicted);
  });

  it("leaves a healthy predicted starter untouched", () => {
    // 0.90 RotoWire * 0.75 + 0.60 current-minutes fallback * 0.25 = 0.825
    expect(startProbability(player(), rotowire({}))).toBeCloseTo(0.825, 3);
  });
});
