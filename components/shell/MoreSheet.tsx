"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { Sheet } from "./Sheet";

const PHONE_QUERY = "(max-width: 900px)";

function subscribeToPhone(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isPhone() {
  return window.matchMedia(PHONE_QUERY).matches;
}

/**
 * The More menu. It is a bottom sheet on phones and a popover under the top bar
 * on wider screens. Omitting `onReverse`, `settings` or `onModeChooser` hides that action.
 */
export function MoreSheet({ open, onClose, onRefresh, onExport, onImportClick, onReset, onReverse, reverseBusy = false, reverseDisabled = false, settings, onModeChooser }: {
  open: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onExport: () => void;
  onImportClick: () => void;
  onReset: () => void;
  onReverse?: () => void;
  reverseBusy?: boolean;
  reverseDisabled?: boolean;
  settings?: ReactNode;
  onModeChooser?: () => void;
}) {
  const phone = useSyncExternalStore(subscribeToPhone, isPhone, () => true);
  // Every action closes the sheet first, except Reverse, which stays open to show that it is busy.
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <Sheet open={open} onClose={onClose} title="More" variant={phone ? "bottom" : "popover"}>
      <div className="more-actions">
        <button type="button" onClick={run(onRefresh)}>Refresh</button>
        <button type="button" onClick={run(onExport)}>Export</button>
        <button type="button" onClick={run(onImportClick)}>Import</button>
        {onReverse && (
          <>
            <button type="button" disabled={reverseDisabled || reverseBusy} onClick={onReverse}>{reverseBusy ? "Restoring…" : "Reverse all changes"}</button>
            {reverseDisabled && <p className="more-note">Import an FPL team to restore official picks.</p>}
          </>
        )}
        {settings && <div className="more-settings">{settings}</div>}
        {onModeChooser && <button type="button" onClick={run(onModeChooser)}>Choose mode</button>}
        <button type="button" className="danger" onClick={run(onReset)}>Reset</button>
      </div>
    </Sheet>
  );
}
