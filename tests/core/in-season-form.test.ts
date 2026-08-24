import { describe, expect, it } from "vitest";
import { applyInSeasonForm, blendInSeasonForm } from "@/lib/historical/inSeasonForm";
import type { TeamStrength } from "@/types/projection";

describe("in-season form blending", () => {
  it("returns the prior untouched when a team has no match history", () => {
    const blended = blendInSeasonForm({ 1: { attack: 1.1, defence: 0.9 } }, {});
    expect(blended[1]).toEqual({ attack: 1.1, defence: 0.9 });
  });

  it("moves toward observed form as matches accumulate, without ever fully discarding the prior", () => {
    const prior = { 1: { attack: 1.0, defence: 1.0 }, 2: { attack: 1.0, defence: 1.0 } };
    // Team 1 has been scoring heavily and not conceding; team 2 is the mirror image.
    const history = {
      1: Array.from({ length: 6 }, () => ({ xgFor: 2.5, xgAgainst: 0.3 })),
      2: Array.from({ length: 6 }, () => ({ xgFor: 0.3, xgAgainst: 2.5 })),
    };
    const blended = blendInSeasonForm(prior, history, 0.9, 16);

    expect(blended[1].attack).toBeGreaterThan(prior[1].attack);
    expect(blended[1].defence).toBeGreaterThan(prior[1].defence);
    expect(blended[2].attack).toBeLessThan(prior[2].attack);
    expect(blended[2].defence).toBeLessThan(prior[2].defence);
    // A high prior weight (16 "matches worth") keeps 6 matches of form from
    // fully overriding the preseason read.
    expect(blended[1].attack).toBeLessThan(4);
  });

  it("weighs the most recent match more than an older one (recency, not a flat season average)", () => {
    const prior = { 1: { attack: 1.0, defence: 1.0 } };
    // Same two results, opposite order: recent-hot should out-rate recent-cold.
    const recentlyHot = { 1: [{ xgFor: 0.2, xgAgainst: 0.2 }, { xgFor: 3.0, xgAgainst: 0.2 }] };
    const recentlyCold = { 1: [{ xgFor: 3.0, xgAgainst: 0.2 }, { xgFor: 0.2, xgAgainst: 0.2 }] };

    const hot = blendInSeasonForm(prior, recentlyHot, 0.7, 3);
    const cold = blendInSeasonForm(prior, recentlyCold, 0.7, 3);

    expect(hot[1].attack).toBeGreaterThan(cold[1].attack);
  });

  it("never lets a shutout collapse a team's blended attack or defence to zero", () => {
    const prior = { 1: { attack: 1.0, defence: 1.0 } };
    const shutOut = { 1: [{ xgFor: 0, xgAgainst: 0 }] };
    const blended = blendInSeasonForm(prior, shutOut, 0.9, 0);
    expect(blended[1].attack).toBeGreaterThan(0);
    expect(blended[1].defence).toBeGreaterThan(0);
  });

  it("applyInSeasonForm keeps attack/defence venue-agnostic and derives overall from the blend", () => {
    const priorStrengths: Record<number, TeamStrength> = {
      1: { teamId: 1, attackHome: 1.2, attackAway: 1.2, defenceHome: 1.0, defenceAway: 1.0, overall: 1.1 },
    };
    const history = { 1: [{ xgFor: 2.0, xgAgainst: 0.5 }] };
    const result = applyInSeasonForm(priorStrengths, history, 0.9, 16);

    expect(result[1].attackHome).toBe(result[1].attackAway);
    expect(result[1].defenceHome).toBe(result[1].defenceAway);
    expect(result[1].overall).toBeCloseTo((result[1].attackHome + result[1].defenceHome) / 2, 10);
  });
});
