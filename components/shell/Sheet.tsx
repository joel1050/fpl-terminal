"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A modal dialog shown as a bottom sheet or a popover. Escape and an outside
 * tap close it, and focus returns to whatever had focus when it opened.
 */
export function Sheet({ open, onClose, title, variant = "bottom", children }: { open: boolean; onClose: () => void; title: string; variant?: "bottom" | "popover"; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  // Kept in a ref so a new onClose from a re-render does not re-run the focus effect below.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className={`sheet-backdrop ${variant}`} onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} className={`sheet ${variant}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="sheet-head"><strong>{title}</strong><button type="button" className="sheet-close" aria-label={`Close ${title}`} onClick={onClose}>×</button></div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
