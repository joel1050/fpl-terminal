import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PLAYER_COLUMNS, exportTerminalState, parseSavedStateResult, useTerminalStore } from "@/store/terminalStore";

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
