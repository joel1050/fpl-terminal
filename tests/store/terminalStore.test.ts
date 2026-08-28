import { beforeEach, describe, expect, it } from "vitest";
import {
  deriveStartingXI,
  exportTerminalState,
  isLineupStale,
  parseSavedState,
  useTerminalStore,
} from "@/store/terminalStore";

const squad = {
  playerIds: Array.from({ length: 15 }, (_, index) => index + 1),
  byPosition: {
    GK: [1, 2],
    DEF: [3, 4, 5, 6, 7],
    MID: [8, 9, 10, 11, 12],
    FWD: [13, 14, 15],
  },
};

beforeEach(() => {
  useTerminalStore.getState().reset();
  useTerminalStore.getState().hydrate({ squad });
});

describe("persisted weekly lineup state", () => {
  it("applies exactly four bench players and derives the starters", () => {
    const store = useTerminalStore.getState();
    expect(store.applyLineup({
      gameweek: 1,
      lineupProjectionFingerprint: "fp-1",
      benchGoalkeeperId: 2,
      benchOrder: [7, 12, 15],
      captainId: 1,
      viceCaptainId: 3,
    })).toBe(true);

    const current = useTerminalStore.getState();
    expect(deriveStartingXI(current.playerIds, current.benchGoalkeeperId, current.benchOrder)).toEqual([1, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14]);
    const saved = exportTerminalState(current);
    expect(saved).toMatchObject({ benchGoalkeeperId: 2, benchOrder: [7, 12, 15], lineupGameweek: 1, lineupProjectionFingerprint: "fp-1", captainId: 1, viceCaptainId: 3 });
    expect(saved).not.toHaveProperty("startingXI");
    expect(saved).not.toHaveProperty("appliedLineup");
    expect(saved).not.toHaveProperty("lineupStatus");
  });

  it("rejects malformed lineups and conflicting captaincy", () => {
    const store = useTerminalStore.getState();
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp", benchGoalkeeperId: 2, benchOrder: [7, 12, 12] })).toBe(false);
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp", benchGoalkeeperId: 2, benchOrder: [7, 12, 15, 999], captainId: 1, viceCaptainId: 3 })).toBe(false);
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 1 })).toBe(false);
  });

  it("allows a legal cross-position starter/bench swap but protects captaincy", () => {
    const store = useTerminalStore.getState();
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 })).toBe(true);
    expect(useTerminalStore.getState().swapStarterBench(4, 12)).toBe(true);
    expect(useTerminalStore.getState().benchOrder).toEqual([7, 4, 15]);
    expect(useTerminalStore.getState().swapStarterBench(1, 2)).toBe(false);
  });

  it("can swap an un-applied draft without inventing persisted captaincy", () => {
    useTerminalStore.getState().hydrate({ squad, benchGoalkeeperId: 2, benchOrder: [7, 12, 15] });
    expect(useTerminalStore.getState().swapStarterBench(4, 12)).toBe(true);
    expect(useTerminalStore.getState().captainId).toBeUndefined();
    expect(useTerminalStore.getState().viceCaptainId).toBeUndefined();
  });

  it("does not let edits leave an applied lineup without captaincy", () => {
    const store = useTerminalStore.getState();
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 })).toBe(true);
    expect(store.setCaptain(undefined)).toBe(false);
    expect(store.setViceCaptain(undefined)).toBe(false);
    expect(useTerminalStore.getState()).toMatchObject({ captainId: 1, viceCaptainId: 3 });
  });

  it("only accepts a permutation of the three outfield substitutes", () => {
    const store = useTerminalStore.getState();
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 })).toBe(true);
    expect(useTerminalStore.getState().reorderBench([15, 7, 12])).toBe(true);
    expect(useTerminalStore.getState().reorderBench([15, 7])).toBe(false);
    expect(useTerminalStore.getState().benchOrder).toEqual([15, 7, 12]);
  });

  it("marks an applied lineup stale from current gameweek or projection fingerprint", () => {
    expect(isLineupStale(1, "fp-1", 1, "fp-1")).toBe(false);
    expect(isLineupStale(1, "fp-1", 2, "fp-1")).toBe(true);
    expect(isLineupStale(1, "fp-1", 1, "fp-2")).toBe(true);
    const store = useTerminalStore.getState();
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp-1", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 })).toBe(true);
    expect(exportTerminalState(useTerminalStore.getState()).lineupProjectionFingerprint).toBe("fp-1");
  });

  it("does not overwrite persisted lineup metadata when hydrating a new draft squad", () => {
    const store = useTerminalStore.getState();
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp-1", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 })).toBe(true);
    useTerminalStore.getState().hydrate({ squad: { ...squad, playerIds: squad.playerIds.slice(0, 14) }, benchGoalkeeperId: 1, benchOrder: [3, 8, 13], captainId: 5, viceCaptainId: 6 });
    expect(useTerminalStore.getState()).toMatchObject({ benchGoalkeeperId: 2, benchOrder: [7, 12, 15], lineupGameweek: 1, lineupProjectionFingerprint: "fp-1", captainId: 1, viceCaptainId: 3 });
    useTerminalStore.getState().hydrate({ squad, lineupGameweek: 2 });
    expect(useTerminalStore.getState()).toMatchObject({ lineupGameweek: 1, lineupProjectionFingerprint: "fp-1", captainId: 1, viceCaptainId: 3 });
  });

  it("allows squad edits after apply while retaining metadata for stale comparison", () => {
    const store = useTerminalStore.getState();
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp-1", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 })).toBe(true);
    expect(store.removePlayer(4)).toBe(true);
    const current = useTerminalStore.getState();
    expect(current.playerIds).not.toContain(4);
    expect(current.lineupGameweek).toBe(1);
    expect(current.lineupProjectionFingerprint).toBe("fp-1");
    expect(isLineupStale(current.lineupGameweek, current.lineupProjectionFingerprint, 1, "fp-2")).toBe(true);
  });

  it("applies a transfer atomically while preserving the outgoing lineup role", () => {
    const store = useTerminalStore.getState();
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp-1", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 })).toBe(true);
    expect(store.replacePlayer(12, 20, "MID")).toBe(true);
    expect(useTerminalStore.getState()).toMatchObject({ benchOrder: [7, 20, 15], lineupGameweek: 1, lineupProjectionFingerprint: "fp-1" });
    const before = useTerminalStore.getState().playerIds;
    expect(useTerminalStore.getState().replacePlayer(3, 20, "DEF")).toBe(false);
    expect(useTerminalStore.getState().playerIds).toEqual(before);
  });

  it("drops metadata instead of manufacturing a lineup from malformed persisted bench data", () => {
    useTerminalStore.getState().reset();
    useTerminalStore.getState().hydrate({
      squad,
      benchGoalkeeperId: 2,
      benchOrder: [7, 12, 12],
      captainId: 1,
      viceCaptainId: 3,
      lineupGameweek: 1,
      lineupProjectionFingerprint: "fp-1",
    });
    const current = useTerminalStore.getState();
    expect(current.benchOrder).toEqual([7, 12, 12]);
    expect(current.lineupGameweek).toBeUndefined();
    expect(current.lineupProjectionFingerprint).toBeUndefined();
  });

  it("round-trips the new fields through saved state parsing", () => {
    useTerminalStore.getState().dismissTransferSuggestion(3, 16);
    const saved = exportTerminalState(useTerminalStore.getState());
    useTerminalStore.getState().reset();
    useTerminalStore.getState().hydrate(parseSavedState(JSON.stringify(saved)));
    expect(useTerminalStore.getState()).toMatchObject({ benchOrder: [], dismissedTransferKeys: ["3:16"] });
  });

  it("replaces a complete imported squad atomically", () => {
    const store = useTerminalStore.getState();
    store.setMode("ANALYZE");
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "old", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 })).toBe(true);
    const imported = {
      playerIds: squad.playerIds.map((id) => id + 20),
      byPosition: Object.fromEntries(Object.entries(squad.byPosition).map(([position, ids]) => [position, ids.map((id) => id + 20)])) as typeof squad.byPosition,
    };

    const lineup = { gameweek: 1, lineupProjectionFingerprint: "imported", benchGoalkeeperId: 22, benchOrder: [27, 32, 35], captainId: 23, viceCaptainId: 24 };
    expect(useTerminalStore.getState().replaceSquad(imported, lineup, 4827193)).toBe(true);
    expect(useTerminalStore.getState()).toMatchObject({ ...imported, mode: "ANALYZE", entryId: 4827193, lockedPlayerIds: [], benchGoalkeeperId: 22, benchOrder: [27, 32, 35], captainId: 23, viceCaptainId: 24, lineupGameweek: 1, lineupProjectionFingerprint: "imported" });
    const saved = exportTerminalState(useTerminalStore.getState());
    useTerminalStore.getState().reset();
    useTerminalStore.getState().hydrate(saved);
    expect(useTerminalStore.getState()).toMatchObject({ mode: "ANALYZE", entryId: 4827193, playerIds: imported.playerIds });
    const before = useTerminalStore.getState().playerIds;
    expect(useTerminalStore.getState().replaceSquad({ ...imported, playerIds: imported.playerIds.slice(1) }, lineup, 4827193)).toBe(false);
    expect(useTerminalStore.getState().playerIds).toEqual(before);
  });

  it("inherits GW1 planning choices into GW2 and isolates later edits", () => {
    const store = useTerminalStore.getState();
    store.initializeGameweek(1);
    expect(store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp-1", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 })).toBe(true);
    store.toggleLock(4);

    expect(store.setPlanningGameweek(2)).toBe(true);
    expect(useTerminalStore.getState()).toMatchObject({ planningGameweek: 2, playerIds: squad.playerIds, benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3, lockedPlayerIds: [4], lineupGameweek: 2, lineupProjectionFingerprint: "fp-1" });
    expect(useTerminalStore.getState().gameweekPlans[1]).toMatchObject({ playerIds: squad.playerIds, captainId: 1, viceCaptainId: 3 });

    expect(useTerminalStore.getState().setCaptain(4)).toBe(true);
    expect(useTerminalStore.getState().removePlayer(5)).toBe(true);
    expect(useTerminalStore.getState().setPlanningGameweek(1)).toBe(true);
    expect(useTerminalStore.getState()).toMatchObject({ planningGameweek: 1, playerIds: squad.playerIds, captainId: 1, viceCaptainId: 3, lockedPlayerIds: [4] });

    expect(useTerminalStore.getState().setPlanningGameweek(3)).toBe(true);
    expect(useTerminalStore.getState()).toMatchObject({ planningGameweek: 3, playerIds: squad.playerIds.filter((id) => id !== 5), captainId: 4, viceCaptainId: 3, lockedPlayerIds: [4] });
  });

  it("persists the selected week and every plan through export and reload", () => {
    const store = useTerminalStore.getState();
    store.initializeGameweek(1);
    store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp-1", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 });
    store.setPlanningGameweek(2);
    store.setCaptain(4);
    const saved = exportTerminalState(useTerminalStore.getState());

    useTerminalStore.getState().reset();
    useTerminalStore.getState().hydrate(parseSavedState(JSON.stringify(saved)));
    expect(useTerminalStore.getState()).toMatchObject({ planningGameweek: 2, playerIds: squad.playerIds, captainId: 4, viceCaptainId: 3 });
    expect(Object.keys(useTerminalStore.getState().gameweekPlans).sort()).toEqual(["1", "2"]);
    expect(useTerminalStore.getState().gameweekPlans[1]).toMatchObject({ captainId: 1, viceCaptainId: 3 });
    expect(useTerminalStore.getState().gameweekPlans[2]).toMatchObject({ captainId: 4, viceCaptainId: 3 });
  });

  it("keeps other gameweek plans when the optimizer replaces the current squad", () => {
    const store = useTerminalStore.getState();
    store.initializeGameweek(1);
    store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "fp-1", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 });
    store.setPlanningGameweek(2);

    const optimized = {
      playerIds: squad.playerIds.map((id) => id + 20),
      byPosition: Object.fromEntries(Object.entries(squad.byPosition).map(([position, ids]) => [position, ids.map((id) => id + 20)])) as typeof squad.byPosition,
    };
    useTerminalStore.getState().hydrate({ squad: optimized, lockedPlayerIds: [], horizon: 1, riskMode: "BALANCED", benchStrategy: "CHEAP" });

    const state = useTerminalStore.getState();
    expect(state.planningGameweek).toBe(2);
    expect(state.playerIds).toEqual(optimized.playerIds);
    expect(Object.keys(state.gameweekPlans).sort()).toEqual(["1", "2"]);
    expect(state.gameweekPlans[1]).toMatchObject({ playerIds: squad.playerIds, captainId: 1, viceCaptainId: 3 });
    expect(state.gameweekPlans[2]).toMatchObject({ playerIds: optimized.playerIds });
  });

  it("clears future plans when an official squad replaces the current state", () => {
    const store = useTerminalStore.getState();
    store.initializeGameweek(1);
    store.applyLineup({ gameweek: 1, lineupProjectionFingerprint: "old", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 });
    store.setPlanningGameweek(2);
    const imported = {
      playerIds: squad.playerIds.map((id) => id + 20),
      byPosition: Object.fromEntries(Object.entries(squad.byPosition).map(([position, ids]) => [position, ids.map((id) => id + 20)])) as typeof squad.byPosition,
    };
    expect(store.replaceSquad(imported, { gameweek: 1, lineupProjectionFingerprint: "official", benchGoalkeeperId: 22, benchOrder: [27, 32, 35], captainId: 21, viceCaptainId: 23 }, 123)).toBe(true);
    expect(useTerminalStore.getState().planningGameweek).toBe(1);
    expect(Object.keys(useTerminalStore.getState().gameweekPlans)).toEqual(["1"]);
    expect(useTerminalStore.getState().gameweekPlans[2]).toBeUndefined();
  });
});

describe("transfer suggestion horizon", () => {
  it("starts at five gameweeks and is independent of the optimizer horizon", () => {
    expect(useTerminalStore.getState().transferHorizon).toBe(5);

    useTerminalStore.getState().setStrategy({ horizon: 10 });
    expect(useTerminalStore.getState().transferHorizon).toBe(5);

    useTerminalStore.getState().setStrategy({ transferHorizon: 1 });
    expect(useTerminalStore.getState()).toMatchObject({ transferHorizon: 1, horizon: 10 });
  });

  it("survives export and reload, and rejects a horizon outside the four choices", () => {
    useTerminalStore.getState().setStrategy({ transferHorizon: 3 });
    const saved = exportTerminalState(useTerminalStore.getState());
    expect(saved.transferHorizon).toBe(3);

    useTerminalStore.getState().reset();
    useTerminalStore.getState().hydrate(parseSavedState(JSON.stringify(saved)));
    expect(useTerminalStore.getState().transferHorizon).toBe(3);

    // Already on 3, so a rejected 4 has to be told apart from the initial 5.
    useTerminalStore.getState().hydrate(parseSavedState(JSON.stringify({ ...saved, transferHorizon: 4 })));
    expect(useTerminalStore.getState().transferHorizon).toBe(3);
  });
});

describe("last opened league", () => {
  it("remembers the league the manager last opened", () => {
    useTerminalStore.getState().setSelectedLeagueKey("classic-342328");
    expect(useTerminalStore.getState().selectedLeagueKey).toBe("classic-342328");
  });

  it("survives a save and reload", () => {
    useTerminalStore.getState().setSelectedLeagueKey("h2h-77");
    const saved = JSON.stringify(exportTerminalState(useTerminalStore.getState()));
    useTerminalStore.getState().reset();
    useTerminalStore.getState().hydrate(parseSavedState(saved));
    expect(useTerminalStore.getState().selectedLeagueKey).toBe("h2h-77");
  });

  it("ignores a saved key that is not a league", () => {
    useTerminalStore.getState().hydrate({ squad, selectedLeagueKey: "cup-1" });
    expect(useTerminalStore.getState().selectedLeagueKey).toBeUndefined();
    useTerminalStore.getState().setSelectedLeagueKey("overall");
    useTerminalStore.getState().hydrate({ squad, selectedLeagueKey: "classic-0" });
    expect(useTerminalStore.getState().selectedLeagueKey).toBe("overall");
  });
});
