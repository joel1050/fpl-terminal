import { describe, expect, it } from "vitest";
import {
  blendPlayerRate,
  PLAYER_FORM_DECAY,
  PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
  PLAYER_FORM_WINSOR_RATIO,
} from "@/lib/projections/playerForm";

describe("blendPlayerRate", () => {
  it("returns the prior untouched when a player has no match history", () => {
    expect(blendPlayerRate([], 0.3)).toBe(0.3);
  });

  it("uses the selected 0.95/10 model by default", () => {
    const effectiveMatches = (1 - PLAYER_FORM_DECAY ** 38) / (1 - PLAYER_FORM_DECAY);
    const expected = effectiveMatches / (PLAYER_FORM_PRIOR_WEIGHT_MATCHES + effectiveMatches);
    expect(blendPlayerRate(Array(38).fill(1), 0)).toBeCloseTo(expected, 12);
    expect(expected).toBeCloseTo(0.632, 3);
  });

  it("moves toward observed form as matches accumulate, without fully discarding the prior", () => {
    const hotStreak = Array.from({ length: 6 }, () => 1.2); // well above the 0.3 prior
    const blended = blendPlayerRate(hotStreak, 0.3, 0.9, 24);
    expect(blended).toBeGreaterThan(0.3);
    // This explicit heavy prior keeps 6 matches of form from
    // fully overriding the position/historical prior.
    expect(blended).toBeLessThan(0.6);
  });

  it("weighs the most recently played match more than an older one", () => {
    const recentlyHot = [0.1, 1.0]; // oldest first: cold, then hot
    const recentlyCold = [1.0, 0.1]; // oldest first: hot, then cold
    const hot = blendPlayerRate(recentlyHot, 0.3, 0.7, 3);
    const cold = blendPlayerRate(recentlyCold, 0.3, 0.7, 3);
    expect(hot).toBeGreaterThan(cold);
  });

  it("chasing only the last match or two underperforms trusting the prior more heavily (per the backtest)", () => {
    // A single noisy match (a fluke hat-trick) should not swing the blend
    // nearly as much under the explicit heavy prior weight as under a much
    // smaller one - this is the core, counterintuitive finding: a low prior
    // weight overreacts to single-match variance.
    const flukeMatch = [1.5];
    const heavilyAnchored = blendPlayerRate(flukeMatch, 0.3, 0.9, 24);
    const lightlyAnchored = blendPlayerRate(flukeMatch, 0.3, 0.9, 2);
    expect(heavilyAnchored - 0.3).toBeLessThan(lightlyAnchored - 0.3);
  });

  it("winsorises extreme rate spikes to 2.5x prior", () => {
    const prior = 0.4;
    // 3.0 is 7.5x prior, well beyond the 2.5x cap (1.0)
    const uncappedObserved = [3.0];
    const blendedWithCap = blendPlayerRate(uncappedObserved, prior);
    const blendedEquivalent = blendPlayerRate([prior * PLAYER_FORM_WINSOR_RATIO], prior);
    expect(blendedWithCap).toBeCloseTo(blendedEquivalent, 10);
  });

  it("floors extreme cold streaks to prior / 2.5", () => {
    const prior = 0.5;
    // 0 is well below the 0.2 floor (0.5 / 2.5)
    const zeroForm = [0.0];
    const blendedWithFloor = blendPlayerRate(zeroForm, prior);
    const blendedEquivalent = blendPlayerRate([prior / PLAYER_FORM_WINSOR_RATIO], prior);
    expect(blendedWithFloor).toBeCloseTo(blendedEquivalent, 10);
  });

  it("leaves rates within [prior / 2.5, prior * 2.5] uncapped", () => {
    const prior = 0.4;
    const moderateRate = [0.6]; // 1.5x prior, well inside [0.16, 1.0]
    const blendedNormal = blendPlayerRate(moderateRate, prior);
    const blendedUnconstrained = blendPlayerRate(moderateRate, prior, PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES, 0);
    expect(blendedNormal).toBe(blendedUnconstrained);
  });
});
