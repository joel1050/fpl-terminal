import { exportTerminalState, parseSavedStateResult, savedStateRefusalNotice, useTerminalStore } from "@/store/terminalStore";

type TerminalStoreState = ReturnType<typeof useTerminalStore.getState>;

/** Shared by the Planner and Leagues More sheets, so both read and write the same save file. */
export function exportState(state: TerminalStoreState) {
  const blob = new Blob([JSON.stringify(exportTerminalState(state), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "fpl-terminal-state.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function importState(event: React.ChangeEvent<HTMLInputElement>, state: TerminalStoreState, onNotice: (message: string) => void) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const result = typeof reader.result === "string" ? parseSavedStateResult(reader.result) : { status: "refused", reason: "malformed" } as const;
    if (result.status === "accepted") {
      state.hydrate(result.state);
      onNotice("Saved terminal state imported.");
    } else {
      onNotice(result.status === "refused" ? savedStateRefusalNotice(result) : "That save file is empty. Choose a compatible FPL Terminal export.");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

export function resetTerminalState(state: TerminalStoreState) {
  state.reset();
  window.localStorage.removeItem("fpl-terminal-state");
}
