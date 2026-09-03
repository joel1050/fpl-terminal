import type { Position } from "./player";

/** Upstream-compatible chip identifiers. Assistant Manager and retired chips are out of scope. */
export type ChipKind = "wildcard" | "freehit" | "bboost" | "3xc";

export type FinancialConfidence = "EXACT" | "ESTIMATED";

export interface PlannedTransfer {
  outId: number;
  inId: number;
  /** Position of the slot being changed. */
  position: Position;
}

export interface TransferBaseline {
  /** Permanent squad at the replay start (usually the imported official squad). */
  squadPlayerIds: number[];
  byPosition: Record<Position, number[]>;
  /** Cash in bank in integer tenths. */
  bankTenths: number;
  /** Free transfers available at the replay start. */
  freeTransfers: number;
  /** Purchase price per owned player in integer tenths. */
  purchasePricesTenths: Record<number, number>;
  financialConfidence: FinancialConfidence;
  /** First gameweek the baseline applies to (usually current GW). */
  startGameweek: number;
  warnings: string[];
}

export interface ChipInventory {
  wildcard: number[];
  freehit: number[];
  bboost: number[];
  "3xc": number[];
}

export interface SeasonChipPolicy {
  firstWindow: { from: number; to: number };
  secondWindow: { from: number; to: number };
  maxFreeTransfers: number;
  maxTransfersPerGameweek: number;
  hitCostPerTransferTenthsPoints: number;
  /** Fraction of price rise kept on sale, e.g. 0.5. */
  sellProfitFraction: number;
  chipsPerWindow: Record<ChipKind, number>;
}
