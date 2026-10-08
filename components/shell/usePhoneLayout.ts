"use client";

import { useSyncExternalStore } from "react";

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
 * True at the phone breakpoint (900px and below). Reads as a phone on the
 * server, where the phone layout comes first.
 */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribeToPhone, isPhone, () => true);
}
