import type { ChipInventory, ChipKind, SeasonChipPolicy } from "@/types/chips";

/**
 * Single season-policy constant. The public bootstrap payload does not publish
 * personal chip allowances, so all seasonal limits live here.
 */
export const SEASON_CHIP_POLICY: SeasonChipPolicy = {
  firstWindow: { from: 1, to: 19 },
  secondWindow: { from: 20, to: 38 },
  maxFreeTransfers: 5,
  maxTransfersPerGameweek: 20,
  hitCostPerTransferTenthsPoints: 4,
  sellProfitFraction: 0.5,
  chipsPerWindow: { wildcard: 1, freehit: 1, bboost: 1, "3xc": 1 },
};

export const CHIP_KINDS: ChipKind[] = ["wildcard", "freehit", "bboost", "3xc"];

export function windowForGameweek(gameweek: number): 1 | 2 {
  return gameweek <= SEASON_CHIP_POLICY.firstWindow.to ? 1 : 2;
}

function windowRange(window: 1 | 2): { from: number; to: number } {
  return window === 1 ? SEASON_CHIP_POLICY.firstWindow : SEASON_CHIP_POLICY.secondWindow;
}

export function normalizeChipName(name: string | null | undefined): ChipKind | null {
  if (!name) return null;
  const normalized = name.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["wildcard", "wc"].includes(normalized)) return "wildcard";
  if (["freehit", "fh", "freehit"].includes(normalized)) return "freehit";
  if (["bboost", "bb", "benchboost"].includes(normalized)) return "bboost";
  if (["3xc", "triplecaptain", "triplecaptaincy", "tc"].includes(normalized)) return "3xc";
  return null;
}

/** Remaining inventory after official usage: one of each chip per window. */
export function remainingInventory(used: Array<{ kind: ChipKind; gameweek: number }>): ChipInventory {
  const inventory: ChipInventory = { wildcard: [], freehit: [], bboost: [], "3xc": [] };
  for (const window of [1, 2] as const) {
    const range = windowRange(window);
    for (const kind of CHIP_KINDS) {
      const consumed = used.some(
        (entry) => entry.kind === kind && entry.gameweek >= range.from && entry.gameweek <= range.to,
      );
      if (!consumed) {
        for (let gw = range.from; gw <= range.to; gw += 1) inventory[kind].push(gw);
      }
    }
  }
  // Deduplicate windows: wildcard used in GW5 removes every GW1-19 candidate.
  return inventory;
}

export function isChipAvailable(
  kind: ChipKind,
  gameweek: number,
  used: Array<{ kind: ChipKind; gameweek: number }>,
): boolean {
  const range = windowRange(windowForGameweek(gameweek));
  if (gameweek < range.from || gameweek > range.to) return false;
  return !used.some(
    (entry) => entry.kind === kind && entry.gameweek >= range.from && entry.gameweek <= range.to,
  );
}

export interface ChipLegality {
  legal: boolean;
  reason?: string;
}

/**
 * Enforces: one of each chip per window, one chip per gameweek, no consecutive
 * Free Hits, and expiry of unused first-window chips.
 */
export function validateChipSelection(
  kind: ChipKind | null,
  gameweek: number,
  usedOfficial: Array<{ kind: ChipKind; gameweek: number }>,
  plannedChips: Record<number, ChipKind | null>,
  currentGameweek = 1,
): ChipLegality {
  if (kind === null) return { legal: true };
  if (gameweek < currentGameweek || gameweek > 38) return { legal: false, reason: "Gameweek is outside the current season." };
  const priorWindow = windowForGameweek(gameweek) === 2 ? 1 : null;
  if (priorWindow !== null) {
    // First-window chips expire; selecting a GW20-38 chip is always the second-window copy.
  }
  if (!isChipAvailable(kind, gameweek, usedOfficial)) {
    const range = windowRange(windowForGameweek(gameweek));
    const consumedOfficially = usedOfficial.some(
      (entry) => entry.kind === kind && entry.gameweek >= range.from && entry.gameweek <= range.to,
    );
    if (consumedOfficially) return { legal: false, reason: "That chip was already used in this window." };
    return { legal: false, reason: "That chip expired unused in the first window." };
  }
  const plannedElsewhere = Object.entries(plannedChips).some(
    ([gw, planned]) => Number(gw) !== gameweek && planned === kind && windowForGameweek(Number(gw)) === windowForGameweek(gameweek),
  );
  if (plannedElsewhere) return { legal: false, reason: "That chip is already planned in this window." };
  const existing = plannedChips[gameweek];
  if (existing !== undefined && existing !== null && existing !== kind) {
    return { legal: false, reason: "Only one chip can be used per Gameweek." };
  }
  const officialSameWeek = usedOfficial.find((entry) => entry.gameweek === gameweek);
  if (officialSameWeek && officialSameWeek.kind !== kind) {
    return { legal: false, reason: "Only one chip can be used per Gameweek." };
  }
  if (kind === "freehit") {
    const adjacent = [gameweek - 1, gameweek + 1].some((gw) => {
      const official = usedOfficial.some((entry) => entry.kind === "freehit" && entry.gameweek === gw);
      return official || plannedChips[gw] === "freehit";
    });
    if (adjacent) return { legal: false, reason: "Free Hits cannot be played in consecutive Gameweeks." };
  }
  return { legal: true };
}

export function chipLabel(kind: ChipKind | null): string {
  if (kind === "wildcard") return "WC";
  if (kind === "freehit") return "FH";
  if (kind === "bboost") return "BB";
  if (kind === "3xc") return "TC";
  return "NONE";
}
