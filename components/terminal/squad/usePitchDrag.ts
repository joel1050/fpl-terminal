import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

/** What a drop target is worth to the player being dragged. */
export interface DropVerdict {
  legal: boolean;
  /** Shown as the notice when a player drops on an illegal target. Null means "not a target". */
  reason: string | null;
}

export interface PitchDragOptions {
  /** Dragging does nothing while this is false. */
  enabled: boolean;
  canDrop: (sourceId: number, targetId: number) => DropVerdict;
  onDrop: (sourceId: number, targetId: number) => void;
  onReject: (reason: string) => void;
}

const MOUSE_START_PX = 5;
const TOUCH_HOLD_MS = 300;
const TOUCH_SLOP_PX = 8;
const TOKEN_SELECTOR = "[data-player-id]";

function playerIdOf(element: Element | null, root: HTMLElement | null): number | null {
  const token = element?.closest<HTMLElement>(TOKEN_SELECTOR);
  if (!token || !root || !root.contains(token)) return null;
  const id = Number(token.dataset.playerId);
  return Number.isFinite(id) ? id : null;
}

/**
 * Pointer-event drag for the pitch tokens. Tokens carry `data-player-id`.
 * Mouse and pen start a drag after 5px of movement. Touch starts one after a
 * long press, so a quick tap still opens the sheet and a swipe still scrolls.
 * Marks drop targets with `data-drop="legal" | "illegal"` on the tokens, and
 * floats a copy of the dragged token under the pointer.
 */
export function usePitchDrag(options: PitchDragOptions) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => { optionsRef.current = options; });
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!optionsRef.current.enabled || cleanupRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as Element).closest("[data-no-drag]")) return;
    const root = rootRef.current;
    const sourceId = playerIdOf(event.target as Element, root);
    if (sourceId === null || !root) return;
    const sourceToken = (event.target as Element).closest<HTMLElement>(TOKEN_SELECTOR)!;
    const { pointerId, pointerType, clientX: startX, clientY: startY } = event;
    const isTouch = pointerType === "touch";

    let dragging = false;
    let hoverId: number | null = null;
    let ghost: HTMLElement | null = null;
    let grabX = 0;
    let grabY = 0;
    let holdTimer: number | undefined;

    const tokens = () => [...root.querySelectorAll<HTMLElement>(TOKEN_SELECTOR)];
    const clearMarks = () => {
      for (const token of tokens()) {
        token.removeAttribute("data-drop");
        token.removeAttribute("data-drag-source");
        token.removeAttribute("data-drop-over");
      }
    };
    const moveGhost = (x: number, y: number) => {
      if (ghost) ghost.style.transform = `translate(${x - grabX}px, ${y - grabY}px) scale(1.06)`;
    };
    const blockScroll = (touchEvent: TouchEvent) => { if (touchEvent.cancelable) touchEvent.preventDefault(); };
    const blockMenu = (menuEvent: Event) => menuEvent.preventDefault();

    const begin = (x: number, y: number) => {
      dragging = true;
      const rect = sourceToken.getBoundingClientRect();
      grabX = x - rect.left;
      grabY = y - rect.top;
      ghost = sourceToken.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-player-id");
      for (const marked of ghost.querySelectorAll("[data-testid]")) marked.removeAttribute("data-testid");
      ghost.removeAttribute("data-testid");
      ghost.setAttribute("aria-hidden", "true");
      ghost.classList.add("drag-ghost");
      Object.assign(ghost.style, { position: "fixed", left: "0", top: "0", width: `${rect.width}px`, margin: "0", pointerEvents: "none", zIndex: "60" });
      document.body.appendChild(ghost);
      moveGhost(x, y);
      for (const token of tokens()) {
        const id = Number(token.dataset.playerId);
        if (id === sourceId) token.setAttribute("data-drag-source", "true");
        else token.setAttribute("data-drop", optionsRef.current.canDrop(sourceId, id).legal ? "legal" : "illegal");
      }
      document.body.classList.add("pitch-dragging");
      // Touch only: from here on a move drags the token instead of scrolling the page.
      if (isTouch) window.addEventListener("touchmove", blockScroll, { passive: false });
    };

    const targetAt = (x: number, y: number) => {
      const id = playerIdOf(document.elementFromPoint(x, y), root);
      return id === sourceId ? null : id;
    };
    const markHover = (id: number | null) => {
      if (id === hoverId) return;
      hoverId = id;
      for (const token of tokens()) {
        if (Number(token.dataset.playerId) === id) token.setAttribute("data-drop-over", "true");
        else token.removeAttribute("data-drop-over");
      }
    };

    const finish = (apply: boolean, x: number, y: number) => {
      const wasDragging = dragging;
      const targetId = apply && wasDragging ? targetAt(x, y) : null;
      stop();
      if (!wasDragging) return;
      // The browser fires a click after the pointer lifts; keep it from opening the sheet.
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 60);
      if (targetId === null) return;
      const verdict = optionsRef.current.canDrop(sourceId, targetId);
      if (verdict.legal) optionsRef.current.onDrop(sourceId, targetId);
      else if (verdict.reason) optionsRef.current.onReject(verdict.reason);
    };

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (!dragging) {
        const distance = Math.hypot(move.clientX - startX, move.clientY - startY);
        if (isTouch) {
          // Moving before the hold ends is a scroll: give up.
          if (distance > TOUCH_SLOP_PX) stop();
        } else if (distance > MOUSE_START_PX) {
          begin(move.clientX, move.clientY);
        }
        return;
      }
      moveGhost(move.clientX, move.clientY);
      markHover(targetAt(move.clientX, move.clientY));
    };
    const onUp = (up: PointerEvent) => { if (up.pointerId === pointerId) finish(true, up.clientX, up.clientY); };
    const onCancel = (cancel: PointerEvent) => { if (cancel.pointerId === pointerId) finish(false, 0, 0); };
    const onKey = (key: KeyboardEvent) => { if (key.key === "Escape") finish(false, 0, 0); };

    function stop() {
      window.clearTimeout(holdTimer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("touchmove", blockScroll);
      window.removeEventListener("contextmenu", blockMenu, true);
      ghost?.remove();
      ghost = null;
      clearMarks();
      document.body.classList.remove("pitch-dragging");
      cleanupRef.current = null;
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    cleanupRef.current = stop;
    if (isTouch) {
      window.addEventListener("contextmenu", blockMenu, true);
      holdTimer = window.setTimeout(() => { if (!dragging) begin(startX, startY); }, TOUCH_HOLD_MS);
    }
  }, []);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { rootRef, rootProps: { onPointerDown, onClickCapture } };
}
