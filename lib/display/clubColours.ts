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

const DARK_SHIRT_TEXT = "#111418";
const LIGHT_SHIRT_TEXT = "#ffffff";

/**
 * Text for a shirt of the given #rrggbb colour. Dark on light shirts (Fulham's
 * white, Hull's amber), white on dark ones. The 0.2 cut-off sits near the
 * relative luminance where the two text colours give equal contrast.
 */
export function shirtTextColour(background: string): string {
  const channel = (offset: number) => {
    const value = parseInt(background.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.2 ? DARK_SHIRT_TEXT : LIGHT_SHIRT_TEXT;
}
