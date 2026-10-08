"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * A modal dialog shown as a bottom sheet or a popover. Escape and an outside
 * tap close it, and focus returns to whatever had focus when it opened. A
 * popover with an anchor opens under it, right edges aligned; without one it
 * sits under the top bar on the right.
 */
export function Sheet({ open, onClose, title, variant = "bottom", anchor, children }: { open: boolean; onClose: () => void; title: string; variant?: "bottom" | "popover"; anchor?: RefObject<HTMLElement | null>; children: ReactNode }) {
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
  useLayoutEffect(() => {
    const sheet = panel.current;
    const target = anchor?.current;
    if (!open || variant !== "popover" || !sheet || !target) return;
    const place = () => {
      const box = target.getBoundingClientRect();
      const width = sheet.offsetWidth;
      sheet.style.position = "fixed";
      sheet.style.margin = "0";
      sheet.style.top = `${box.bottom + 6}px`;
      sheet.style.left = `${Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))}px`;
      sheet.style.maxHeight = `${Math.max(160, window.innerHeight - box.bottom - 18)}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      // The same panel may come back as a bottom sheet, so it must not keep the popover's place.
      for (const property of ["position", "margin", "top", "left", "maxHeight"] as const) sheet.style[property] = "";
    };
  }, [open, variant, anchor]);
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
