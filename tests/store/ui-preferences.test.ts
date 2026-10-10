import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PLAYER_COLUMNS, exportTerminalState, parseSavedStateResult, sanitizePanelRatios, useTerminalStore } from "@/store/terminalStore";

describe("ui preferences", () => {
  beforeEach(() => useTerminalStore.getState().reset());

  it("defaults to the pitch and the default columns", () => {
    const s = useTerminalStore.getState();
    expect(s.squadView).toBe("PITCH");
    expect(s.playerColumns).toEqual(DEFAULT_PLAYER_COLUMNS);
  });

  it("round-trips through export and hydrate", () => {
    const s = useTerminalStore.getState();
    s.setSquadView("TABLE");
    s.setPlayerColumns(["own", "xgi"]);
    const raw = JSON.stringify(exportTerminalState(useTerminalStore.getState()));
    useTerminalStore.getState().reset();
    const parsed = parseSavedStateResult(raw);
    expect(parsed.status).toBe("accepted");
    if (parsed.status === "accepted") useTerminalStore.getState().hydrate(parsed.state);
    expect(useTerminalStore.getState().squadView).toBe("TABLE");
    expect(useTerminalStore.getState().playerColumns).toEqual(["own", "xgi"]);
  });

  it("loads an old save without the fields using the defaults", () => {
    const old = JSON.stringify({ ...exportTerminalState(useTerminalStore.getState()), squadView: undefined, playerColumns: undefined });
    const parsed = parseSavedStateResult(old);
    if (parsed.status === "accepted") useTerminalStore.getState().hydrate(parsed.state);
    expect(useTerminalStore.getState().squadView).toBe("PITCH");
    expect(useTerminalStore.getState().playerColumns).toEqual(DEFAULT_PLAYER_COLUMNS);
  });

  it("drops unknown column keys and a bad view", () => {
    const base = exportTerminalState(useTerminalStore.getState());
    const parsed = parseSavedStateResult(JSON.stringify({ ...base, squadView: "WAT", playerColumns: ["own", "nope", 3] }));
    if (parsed.status === "accepted") useTerminalStore.getState().hydrate(parsed.state);
    expect(useTerminalStore.getState().squadView).toBe("PITCH");
    expect(useTerminalStore.getState().playerColumns).toEqual(["own"]);
  });
});

describe("panel ratios", () => {
  beforeEach(() => useTerminalStore.getState().reset());

  it("keeps rail and drops unknown panels", () => {
    expect(sanitizePanelRatios({ market: 30, squad: 40, rail: 30, extra: 5 } as never)).toEqual({ market: 30, squad: 40, rail: 30 });
  });

  it("setPanelRatios with two panels keeps a stored rail ratio", () => {
    const s = useTerminalStore.getState();
    s.setPanelRatios({ market: 40, squad: 40, rail: 20 });
    s.setPanelRatios({ market: 45, squad: 35 });
    expect(useTerminalStore.getState().panelRatios).toEqual({ market: 45, squad: 35, rail: 20 });
  });

  it("an old save without rail still loads", () => {
    const old = JSON.stringify({ ...exportTerminalState(useTerminalStore.getState()), panelRatios: { market: 30, squad: 70 } });
    const parsed = parseSavedStateResult(old);
    expect(parsed.status).toBe("accepted");
    if (parsed.status === "accepted") useTerminalStore.getState().hydrate(parsed.state);
    expect(useTerminalStore.getState().panelRatios).toEqual({ market: 30, squad: 70 });
  });
});
