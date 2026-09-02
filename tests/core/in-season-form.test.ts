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

  it("weights current form as matches / (matches + prior weight)", () => {
    const prior = { 1: { attack: 1, defence: 1 }, 2: { attack: 1, defence: 1 } };
    const history = {
      1: Array.from({ length: 12 }, () => ({ xgFor: 2, xgAgainst: 1 })),
      2: Array.from({ length: 12 }, () => ({ xgFor: 1, xgAgainst: 2 })),
    };
    const blended = blendInSeasonForm(prior, history);

    // With 12 matches against the default 12-match prior, current form is 50%.
    expect(blended[1].attack).toBeCloseTo((1 + 2 / 1.5) / 2, 10);
    expect(blended[1].defence).toBeCloseTo((1 + 1.5 / 1) / 2, 10);
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

  it("schedule-adjusts team xG by opponent strength when opponent is known", () => {
    const prior = {
      1: { attack: 1.0, defence: 1.0 },
      2: { attack: 1.0, defence: 1.25 }, // Tough defence
      3: { attack: 1.0, defence: 0.8 },  // Weak defence
      4: { attack: 1.0, defence: 1.0 },  // Neutral benchmark
    };
    const neutralMatch = { xgFor: 1.35, xgAgainst: 1.35, opponentTeamId: 4 };
    // Team 1 creates 1.5 xG against a tough defence (Team 2) vs weak defence (Team 3)
    const toughHistory = {
      1: [{ xgFor: 1.5, xgAgainst: 1.0, opponentTeamId: 2 }],
      4: [neutralMatch],
    };
    const weakHistory = {
      1: [{ xgFor: 1.5, xgAgainst: 1.0, opponentTeamId: 3 }],
      4: [neutralMatch],
    };

    const toughBlend = blendInSeasonForm(prior, toughHistory, 0.9, 12);
    const weakBlend = blendInSeasonForm(prior, weakHistory, 0.9, 12);

    // Creating 1.5 xG against a 1.25 defence produces a higher attack rating than against a 0.8 defence
    expect(toughBlend[1].attack).toBeGreaterThan(weakBlend[1].attack);
  });
});
