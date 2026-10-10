import { describe, expect, it } from "vitest";
import { startChanceOf } from "@/lib/availability/startChance";
import type { Player } from "@/types/player";

type Input = Parameters<typeof startChanceOf>[0];

const player = (status: string, startProbability?: number, chanceOfPlaying: number | null = null): Input => ({
  status,
  chanceOfPlaying,
  selection: startProbability === undefined ? undefined : ({ startProbability } as Player["selection"]),
});

describe("startChanceOf", () => {
  it("returns the selection model's start probability for an available player", () => {
    expect(startChanceOf(player("a", 0.92))).toBe(0.92);
  });

  it("keeps the model's probability for a doubtful player", () => {
    expect(startChanceOf(player("d", 0.6, 50))).toBe(0.6);
  });

  it.each(["i", "s", "u", "n"])("is 0 for status %s, whatever the selection model says", (status) => {
    expect(startChanceOf(player(status, 0.9))).toBe(0);
  });

  it("is 0 when the chance of playing is 0, whatever the selection model says", () => {
    expect(startChanceOf(player("a", 0.9, 0))).toBe(0);
  });

  it("is undefined when the selection model has no evidence for the player", () => {
    expect(startChanceOf(player("a"))).toBeUndefined();
  });
});
