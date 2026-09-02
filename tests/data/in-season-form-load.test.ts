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

  it("aggregates each played fixture and excludes only the teams doubled in a gameweek", async () => {
    const responsesByGameweek: Record<number, unknown> = {
      1: { data: { elements: [
        { id: 1, stats: { expected_goals: "0.80" } }, // team 1
        { id: 2, stats: { expected_goals: "0.40" } }, // team 1
        { id: 3, stats: { expected_goals: "1.10" } }, // team 2
      ] }, freshness: null },
      2: { data: { elements: [
        { id: 1, stats: { expected_goals: "0.50" } }, // team 1
        { id: 3, stats: { expected_goals: "0.20" } }, // team 2
      ] }, freshness: null },
      3: { data: { elements: [{ id: 1, stats: { expected_goals: "0.90" } }] }, freshness: null },
    };
    mocks.getLiveGameweek.mockImplementation(async (gameweek: number) => responsesByGameweek[gameweek]);

    const { loadInSeasonTeamXG } = await import("@/lib/historical/loadInSeasonForm");
    const players = [
      { id: 1, teamId: 1 }, { id: 2, teamId: 1 }, { id: 3, teamId: 2 },
    ];
    const fixtures = [
      { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
      { gameweek: 2, teamHomeId: 1, teamAwayId: 2, finished: true },
      { gameweek: 2, teamHomeId: 3, teamAwayId: 4, finished: false }, // still to kick off
      { gameweek: 3, teamHomeId: 1, teamAwayId: 2, finished: true },
      { gameweek: 3, teamHomeId: 3, teamAwayId: 1, finished: true }, // team 1 doubled
    ];

    const history = await loadInSeasonTeamXG(players, fixtures);

    // gw1 in full, plus gw2's played fixture even though gw2 is unfinished.
    expect(history[1]?.[0]?.xgFor).toBeCloseTo(1.2, 10);
    expect(history[1]?.[0]?.xgAgainst).toBeCloseTo(1.1, 10);
    expect(history[1]?.[1]).toEqual({ xgFor: 0.5, xgAgainst: 0.2, opponentTeamId: 2, wasHome: true });
    expect(history[2]?.[0]?.xgFor).toBeCloseTo(1.1, 10);
    expect(history[2]?.[0]?.xgAgainst).toBeCloseTo(1.2, 10);
    expect(history[2]?.[1]).toEqual({ xgFor: 0.2, xgAgainst: 0.5, opponentTeamId: 1, wasHome: false });
    // gw3 contributes nothing: team 1 is doubled, so neither of its fixtures
    // has two eligible teams.
    expect(history[1]).toHaveLength(2);
  });

  it("rejects a zero-xG aggregate even when an excluded team in the same gameweek has xG", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: {
        elements: [
          { id: 1, stats: { expected_goals: "0.00" } }, // team 1, played, no xG
          { id: 3, stats: { expected_goals: "0.00" } }, // team 2, played, no xG
          { id: 9, stats: { expected_goals: "2.00" } }, // team 3, doubled, so excluded
        ],
      },
      freshness: null,
    });

    const { loadInSeasonTeamXG } = await import("@/lib/historical/loadInSeasonForm");
    const history = await loadInSeasonTeamXG(
      [{ id: 1, teamId: 1 }, { id: 3, teamId: 2 }, { id: 9, teamId: 3 }],
      [
        { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
        { gameweek: 1, teamHomeId: 3, teamAwayId: 4, finished: true },
        { gameweek: 1, teamHomeId: 3, teamAwayId: 5, finished: true }, // team 3 doubled
      ],
    );

    // Teams 1 and 2 must not be recorded as a scoreless shutout on the strength
    // of a team whose rows are not being written.
    expect(history[1]).toBeUndefined();
    expect(history[2]).toBeUndefined();
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

    expect(history[1]?.[0]).toEqual({ xgFor: 1, xgAgainst: 0.5, opponentTeamId: 2, wasHome: true });
    expect(mocks.getLiveGameweek).toHaveBeenCalledTimes(1);
  });

  it("aggregates a played fixture from a gameweek whose other fixtures have not kicked off", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: {
        elements: [
          { id: 1, stats: { expected_goals: "1.20" } }, // team 1, played
          { id: 3, stats: { expected_goals: "0.40" } }, // team 2, played
          { id: 5, stats: { expected_goals: "0.00" } }, // team 3, not played yet
        ],
      },
      freshness: null,
    });

    const { loadInSeasonTeamXG } = await import("@/lib/historical/loadInSeasonForm");
    const history = await loadInSeasonTeamXG(
      [{ id: 1, teamId: 1 }, { id: 3, teamId: 2 }, { id: 5, teamId: 3 }],
      [
        { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
        { gameweek: 1, teamHomeId: 3, teamAwayId: 4, finished: false },
      ],
    );

    expect(history[1]?.[0]).toEqual({ xgFor: 1.2, xgAgainst: 0.4, opponentTeamId: 2, wasHome: true });
    expect(history[2]?.[0]).toEqual({ xgFor: 0.4, xgAgainst: 1.2, opponentTeamId: 1, wasHome: false });
    expect(history[3]).toBeUndefined();
  });

  it("treats a provisionally finished fixture as played", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: { elements: [{ id: 1, stats: { expected_goals: "0.70" } }, { id: 2, stats: { expected_goals: "0.30" } }] },
      freshness: null,
    });

    const { loadInSeasonTeamXG } = await import("@/lib/historical/loadInSeasonForm");
    const history = await loadInSeasonTeamXG(
      [{ id: 1, teamId: 1 }, { id: 2, teamId: 2 }],
      [{ gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: false, finishedProvisional: true }],
    );

    expect(history[1]?.[0]).toEqual({ xgFor: 0.7, xgAgainst: 0.3, opponentTeamId: 2, wasHome: true });
  });

  it("does not persist a partially played gameweek", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: { elements: [{ id: 1, stats: { expected_goals: "1.20" } }, { id: 3, stats: { expected_goals: "0.40" } }] },
      freshness: null,
    });

    const { loadInSeasonTeamXG } = await import("@/lib/historical/loadInSeasonForm");
    const players = [{ id: 1, teamId: 1 }, { id: 3, teamId: 2 }];
    const fixtures = [
      { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
      { gameweek: 1, teamHomeId: 3, teamAwayId: 4, finished: false },
    ];

    await loadInSeasonTeamXG(players, fixtures);
    await loadInSeasonTeamXG(players, fixtures);

    expect(mocks.getLiveGameweek).toHaveBeenCalledTimes(2);
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

    const history = await loadInSeasonPlayerRates(
      [{ id: 1, teamId: 1 }, { id: 2, teamId: 2 }],
      fixtures,
    );

    // Each appearance carries the fixture it was played in, so projectPlayer can
    // divide the opponent back out before blending (calculations.md 6.3.2).
    expect(history[1]).toEqual([
      { xg: 0.3, xa: 0.1, minutes: 90, opponentTeamId: 2, wasHome: true },
      { xg: 0.9, xa: 0.05, minutes: 90, opponentTeamId: 2, wasHome: true },
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

    const players = [{ id: 1, teamId: 1 }];
    await loadInSeasonPlayerRates(players, fixtures);
    await loadInSeasonPlayerRates(players, fixtures);

    expect(mocks.getLiveGameweek).toHaveBeenCalledTimes(1);
  });

  it("records a player whose team has played while the rest of the gameweek is still to come", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: {
        elements: [
          { id: 1, stats: { expected_goals: "0.80", expected_assists: "0.20", minutes: "90" } }, // team 1, played
          { id: 5, stats: { expected_goals: "0.10", expected_assists: "0.00", minutes: "12" } }, // team 3, not played yet
        ],
      },
      freshness: null,
    });

    const { loadInSeasonPlayerRates } = await import("@/lib/historical/loadInSeasonForm");
    const history = await loadInSeasonPlayerRates(
      [{ id: 1, teamId: 1 }, { id: 5, teamId: 3 }],
      [
        { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
        { gameweek: 1, teamHomeId: 3, teamAwayId: 4, finished: false },
      ],
    );

    expect(history[1]).toEqual([{ xg: 0.8, xa: 0.2, minutes: 90, opponentTeamId: 2, wasHome: true }]);
    expect(history[5]).toBeUndefined();
  });

  it("excludes only the doubled team from a gameweek, not the whole gameweek", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: {
        elements: [
          { id: 1, stats: { expected_goals: "0.50", expected_assists: "0.10", minutes: "90" } }, // team 1, doubled
          { id: 3, stats: { expected_goals: "0.60", expected_assists: "0.20", minutes: "90" } }, // team 2, single
        ],
      },
      freshness: null,
    });

    const { loadInSeasonPlayerRates } = await import("@/lib/historical/loadInSeasonForm");
    const history = await loadInSeasonPlayerRates(
      [{ id: 1, teamId: 1 }, { id: 3, teamId: 2 }],
      [
        { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
        { gameweek: 1, teamHomeId: 1, teamAwayId: 4, finished: true },
      ],
    );

    expect(history[1]).toBeUndefined();
    // Team 2 played team 1 away; team 1 is the doubled side and is excluded.
    expect(history[3]).toEqual([{ xg: 0.6, xa: 0.2, minutes: 90, opponentTeamId: 1, wasHome: false }]);
  });

  it("does not persist a partially played gameweek", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: { elements: [{ id: 1, stats: { expected_goals: "0.80", expected_assists: "0.20", minutes: "90" } }] },
      freshness: null,
    });

    const { loadInSeasonPlayerRates } = await import("@/lib/historical/loadInSeasonForm");
    const players = [{ id: 1, teamId: 1 }];
    const fixtures = [
      { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
      { gameweek: 1, teamHomeId: 3, teamAwayId: 4, finished: false },
    ];

    await loadInSeasonPlayerRates(players, fixtures);
    await loadInSeasonPlayerRates(players, fixtures);

    expect(mocks.getLiveGameweek).toHaveBeenCalledTimes(2);
  });
});

describe("loadInSeasonStarts", () => {
  let directory: string;
  let previous: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "fpl-in-season-starts-"));
    previous = process.env.FPL_SNAPSHOT_DIR;
    process.env.FPL_SNAPSHOT_DIR = directory;
    mocks.getLiveGameweek.mockReset();
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.FPL_SNAPSHOT_DIR;
    else process.env.FPL_SNAPSHOT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  it("records a benched player as an observation rather than dropping him", async () => {
    // The whole point of a parallel loader: loadInSeasonPlayerRates skips
    // zero-minute players, which would leave a dropped player's start rate
    // frozen at whatever it was when he last featured.
    mocks.getLiveGameweek.mockResolvedValue({
      data: {
        elements: [
          { id: 1, stats: { minutes: "90" } },
          { id: 2, stats: { minutes: "0" } },
          { id: 3, stats: { minutes: "20" } },
          { id: 4, stats: { minutes: "59" } },
        ],
      },
      freshness: null,
    });

    const { loadInSeasonStarts } = await import("@/lib/historical/loadInSeasonForm");
    const history = await loadInSeasonStarts(
      [{ id: 1, teamId: 1 }, { id: 2, teamId: 1 }, { id: 3, teamId: 2 }, { id: 4, teamId: 2 }],
      [{ gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true }],
    );

    expect(history[1]).toEqual([{ started: true, appeared: true }]);
    expect(history[2]).toEqual([{ started: false, appeared: false }]);
    expect(history[3]).toEqual([{ started: false, appeared: true }]);
    // 59 minutes is a cameo under the 60-minute rule, not a start.
    expect(history[4]).toEqual([{ started: false, appeared: true }]);
  });

  it("counts exactly 60 minutes as a start", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: { elements: [{ id: 1, stats: { minutes: "60" } }] },
      freshness: null,
    });
    const { loadInSeasonStarts } = await import("@/lib/historical/loadInSeasonForm");
    const history = await loadInSeasonStarts(
      [{ id: 1, teamId: 1 }],
      [{ gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true }],
    );
    expect(history[1]).toEqual([{ started: true, appeared: true }]);
  });

  it("gives a blank gameweek no observation at all", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: { elements: [{ id: 1, stats: { minutes: "90" } }, { id: 9, stats: { minutes: "0" } }] },
      freshness: null,
    });
    const { loadInSeasonStarts } = await import("@/lib/historical/loadInSeasonForm");
    // Team 3 has no fixture in gameweek 1, so player 9 is not eligible and
    // must not be recorded as benched.
    const history = await loadInSeasonStarts(
      [{ id: 1, teamId: 1 }, { id: 9, teamId: 3 }],
      [{ gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true }],
    );
    expect(history[1]).toHaveLength(1);
    expect(history[9]).toBeUndefined();
  });

  it("ignores a gameweek where nobody played rather than caching phantom benchings", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: { elements: [{ id: 1, stats: { minutes: "0" } }, { id: 2, stats: { minutes: "0" } }] },
      freshness: null,
    });
    const { loadInSeasonStarts } = await import("@/lib/historical/loadInSeasonForm");
    const history = await loadInSeasonStarts(
      [{ id: 1, teamId: 1 }, { id: 2, teamId: 2 }],
      [{ gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true }],
    );
    expect(history[1]).toBeUndefined();
    expect(history[2]).toBeUndefined();
  });

  it("never re-fetches a finished gameweek once its starts are persisted", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: { elements: [{ id: 1, stats: { minutes: "90" } }] },
      freshness: null,
    });
    const { loadInSeasonStarts } = await import("@/lib/historical/loadInSeasonForm");
    const players = [{ id: 1, teamId: 1 }];
    const fixtures = [{ gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true }];

    await loadInSeasonStarts(players, fixtures);
    await loadInSeasonStarts(players, fixtures);

    expect(mocks.getLiveGameweek).toHaveBeenCalledTimes(1);
  });

  it("records a player whose team has played while the rest of the gameweek is still to come", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: {
        elements: [
          { id: 1, stats: { expected_goals: "0.80", expected_assists: "0.20", minutes: "90" } }, // team 1, played
          { id: 5, stats: { expected_goals: "0.10", expected_assists: "0.00", minutes: "12" } }, // team 3, not played yet
        ],
      },
      freshness: null,
    });

    const { loadInSeasonPlayerRates } = await import("@/lib/historical/loadInSeasonForm");
    const history = await loadInSeasonPlayerRates(
      [{ id: 1, teamId: 1 }, { id: 5, teamId: 3 }],
      [
        { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
        { gameweek: 1, teamHomeId: 3, teamAwayId: 4, finished: false },
      ],
    );

    expect(history[1]).toEqual([{ xg: 0.8, xa: 0.2, minutes: 90, opponentTeamId: 2, wasHome: true }]);
    expect(history[5]).toBeUndefined();
  });

  it("excludes only the doubled team from a gameweek, not the whole gameweek", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: {
        elements: [
          { id: 1, stats: { expected_goals: "0.50", expected_assists: "0.10", minutes: "90" } }, // team 1, doubled
          { id: 3, stats: { expected_goals: "0.60", expected_assists: "0.20", minutes: "90" } }, // team 2, single
        ],
      },
      freshness: null,
    });

    const { loadInSeasonPlayerRates } = await import("@/lib/historical/loadInSeasonForm");
    const history = await loadInSeasonPlayerRates(
      [{ id: 1, teamId: 1 }, { id: 3, teamId: 2 }],
      [
        { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
        { gameweek: 1, teamHomeId: 1, teamAwayId: 4, finished: true },
      ],
    );

    expect(history[1]).toBeUndefined();
    expect(history[3]).toEqual([{ xg: 0.6, xa: 0.2, minutes: 90, opponentTeamId: 1, wasHome: false }]);
  });

  it("does not persist a partially played gameweek", async () => {
    mocks.getLiveGameweek.mockResolvedValue({
      data: { elements: [{ id: 1, stats: { expected_goals: "0.80", expected_assists: "0.20", minutes: "90" } }] },
      freshness: null,
    });

    const { loadInSeasonPlayerRates } = await import("@/lib/historical/loadInSeasonForm");
    const players = [{ id: 1, teamId: 1 }];
    const fixtures = [
      { gameweek: 1, teamHomeId: 1, teamAwayId: 2, finished: true },
      { gameweek: 1, teamHomeId: 3, teamAwayId: 4, finished: false },
    ];

    await loadInSeasonPlayerRates(players, fixtures);
    await loadInSeasonPlayerRates(players, fixtures);

    expect(mocks.getLiveGameweek).toHaveBeenCalledTimes(2);
  });
});
