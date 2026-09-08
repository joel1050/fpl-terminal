import { describe, expect, it } from "vitest";
import {
  blendPlayerRate,
  blendPlayerRateByMinutes,
  PLAYER_FORM_DECAY,
  PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
  PLAYER_FORM_WINSOR_RATIO,
} from "@/lib/projections/playerForm";

describe("blendPlayerRateByMinutes", () => {
  it("returns the prior untouched when a player has no match history", () => {
    expect(blendPlayerRateByMinutes([], 0.3)).toBe(0.3);
  });

  it("returns the prior when every match in the history is a zero-minute row", () => {
    expect(blendPlayerRateByMinutes([{ value: 0, minutes: 0 }], 0.3)).toBe(0.3);
  });

  it("matches blendPlayerRate when every match is a full ninety", () => {
    const samples = [
      { value: 0.4, minutes: 90 },
      { value: 0.6, minutes: 90 },
      { value: 0.2, minutes: 90 },
    ];
    const rates = samples.map((sample) => (sample.value / sample.minutes) * 90);
    expect(blendPlayerRateByMinutes(samples, 0.4)).toBeCloseTo(blendPlayerRate(rates, 0.4), 10);
  });

  it("gives a cameo a cameo's worth of weight, where the per-match average does not", () => {
    // Three full games at exactly the prior pace, then one shot in eight minutes.
    const samples = [
      { value: 0.5, minutes: 90 },
      { value: 0.5, minutes: 90 },
      { value: 0.5, minutes: 90 },
      { value: 0.1, minutes: 8 },
    ];
    const rates = samples.map((sample) => (sample.value / sample.minutes) * 90);
    const perMatch = blendPlayerRate(rates, 0.5);
    const perMinute = blendPlayerRateByMinutes(samples, 0.5);
    // The cameo's 1.13/90 pace drags the per-match average well above the prior.
    expect(perMatch).toBeGreaterThan(0.54);
    // Eight minutes cannot move a 278-minute sample far.
    expect(perMinute).toBeLessThan(0.51);
    expect(perMinute).toBeGreaterThan(0.5);
  });

  it("still counts the anchor in matches, so the prior's pull is unchanged", () => {
    // One match, so effective matches is 1 and the prior keeps W/(W+1) of the blend.
    const sample = [{ value: 1.0, minutes: 90 }];
    const prior = 0.5;
    const blended = blendPlayerRateByMinutes(sample, prior);
    const capped = Math.min(1.0, prior * PLAYER_FORM_WINSOR_RATIO);
    const expected = (prior * PLAYER_FORM_PRIOR_WEIGHT_MATCHES + capped)
      / (PLAYER_FORM_PRIOR_WEIGHT_MATCHES + 1);
    expect(blended).toBeCloseTo(expected, 10);
  });

  it("weights the most recent match most heavily", () => {
    const improving = [{ value: 0.2, minutes: 90 }, { value: 0.8, minutes: 90 }];
    const declining = [{ value: 0.8, minutes: 90 }, { value: 0.2, minutes: 90 }];
    expect(blendPlayerRateByMinutes(improving, 0.5))
      .toBeGreaterThan(blendPlayerRateByMinutes(declining, 0.5));
  });

  it("winsorises an extreme spike to 2.5x prior", () => {
    const prior = 0.4;
    const spike = [{ value: 3.0, minutes: 90 }]; // 7.5x prior
    const equivalent = [{ value: prior * PLAYER_FORM_WINSOR_RATIO, minutes: 90 }];
    expect(blendPlayerRateByMinutes(spike, prior))
      .toBeCloseTo(blendPlayerRateByMinutes(equivalent, prior), 10);
  });

  it("leaves rates inside the winsor band untouched", () => {
    const prior = 0.4;
    const moderate = [{ value: 0.6, minutes: 90 }]; // 1.5x prior
    expect(blendPlayerRateByMinutes(moderate, prior)).toBe(
      blendPlayerRateByMinutes(moderate, prior, PLAYER_FORM_DECAY, PLAYER_FORM_PRIOR_WEIGHT_MATCHES, 0),
    );
  });
});
