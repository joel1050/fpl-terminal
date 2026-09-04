import { beforeEach, describe, expect, it } from "vitest";
import { replayTimeline } from "@/lib/chips/timeline";
import {
  baselineWithMigrationFallback,
  estimatedBaselineFallback,
  exportTerminalState,
  invalidateDownstreamPlans,
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

function appliedLineup() {
  expect(useTerminalStore.getState().applyLineup({
    gameweek: 1,
    lineupProjectionFingerprint: "fp-1",
    benchGoalkeeperId: 2,
    benchOrder: [7, 12, 15],
    captainId: 1,
    viceCaptainId: 3,
  })).toBe(true);
}

beforeEach(() => {
  useTerminalStore.getState().reset();
  useTerminalStore.getState().hydrate({ squad });
  useTerminalStore.getState().initializeGameweek(1);
});

describe("chip store", () => {
  it("selects and clears chips with season-rule validation", () => {
    const store = useTerminalStore.getState();
    expect(store.setChip(1, "wildcard")).toBe(true);
    expect(useTerminalStore.getState().chip).toBe("wildcard");
    // Replacing the gameweek chip is allowed; only one chip stays active.
    expect(useTerminalStore.getState().setChip(1, "freehit")).toBe(true);
    expect(useTerminalStore.getState().chip).toBe("freehit");
    expect(useTerminalStore.getState().setChip(1, null)).toBe(true);
    expect(useTerminalStore.getState().chip).toBeNull();
    // Consecutive free hits across the window boundary are rejected.
    useTerminalStore.getState().replaceSquad(
      squad, { gameweek: 1, lineupProjectionFingerprint: "x", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 },
      9, 1000, { usedChips: [{ kind: "freehit", gameweek: 19 }] },
    );
    expect(useTerminalStore.getState().setChip(20, "freehit")).toBe(false);
    expect(useTerminalStore.getState().setChip(21, "freehit")).toBe(true);
  });

  it("preserves the permanent squad on free hit weeks and restores it after", () => {
    appliedLineup();
    expect(useTerminalStore.getState().setChip(1, "freehit")).toBe(true);
    // Swap a midfielder under the temporary Free Hit squad.
    expect(useTerminalStore.getState().replacePlayer(8, 30, "MID")).toBe(true);
    expect(useTerminalStore.getState().playerIds).toContain(30);
    expect(useTerminalStore.getState().setPlanningGameweek(2)).toBe(true);
    // GW2 restores the permanent squad and lineup, not the temporary picks.
    expect(useTerminalStore.getState().playerIds).not.toContain(30);
    expect(useTerminalStore.getState().playerIds).toEqual(squad.playerIds);
    expect(useTerminalStore.getState()).toMatchObject({ chip: null, benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 });
  });

  it("leaves later permanent plans alone when editing a free hit squad", () => {
    appliedLineup();
    expect(useTerminalStore.getState().setChip(1, "freehit")).toBe(true);
    expect(useTerminalStore.getState().setPlanningGameweek(2)).toBe(true);
    expect(useTerminalStore.getState().setPlanningGameweek(1)).toBe(true);
    expect(useTerminalStore.getState().replacePlayer(8, 30, "MID")).toBe(true);
    const state = useTerminalStore.getState();
    // The GW2 permanent plan still holds the old squad with no notice.
    expect(state.gameweekPlans[2]?.playerIds).toEqual(squad.playerIds);
    expect(state.gameweekPlans[2]?.playerIds).not.toContain(30);
    expect(state.planNotice).toBeNull();
  });

  it("restores the permanent squad and lineup when a free hit is cleared", () => {
    appliedLineup();
    expect(useTerminalStore.getState().setChip(1, "freehit")).toBe(true);
    expect(useTerminalStore.getState().replacePlayer(8, 30, "MID")).toBe(true);
    expect(useTerminalStore.getState().setChip(1, null)).toBe(true);
    const state = useTerminalStore.getState();
    expect(state).toMatchObject({
      chip: null,
      benchGoalkeeperId: 2,
      benchOrder: [7, 12, 15],
      captainId: 1,
      viceCaptainId: 3,
    });
    expect(state.playerIds).toEqual(squad.playerIds);
    expect(state.permanentSquad).toBeUndefined();
  });

  it("moves preserved free hit snapshots along permanent-line changes", () => {
    appliedLineup();
    // Plan a Free Hit in GW5 from the current permanent squad.
    expect(useTerminalStore.getState().setChip(5, "freehit")).toBe(true);
    expect(useTerminalStore.getState().gameweekPlans[5]?.permanentSquad?.playerIds).toEqual(squad.playerIds);
    // Edit the permanent line in GW1; the GW5 plan and snapshot remap.
    expect(useTerminalStore.getState().replacePlayer(5, 40, "DEF")).toBe(true);
    const plan = useTerminalStore.getState().gameweekPlans[5];
    expect(plan?.playerIds).toContain(40);
    expect(plan?.playerIds).not.toContain(5);
    expect(plan?.permanentSquad?.playerIds).toContain(40);
    expect(plan?.permanentSquad?.playerIds).not.toContain(5);
  });

  it("applies advice atomically and undoes it in one click", () => {
    appliedLineup();
    const before = [...useTerminalStore.getState().playerIds];
    expect(useTerminalStore.getState().applyChipSuggestion({
      gameweek: 1,
      chip: "bboost",
      lineup: {
        gameweek: 1,
        lineupProjectionFingerprint: "fp-bb",
        benchGoalkeeperId: 2,
        benchOrder: [7, 12, 15],
        captainId: 4,
        viceCaptainId: 3,
      },
    })).toBe(true);
    const applied = useTerminalStore.getState();
    expect(applied.chip).toBe("bboost");
    expect(applied.captainId).toBe(4);
    expect(applied.playerIds).toEqual(before);
    expect(useTerminalStore.getState().undoChipApply()).toBe(true);
    const undone = useTerminalStore.getState();
    expect(undone.chip).toBeNull();
    expect(undone.captainId).toBe(1);
    expect(useTerminalStore.getState().undoChipApply()).toBe(false);
  });

  it("keeps the permanent squad when free hit advice is applied twice", () => {
    const shifted = (offset: number) => ({
      playerIds: squad.playerIds.map((id) => id + offset),
      byPosition: Object.fromEntries(Object.entries(squad.byPosition).map(([position, ids]) => [position, ids.map((id) => id + offset)])) as typeof squad.byPosition,
    });
    const lineupFor = (offset: number) => ({
      gameweek: 1,
      lineupProjectionFingerprint: `fh-${offset}`,
      benchGoalkeeperId: 2 + offset,
      benchOrder: [7 + offset, 12 + offset, 15 + offset],
      captainId: 3 + offset,
      viceCaptainId: 4 + offset,
    });
    const first = shifted(20);
    expect(useTerminalStore.getState().applyChipSuggestion({
      gameweek: 1, chip: "freehit", squad: first, lineup: lineupFor(20), plannedTransfers: [],
    })).toBe(true);
    expect(useTerminalStore.getState().playerIds).toEqual(first.playerIds);
    // The preserved squad is the pre-advice permanent squad, not the temp.
    expect(useTerminalStore.getState().gameweekPlans[1]?.permanentSquad?.playerIds).toEqual(squad.playerIds);
    const second = shifted(40);
    expect(useTerminalStore.getState().applyChipSuggestion({
      gameweek: 1, chip: "freehit", squad: second, lineup: lineupFor(40), plannedTransfers: [],
    })).toBe(true);
    expect(useTerminalStore.getState().playerIds).toEqual(second.playerIds);
    expect(useTerminalStore.getState().gameweekPlans[1]?.permanentSquad?.playerIds).toEqual(squad.playerIds);
  });

  it("rejects partial advice that fails lineup validation", () => {
    appliedLineup();
    const before = useTerminalStore.getState();
    expect(useTerminalStore.getState().applyChipSuggestion({
      gameweek: 1,
      chip: "3xc",
      lineup: {
        gameweek: 1,
        lineupProjectionFingerprint: "fp-tc",
        benchGoalkeeperId: 2,
        benchOrder: [7, 12, 15],
        captainId: 1,
        viceCaptainId: 1,
      },
    })).toBe(false);
    expect(useTerminalStore.getState().chip).toBe(before.chip);
    expect(useTerminalStore.getState().preApplySnapshot).toBeNull();
  });

  it("invalidates downstream squads while naming the first cleared gameweek", () => {
    appliedLineup();
    useTerminalStore.getState().setPlanningGameweek(2);
    useTerminalStore.getState().setPlanningGameweek(3);
    useTerminalStore.getState().setPlanningGameweek(1);
    // Replace a defender: later plans holding player 5 are remapped or cleared.
    expect(useTerminalStore.getState().replacePlayer(5, 40, "DEF")).toBe(true);
    const state = useTerminalStore.getState();
    expect(state.playerIds).toContain(40);
    // GW2/GW3 plans referenced player 5 and are remapped onto player 40.
    expect(state.gameweekPlans[2]?.playerIds).toContain(40);
    expect(state.gameweekPlans[3]?.playerIds).toContain(40);
  });

  it("clears downstream plans that cannot be remapped and reports GW2", () => {
    appliedLineup();
    useTerminalStore.getState().setPlanningGameweek(2);
    // Removal without replacement invalidates any later plan holding the player.
    const { plans: cleaned, firstClearedGameweek } = invalidateDownstreamPlans(
      {
        1: { gameweek: 1, playerIds: [...squad.playerIds], byPosition: { ...squad.byPosition, GK: [...squad.byPosition.GK], DEF: [...squad.byPosition.DEF], MID: [...squad.byPosition.MID], FWD: [...squad.byPosition.FWD] }, benchOrder: [7, 12, 15], lockedPlayerIds: [], chip: null, plannedTransfers: [] },
        2: { gameweek: 2, playerIds: [...squad.playerIds], byPosition: { ...squad.byPosition, GK: [...squad.byPosition.GK], DEF: [...squad.byPosition.DEF], MID: [...squad.byPosition.MID], FWD: [...squad.byPosition.FWD] }, benchOrder: [7, 12, 15], lockedPlayerIds: [], chip: "bboost", plannedTransfers: [] },
      },
      1,
      5,
      undefined,
    );
    expect(cleaned[2]).toBeUndefined();
    expect(firstClearedGameweek).toBe(2);
  });

  it("imports squads with the active chip set for that week", () => {
    useTerminalStore.getState().setMode("ANALYZE");
    useTerminalStore.getState().replaceSquad(
      squad, { gameweek: 3, lineupProjectionFingerprint: "x", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 },
      4827193, 1000,
      {
        usedChips: [{ kind: "3xc", gameweek: 3 }],
        chip: "3xc",
      },
    );
    expect(useTerminalStore.getState().chip).toBe("3xc");
    expect(useTerminalStore.getState().gameweekPlans[3]?.chip).toBe("3xc");
  });

    it("allows free replacement in imported squads with timeline accounting", () => {
    useTerminalStore.getState().setMode("ANALYZE");
    useTerminalStore.getState().replaceSquad(
      squad, { gameweek: 1, lineupProjectionFingerprint: "x", benchGoalkeeperId: 2, benchOrder: [7, 12, 15], captainId: 1, viceCaptainId: 3 },
      4827193, 1000,
      {
        transferBaseline: {
          squadPlayerIds: [...squad.playerIds],
          byPosition: { GK: [...squad.byPosition.GK], DEF: [...squad.byPosition.DEF], MID: [...squad.byPosition.MID], FWD: [...squad.byPosition.FWD] },
          bankTenths: 10,
          freeTransfers: 1,
          purchasePricesTenths: {},
          financialConfidence: "ESTIMATED",
          startGameweek: 1,
          warnings: [],
        },
        usedChips: [],
      },
    );
    // Standalone remove/add sequences stay available; the shared timeline
    // calculator derives transfers from the saved squad diffs.
    useTerminalStore.getState().toggleLock(5);
    expect(useTerminalStore.getState().removePlayer(5)).toBe(true);
    expect(useTerminalStore.getState().playerIds).toHaveLength(14);
    expect(useTerminalStore.getState().addPlayer(40, "DEF")).toBe(true);
    expect(useTerminalStore.getState().playerIds).toContain(40);
    expect(useTerminalStore.getState().gameweekPlans[1].plannedTransfers).toEqual([{ outId: 5, inId: 40, position: "DEF" }]);
  });

  it("migrates pre-chip exports with estimated finances and drops invalid chips", () => {
    const raw = JSON.stringify({
      squad,
      budgetTenths: 1003,
      planningGameweek: 1,
      gameweekPlans: {
        1: {
          gameweek: 1,
          playerIds: squad.playerIds,
          byPosition: squad.byPosition,
          benchOrder: [7, 12, 15],
          lockedPlayerIds: [],
          chip: "assistant-manager",
          plannedTransfers: "oops",
        },
      },
    });
    useTerminalStore.getState().reset();
    useTerminalStore.getState().hydrate(parseSavedState(raw));
    const state = useTerminalStore.getState();
    expect(state.gameweekPlans[1]).toMatchObject({ chip: null, plannedTransfers: [] });
    expect(state.playerIds).toEqual(squad.playerIds);
    const migrated = baselineWithMigrationFallback(state.transferBaseline, state.playerIds, state.byPosition, state.budgetTenths, 1);
    expect(migrated.financialConfidence).toBe("ESTIMATED");
    const saved = exportTerminalState(state);
    expect(saved.gameweekPlans?.[1]).toMatchObject({ chip: null });
    expect(saved.budgetTenths).toBe(1003);
  });
});

describe("hand-built baseline", () => {
  it("seeds the bank from the budget and prices the squad at market", () => {
    const priceById = new Map([[1, 50], [2, 50], [3, 50], [4, 50], [5, 50]]);
    const baseline = estimatedBaselineFallback(
      [1, 2, 3, 4, 5],
      { GK: [1], DEF: [2, 3], MID: [4], FWD: [5] },
      1000,
      3,
      priceById,
    );
    expect(baseline.bankTenths).toBe(750);
    expect(baseline.purchasePricesTenths).toEqual({ 1: 50, 2: 50, 3: 50, 4: 50, 5: 50 });
    expect(baseline.financialConfidence).toBe("ESTIMATED");
  });

  it("never reports a negative bank", () => {
    const priceById = new Map([[1, 900], [2, 900]]);
    expect(estimatedBaselineFallback([1, 2], { GK: [1], DEF: [2], MID: [], FWD: [] }, 1000, 3, priceById).bankTenths).toBe(0);
  });

  it("keeps a zero bank when no prices are supplied", () => {
    expect(estimatedBaselineFallback([1], { GK: [1], DEF: [], MID: [], FWD: [] }, 1000, 3).bankTenths).toBe(0);
  });
});

describe("setBankTenths", () => {
  const importedBaseline = {
    squadPlayerIds: [1],
    byPosition: { GK: [1], DEF: [], MID: [], FWD: [] },
    bankTenths: 3,
    freeTransfers: 1,
    purchasePricesTenths: { 1: 50 },
    financialConfidence: "EXACT" as const,
    startGameweek: 1,
    warnings: [],
  };

  /** What the strip shows: the baseline replayed up to the planning gameweek. */
  const shownBank = (priceById: ReadonlyMap<number, number>) => {
    const s = useTerminalStore.getState();
    return replayTimeline({
      baseline: s.transferBaseline!,
      plans: { [s.planningGameweek]: { playerIds: [...s.playerIds], chip: s.chip } },
      priceById,
      fromGameweek: Math.min(s.transferBaseline!.startGameweek, s.planningGameweek),
      toGameweek: s.planningGameweek,
    })[s.planningGameweek].bankTenths;
  };

  it("writes the bank onto an imported baseline", () => {
    useTerminalStore.setState({ entryId: 4827193, transferBaseline: importedBaseline, playerIds: [1], budgetTenths: 1000 });
    expect(useTerminalStore.getState().setBankTenths(7, { spentTenths: 50 })).toBe(true);
    expect(useTerminalStore.getState().transferBaseline?.bankTenths).toBe(7);
    expect(useTerminalStore.getState().transferBaseline?.financialConfidence).toBe("ESTIMATED");
    expect(useTerminalStore.getState().budgetTenths).toBe(1000);
  });

  it("shows the figure that was typed, whatever was pending", () => {
    // Player 1 has been sold and not replaced, so the strip was showing the
    // baseline plus that sale. The typed figure describes the bank now.
    const priceById = new Map([[1, 50], [2, 60]]);
    useTerminalStore.setState({
      entryId: 4827193, transferBaseline: importedBaseline, playerIds: [2],
      byPosition: { GK: [2], DEF: [], MID: [], FWD: [] }, budgetTenths: 1000, planningGameweek: 1,
    });
    expect(shownBank(priceById)).not.toBe(8);
    expect(useTerminalStore.getState().setBankTenths(8, { spentTenths: 60, priceById })).toBe(true);
    expect(shownBank(priceById)).toBe(8);
  });

  it("re-anchors to the squad in hand so nothing is applied on top", () => {
    const priceById = new Map([[1, 50], [2, 60]]);
    useTerminalStore.setState({
      entryId: 4827193, transferBaseline: importedBaseline, playerIds: [2],
      byPosition: { GK: [2], DEF: [], MID: [], FWD: [] }, budgetTenths: 1000, planningGameweek: 1,
    });
    useTerminalStore.getState().setBankTenths(8, { spentTenths: 60, priceById });
    const baseline = useTerminalStore.getState().transferBaseline!;
    expect(baseline.squadPlayerIds).toEqual([2]);
    // A player brought in since the import is priced at what it costs today,
    // so selling it later returns the right money.
    expect(baseline.purchasePricesTenths).toEqual({ 2: 60 });
  });

  it("keeps a known purchase price rather than re-pricing at market", () => {
    const priceById = new Map([[1, 90]]); // player 1 has risen from 50
    useTerminalStore.setState({ entryId: 4827193, transferBaseline: importedBaseline, playerIds: [1], budgetTenths: 1000 });
    useTerminalStore.getState().setBankTenths(8, { spentTenths: 90, priceById });
    expect(useTerminalStore.getState().transferBaseline?.purchasePricesTenths).toEqual({ 1: 50 });
  });

  it("moves the budget for a hand-built squad so the figure keeps falling", () => {
    // Freezing a bank onto a fallback baseline would stop it decrementing as
    // players are added, because the replay pairs sales with purchases.
    useTerminalStore.setState({ entryId: undefined, transferBaseline: null, playerIds: [1], budgetTenths: 1000 });
    expect(useTerminalStore.getState().setBankTenths(900, { spentTenths: 50 })).toBe(true);
    expect(useTerminalStore.getState().budgetTenths).toBe(950);
    expect(useTerminalStore.getState().transferBaseline).toBeNull();
  });

  it("rejects a negative or non-integer bank and leaves state untouched", () => {
    useTerminalStore.setState({ entryId: undefined, transferBaseline: null, budgetTenths: 1000 });
    expect(useTerminalStore.getState().setBankTenths(-1, { spentTenths: 0 })).toBe(false);
    expect(useTerminalStore.getState().setBankTenths(1.5, { spentTenths: 0 })).toBe(false);
    expect(useTerminalStore.getState().setBankTenths(7, { spentTenths: -1 })).toBe(false);
    expect(useTerminalStore.getState().transferBaseline).toBeNull();
    expect(useTerminalStore.getState().budgetTenths).toBe(1000);
  });
});
