import { describe, expect, it } from "vitest";
import {
  deduplicateHistoricalFixtureRows,
  recordedFixtureOutcome,
  rowsBeforeGameweek,
} from "@/scripts/backtest/historicalBacktest";

const row = (fixtureId: number, gameweek: number, minutes: number) => ({
  historicalPlayerId: 7,
  fixtureId,
  gameweek,
  minutes,
  totalPoints: minutes > 0 ? 2 : 0,
});

describe("historical backtest guards", () => {
  it("deduplicates identical player-fixture rows and rejects conflicts, including a changed Gameweek", () => {
    const source = row(22, 4, 0);
    expect(deduplicateHistoricalFixtureRows([source, { ...source }]))
      .toEqual({ rows: [source], duplicatesRemoved: 1 });
    expect(() => deduplicateHistoricalFixtureRows([source, { ...source, minutes: 90 }]))
      .toThrow(/conflicting prepared duplicate 7:22/);
    expect(() => deduplicateHistoricalFixtureRows([source, { ...source, gameweek: 5 }]))
      .toThrow(/conflicting prepared duplicate 7:22/);
  });

  it("keeps target and future outcomes out of pre-Gameweek evidence", () => {
    const prior = row(1, 2, 90);
    const target = row(2, 3, 0);
    const future = row(3, 4, 90);
    expect(rowsBeforeGameweek([prior, target], 3)).toEqual([prior]);
    expect(rowsBeforeGameweek([prior, target, future], 3)).toEqual([prior]);
    expect(rowsBeforeGameweek([prior, target], 3)).toEqual(rowsBeforeGameweek([prior, target, { ...future, minutes: 0 }], 3));
    expect(() => rowsBeforeGameweek([prior], 0)).toThrow(/positive integer/);
  });

  it("counts an explicit zero-minute row as a DNP and leaves absent rows unknown", () => {
    expect(recordedFixtureOutcome(0)).toBe("DNP");
    expect(recordedFixtureOutcome(1)).toBe("PLAYED");
    expect(recordedFixtureOutcome(undefined)).toBe("NOT_RECORDED");
    expect(() => recordedFixtureOutcome(-1)).toThrow(/finite and non-negative/);
  });
});
