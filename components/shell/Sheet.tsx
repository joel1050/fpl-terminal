"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * A modal dialog shown as a bottom sheet or a popover. Escape and an outside
 * tap close it, and focus returns to whatever had focus when it opened. A
 * popover with an anchor opens under it, right edges aligned; without one it
 * sits under the top bar on the right. With placement "side" it opens beside
 * the anchor instead: to the right when the anchor sits in the left half of
 * its `[data-popover-bounds]` box (or of the window), otherwise to the left.
 */
export function Sheet({ open, onClose, title, variant = "bottom", anchor, placement = "below", children }: { open: boolean; onClose: () => void; title: string; variant?: "bottom" | "popover"; anchor?: RefObject<HTMLElement | null>; placement?: "below" | "side"; children: ReactNode }) {
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
    const margin = 8;
    const placeSide = () => {
      if (!target.isConnected) return;
      const box = target.getBoundingClientRect();
      const bounds = target.closest("[data-popover-bounds]")?.getBoundingClientRect();
      const boundsCentre = bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2;
      const gap = 8;
      sheet.style.position = "fixed";
      sheet.style.margin = "0";
      sheet.style.maxHeight = `${window.innerHeight - margin * 2}px`;
      const width = sheet.offsetWidth;
      const height = sheet.offsetHeight;
      const rightX = box.right + gap;
      const leftX = box.left - gap - width;
      const fitsRight = rightX + width <= window.innerWidth - margin;
      const fitsLeft = leftX >= margin;
      const preferRight = box.left + box.width / 2 <= boundsCentre + 4;
      const x = preferRight ? (fitsRight || !fitsLeft ? rightX : leftX) : (fitsLeft || !fitsRight ? leftX : rightX);
      const y = box.top + box.height / 2 - height / 2;
      sheet.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - width - margin))}px`;
      sheet.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - height - margin))}px`;
    };
    const placeBelow = () => {
      const box = target.getBoundingClientRect();
      const width = sheet.offsetWidth;
      sheet.style.position = "fixed";
      sheet.style.margin = "0";
      sheet.style.top = `${box.bottom + 6}px`;
      sheet.style.left = `${Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))}px`;
      sheet.style.maxHeight = `${Math.max(160, window.innerHeight - box.bottom - 18)}px`;
    };
    const place = placement === "side" ? placeSide : placeBelow;
    place();
    window.addEventListener("resize", place);
    // Capture: scroll events from inner scrollers do not bubble.
    if (placement === "side") window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      // The same panel may come back as a bottom sheet, so it must not keep the popover's place.
      for (const property of ["position", "margin", "top", "left", "maxHeight"] as const) sheet.style[property] = "";
    };
  }, [open, variant, anchor, placement]);
  if (!open) return null;
  return (
    <div className={`sheet-backdrop ${variant}`} onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} className={`sheet ${variant}${placement === "side" ? " side" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="sheet-head"><strong>{title}</strong><button type="button" className="sheet-close" aria-label={`Close ${title}`} onClick={onClose}>×</button></div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
