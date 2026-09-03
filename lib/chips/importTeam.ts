import type { ChipKind, FinancialConfidence, TransferBaseline } from "@/types/chips";
import type { Position } from "@/types/player";
import { SEASON_CHIP_POLICY, normalizeChipName } from "./seasonPolicy";
import { accountNormalTransfers, freeTransfersAfterChipWeek } from "./finance";

export interface OfficialTransferRecord {
  elementIn: number;
  elementOut: number;
  elementInCost: number;
  elementOutCost: number;
  event: number;
  time?: string;
}

export interface ImportReconstructionInput {
  /** Initial picks (GW1 or started_event) element ids in squad order. */
  initialSquadIds: number[];
  initialPricesTenths: Record<number, number>;
  /**
   * Ids whose `initialPricesTenths` entry is a real opening price read from the
   * player's own history. Any other entry is a current-price stand-in and
   * forces ESTIMATED, because today's price is not what the manager paid.
   */
  verifiedInitialPriceIds?: readonly number[];
  startedEvent: number;
  currentGameweek: number;
  /** Current official squad element ids (permanent squad; FH weeks resolved by caller). */
  currentSquadIds: number[];
  currentPricesTenths: Record<number, number>;
  bankTenths: number;
  transfers: OfficialTransferRecord[];
  chips: Array<{ kind: ChipKind; gameweek: number }>;
  byPosition?: Record<Position, number[]>;
}

export interface ImportReconstruction {
  baseline: TransferBaseline;
  usedChips: Array<{ kind: ChipKind; gameweek: number }>;
  freeHitImport: boolean;
  warnings: string[];
}

/**
 * Reconstructs purchase prices from starting prices and incoming transfer
 * costs, and replays official transfer counts, hit costs, and WC/FH usage to
 * derive the current free-transfer balance. All money stays in integer tenths.
 */
export function reconstructImportBaseline(input: ImportReconstructionInput): ImportReconstruction {
  const warnings: string[] = [];
  const purchasePrices: Record<number, number> = {};
  let confidence: FinancialConfidence = "EXACT";

  const verified = new Set(input.verifiedInitialPriceIds ?? []);
  const standIns: number[] = [];
  for (const id of input.initialSquadIds) {
    const price = input.initialPricesTenths[id];
    if (price === undefined) {
      purchasePrices[id] = input.currentPricesTenths[id] ?? 0;
      confidence = "ESTIMATED";
      warnings.push(`Missing starting price for player ${id}; current price used.`);
    } else {
      purchasePrices[id] = Math.trunc(price);
      if (!verified.has(id)) standIns.push(id);
    }
  }

  // Incoming transfer costs give exact purchase prices for bought players.
  const sorted = [...input.transfers].sort((a, b) => a.event - b.event);
  for (const transfer of sorted) {
    purchasePrices[transfer.elementIn] = Math.trunc(transfer.elementInCost);
  }

  // A stand-in only matters if that player is still owned and was never bought
  // through a recorded transfer — otherwise the transfer cost already replaced it.
  const boughtIds = new Set(sorted.map((transfer) => transfer.elementIn));
  const currentSet = new Set(input.currentSquadIds);
  const unverifiedOwned = standIns.filter((id) => currentSet.has(id) && !boughtIds.has(id));
  if (unverifiedOwned.length > 0) {
    confidence = "ESTIMATED";
    warnings.push(
      `Opening prices unavailable for ${unverifiedOwned.length} owned player(s); current price used, so selling values may be too high.`,
    );
  }

  // Players in the current squad never bought via a recorded transfer keep
  // their initial price when available; otherwise fall back to current price.
  for (const id of input.currentSquadIds) {
    if (purchasePrices[id] === undefined) {
      const current = input.currentPricesTenths[id];
      if (current === undefined) {
        purchasePrices[id] = 0;
      } else {
        purchasePrices[id] = Math.trunc(current);
      }
      confidence = "ESTIMATED";
      warnings.push(`No purchase record for player ${id}; current price used and finances marked ESTIMATED.`);
    }
  }

  // Late-starting or incomplete histories: missing transfer rows.
  const expectedSpan = Math.max(0, input.currentGameweek - input.startedEvent);
  if (input.startedEvent > 1) {
    confidence = "ESTIMATED";
    warnings.push(`Team started in GW${input.startedEvent}; earlier purchase prices use current prices.`);
  } else if (expectedSpan > 0 && sorted.length === 0 && input.currentSquadIds.some((id) => !input.initialSquadIds.includes(id))) {
    confidence = "ESTIMATED";
    warnings.push("Transfer history is incomplete; missing purchase prices use current prices.");
  }

  // Replay official transfer counts to derive the free-transfer balance.
  // Group transfers by event; WC/FH weeks are unlimited and free.
  const byEvent = new Map<number, number>();
  for (const transfer of sorted) byEvent.set(transfer.event, (byEvent.get(transfer.event) ?? 0) + 1);
  const chipByEvent = new Map<number, ChipKind>();
  for (const chip of input.chips) chipByEvent.set(chip.gameweek, chip.kind);

  let free = 1;
  // Free transfers accrue from the gameweek AFTER the team started:
  // selections for the starting gameweek itself are unlimited initial
  // building, so event==startedEvent transfers consume nothing. The opening
  // allowance going into startedEvent+1 is a single free transfer.
  for (let gw = input.startedEvent + 1; gw < input.currentGameweek; gw += 1) {
    const count = byEvent.get(gw) ?? 0;
    const chip = chipByEvent.get(gw);
    if (chip === "wildcard" || chip === "freehit") {
      free = freeTransfersAfterChipWeek(free);
      continue;
    }
    free = accountNormalTransfers(count, free).freeTransfersAfter;
  }
  // Transfers already made for the current gameweek come out of the balance
  // (no new transfer accrues until next week). A Wildcard/Free Hit played
  // for the current week keeps them free instead.
  let freeNow = free;
  if (input.currentGameweek > input.startedEvent) {
    const currentCount = byEvent.get(input.currentGameweek) ?? 0;
    const currentChip = chipByEvent.get(input.currentGameweek);
    freeNow = currentChip === "wildcard" || currentChip === "freehit"
      ? freeTransfersAfterChipWeek(free)
      : Math.max(0, free - Math.min(currentCount, free));
  }

  const byPosition: Record<Position, number[]> = input.byPosition ?? { GK: [], DEF: [], MID: [], FWD: [] };

  return {
    baseline: {
      squadPlayerIds: [...input.currentSquadIds],
      byPosition,
      bankTenths: Math.trunc(input.bankTenths),
      freeTransfers: Math.max(0, Math.min(SEASON_CHIP_POLICY.maxFreeTransfers, freeNow)),
      purchasePricesTenths: purchasePrices,
      financialConfidence: confidence,
      startGameweek: input.currentGameweek,
      warnings: [...warnings],
    },
    usedChips: [...input.chips],
    freeHitImport: false,
    warnings,
  };
}

export function officialChipsFromHistory(chips: Array<{ name?: string; event?: number }>): Array<{ kind: ChipKind; gameweek: number }> {
  const result: Array<{ kind: ChipKind; gameweek: number }> = [];
  for (const chip of chips) {
    const kind = normalizeChipName(chip.name ?? null);
    if (kind && Number.isSafeInteger(chip.event) && (chip.event as number) >= 1 && (chip.event as number) <= 38) {
      result.push({ kind, gameweek: chip.event as number });
    }
  }
  return result;
}
