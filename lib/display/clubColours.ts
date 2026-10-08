/** Shown for any club short name not in the table. */
export const UNKNOWN_CLUB_COLOUR = "#3a3f45";

/** Primary kit colour for each club in data/snapshots/bootstrap.json, keyed by FPL short name. */
const CLUB_COLOURS: Record<string, string> = {
  ARS: "#ef0107",
  AVL: "#670e36",
  BOU: "#da291c",
  BRE: "#e30613",
  BHA: "#0057b8",
  CHE: "#034694",
  COV: "#59cbe8",
  CRY: "#1b458f",
  EVE: "#003399",
  FUL: "#ffffff",
  HUL: "#c98a1b",
  IPS: "#3a64a3",
  LEE: "#1d428a",
  LIV: "#c8102e",
  MCI: "#6cabdd",
  MUN: "#da291c",
  NEW: "#2a2526",
  NFO: "#dd0000",
  SUN: "#eb172b",
  TOT: "#132257",
};

export function clubColour(shortName: string): string {
  return Object.hasOwn(CLUB_COLOURS, shortName) ? CLUB_COLOURS[shortName] : UNKNOWN_CLUB_COLOUR;
}
