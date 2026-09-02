import { describe, expect, it } from "vitest";
import { blendCameoRate, blendStartRate, START_RATE_ALPHA, type StartObservation } from "@/lib/availability/startRate";

const started = (count: number): StartObservation[] =>
  Array.from({ length: count }, () => ({ started: true, appeared: true }));
const benched = (count: number): StartObservation[] =>
  Array.from({ length: count }, () => ({ started: false, appeared: false }));

describe("blendStartRate", () => {
  it("walks a 20% starter up the intended curve over five starts", () => {
    // p(n) = 0.6 * p(n-1) + 0.4 * startedThisMatch, seeded at 0.20.
    const expected = [0.52, 0.712, 0.8272, 0.89632, 0.937792];
    for (let matches = 1; matches <= 5; matches += 1) {
      expect(blendStartRate(0.2, started(matches))).toBeCloseTo(expected[matches - 1], 6);
    }
  });

  it("returns the seed untouched before any fixture is played", () => {
    expect(blendStartRate(0.2, [])).toBe(0.2);
  });

  it("drops a nailed starter fast when the role is lost", () => {
    const nailed = blendStartRate(0.2, started(5));
    expect(nailed).toBeGreaterThan(0.93);
    // One benching is worth far more than its share of the season: this is the
    // responsiveness the fixed alpha is chosen for, not a bug.
    expect(blendStartRate(0.2, [...started(5), ...benched(1)])).toBeCloseTo(nailed * 0.6, 6);
    expect(blendStartRate(0.2, [...started(5), ...benched(3)])).toBeLessThan(0.25);
  });

  it("weights a recent benching more heavily than an early one", () => {
    const benchedEarly = blendStartRate(0.5, [...benched(1), ...started(4)]);
    const benchedLate = blendStartRate(0.5, [...started(4), ...benched(1)]);
    expect(benchedEarly).toBeGreaterThan(benchedLate);
  });

  it("takes a slower path at a lower alpha", () => {
    expect(blendStartRate(0.2, started(1), 0.3)).toBeCloseTo(0.44, 6);
    expect(blendStartRate(0.2, started(1), 0.7)).toBeCloseTo(0.76, 6);
    expect(START_RATE_ALPHA).toBe(0.4);
  });

  it("clamps a seed outside 0-1", () => {
    expect(blendStartRate(1.4, [])).toBe(1);
    expect(blendStartRate(-0.3, [])).toBe(0);
  });
});

describe("blendCameoRate", () => {
  it("collapses the cameo rate when a player stops being in the squad", () => {
    const observations = [...benched(8)];
    expect(blendCameoRate(0.2, 0.3, observations)).toBeLessThan(0.01);
  });

  it("reads a bench player who keeps coming on as a cameo, not a starter", () => {
    const cameos: StartObservation[] = Array.from({ length: 8 }, () => ({ started: false, appeared: true }));
    expect(blendStartRate(0.5, cameos)).toBeLessThan(0.01);
    expect(blendCameoRate(0.5, 0.2, cameos)).toBeGreaterThan(0.98);
  });

  it("never returns a cameo rate that overlaps the start rate", () => {
    const mixed: StartObservation[] = [
      { started: true, appeared: true },
      { started: false, appeared: true },
      { started: true, appeared: true },
    ];
    const start = blendStartRate(0.4, mixed);
    const cameo = blendCameoRate(0.4, 0.3, mixed);
    expect(cameo).toBeGreaterThanOrEqual(0);
    expect(start + cameo).toBeLessThanOrEqual(1);
  });
});
