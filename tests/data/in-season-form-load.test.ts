import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSnapshot } from "@/lib/fpl/cache";

const mocks = vi.hoisted(() => ({ getLiveGameweek: vi.fn() }));
vi.mock("@/lib/fpl/client", () => ({ getLiveGameweek: mocks.getLiveGameweek }));

describe("loadInSeasonTeamXG", () => {
  let directory: string;
  let previous: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "fpl-in-season-xg-"));
    previous = process.env.FPL_SNAPSHOT_DIR;
    process.env.FPL_SNAPSHOT_DIR = directory;
    mocks.getLiveGameweek.mockReset();
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.FPL_SNAPSHOT_DIR;
    else process.env.FPL_SNAPSHOT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  it("aggregates complete single-fixture gameweeks and skips partial or double gameweeks", async () => {
    mocks.getLiveGameweek.mockResolvedValueOnce({
      data: {
        elements: [
          { id: 1, stats: { expected_goals: "0.80" } }, // team 1
          { id: 2, stats: { expected_goals: "0.40" } }, // team 1
          { id: 3, stats: { expected_goals: "1.10" } }, // team 2
        ],
      },
      freshness: null,
    });

    const { loadInSeasonTeamXG } = await import("@/lib/historical/loadInSeasonForm");
    const players = [
      { id: 1, teamId: 1 }, { id: 2, teamId: 1 }, { id: 3, teamId: 2 },
    ];
    const fixtures = [
      { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
      { gameweek: 2, teamHomeId: 1, teamAwayId: 2, finished: true },
      { gameweek: 2, teamHomeId: 3, teamAwayId: 4, finished: false },
      { gameweek: 3, teamHomeId: 1, teamAwayId: 2, finished: true },
      { gameweek: 3, teamHomeId: 3, teamAwayId: 1, finished: true },
    ];

    const history = await loadInSeasonTeamXG(players, fixtures);

    expect(history[1]?.[0]?.xgFor).toBeCloseTo(1.2, 10);
    expect(history[1]?.[0]?.xgAgainst).toBeCloseTo(1.1, 10);
    expect(history[2]?.[0]?.xgFor).toBeCloseTo(1.1, 10);
    expect(history[2]?.[0]?.xgAgainst).toBeCloseTo(1.2, 10);
    expect(mocks.getLiveGameweek).toHaveBeenCalledTimes(1);
    expect(mocks.getLiveGameweek).toHaveBeenCalledWith(1);
  });

  it("never re-fetches a finished gameweek once its aggregate is persisted", async () => {
    mocks.getLiveGameweek.mockResolvedValueOnce({
      data: { elements: [{ id: 1, stats: { expected_goals: "1.00" } }, { id: 2, stats: { expected_goals: "0.50" } }] },
      freshness: null,
    });
    const { loadInSeasonTeamXG } = await import("@/lib/historical/loadInSeasonForm");
    const players = [{ id: 1, teamId: 1 }, { id: 2, teamId: 2 }];
    const fixtures = [{ gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true }];

    await loadInSeasonTeamXG(players, fixtures);
    await loadInSeasonTeamXG(players, fixtures);

    expect(mocks.getLiveGameweek).toHaveBeenCalledTimes(1);
  });

  it("replaces an incomplete snapshot after the gameweek finishes", async () => {
    await writeSnapshot("in-season-xg-gw-1", [{ teamId: 1, xgFor: 0.4, xgAgainst: 0 }]);
    mocks.getLiveGameweek.mockResolvedValueOnce({
      data: { elements: [{ id: 1, stats: { expected_goals: "1.00" } }, { id: 2, stats: { expected_goals: "0.50" } }] },
      freshness: null,
    });
    const { loadInSeasonTeamXG } = await import("@/lib/historical/loadInSeasonForm");

    const history = await loadInSeasonTeamXG(
      [{ id: 1, teamId: 1 }, { id: 2, teamId: 2 }],
      [{ gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true }],
    );

    expect(history[1]?.[0]).toEqual({ xgFor: 1, xgAgainst: 0.5 });
    expect(mocks.getLiveGameweek).toHaveBeenCalledTimes(1);
  });
});

describe("loadInSeasonPlayerRates", () => {
  let directory: string;
  let previous: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "fpl-in-season-player-rates-"));
    previous = process.env.FPL_SNAPSHOT_DIR;
    process.env.FPL_SNAPSHOT_DIR = directory;
    mocks.getLiveGameweek.mockReset();
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.FPL_SNAPSHOT_DIR;
    else process.env.FPL_SNAPSHOT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  it("records only players who featured, in chronological order, and skips double gameweeks", async () => {
    // gw1 and gw2 are both eligible here, so loadInSeasonPlayerRates fetches
    // them concurrently via Promise.all - mockResolvedValueOnce only
    // guarantees *call* order, not resolution order under concurrent
    // awaits, so this must dispatch on the actual gameweek argument.
    const responsesByGameweek: Record<number, unknown> = {
      1: {
        data: {
          elements: [
            { id: 1, stats: { expected_goals: "0.30", expected_assists: "0.10", minutes: "90" } },
            { id: 2, stats: { expected_goals: "0.00", expected_assists: "0.00", minutes: "0" } }, // did not play
          ],
        },
        freshness: null,
      },
      2: {
        data: {
          elements: [
            { id: 1, stats: { expected_goals: "0.90", expected_assists: "0.05", minutes: "90" } },
          ],
        },
        freshness: null,
      },
    };
    mocks.getLiveGameweek.mockImplementation(async (gameweek: number) => responsesByGameweek[gameweek]);

    const { loadInSeasonPlayerRates } = await import("@/lib/historical/loadInSeasonForm");
    const fixtures = [
      { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
      { gameweek: 2, teamHomeId: 1, teamAwayId: 2, finished: true },
      { gameweek: 2, teamHomeId: 3, teamAwayId: 4, finished: true }, // team 1 not doubled here, gw2 still single
      { gameweek: 3, teamHomeId: 1, teamAwayId: 2, finished: false },
    ];

    const history = await loadInSeasonPlayerRates(fixtures);

    expect(history[1]).toEqual([
      { xg: 0.3, xa: 0.1, minutes: 90 },
      { xg: 0.9, xa: 0.05, minutes: 90 },
    ]);
    expect(history[2]).toBeUndefined();
    expect(mocks.getLiveGameweek).toHaveBeenCalledTimes(2);
  });

  it("never re-fetches a finished gameweek once its rates are persisted", async () => {
    mocks.getLiveGameweek.mockResolvedValueOnce({
      data: { elements: [{ id: 1, stats: { expected_goals: "0.5", expected_assists: "0.1", minutes: "90" } }] },
      freshness: null,
    });
    const { loadInSeasonPlayerRates } = await import("@/lib/historical/loadInSeasonForm");
    const fixtures = [{ gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true }];

    await loadInSeasonPlayerRates(fixtures);
    await loadInSeasonPlayerRates(fixtures);

    expect(mocks.getLiveGameweek).toHaveBeenCalledTimes(1);
  });
});
