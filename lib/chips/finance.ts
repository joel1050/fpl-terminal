import { SEASON_CHIP_POLICY } from "./seasonPolicy";

/** All money uses integer tenths. Never use floating point for money. */
export function toTenths(pounds: number): number {
  return Math.round(pounds * 10);
}

/**
 * Official FPL selling rule: current price when no profit exists, otherwise
 * purchase price plus the configured fraction of the rise, rounded down.
 */
export function sellingPriceTenths(
  purchasePriceTenths: number,
  currentPriceTenths: number,
  profitFraction = SEASON_CHIP_POLICY.sellProfitFraction,
): number {
  const purchase = Math.trunc(purchasePriceTenths);
  const current = Math.trunc(currentPriceTenths);
  if (!Number.isSafeInteger(purchase) || !Number.isSafeInteger(current)) return current;
  if (current <= purchase) return current;
  const profit = Math.floor((current - purchase) * profitFraction);
  return purchase + profit;
}

export interface SquadFinanceSnapshot {
  purchasePricesTenths: Record<number, number>;
  sellingPricesTenths: Record<number, number>;
  squadSellingValueTenths: number;
  spendableBudgetTenths: number;
}

/** Prices the active squad without changing the players' live market prices. */
export function squadFinanceSnapshot(
  playerIds: readonly number[],
  bankTenths: number,
  purchasePricesTenths: Readonly<Record<number, number>>,
  currentPricesTenths: ReadonlyMap<number, number>,
): SquadFinanceSnapshot {
  const purchases: Record<number, number> = {};
  const selling: Record<number, number> = {};
  for (const id of playerIds) {
    const current = currentPricesTenths.get(id);
    if (current === undefined) continue;
    const purchase = purchasePricesTenths[id] ?? current;
    purchases[id] = purchase;
    selling[id] = sellingPriceTenths(purchase, current);
  }
  const squadSellingValueTenths = Object.values(selling).reduce((sum, price) => sum + price, 0);
  return {
    purchasePricesTenths: purchases,
    sellingPricesTenths: selling,
    squadSellingValueTenths,
    spendableBudgetTenths: Math.trunc(bankTenths) + squadSellingValueTenths,
  };
}

export interface TransferCountResult {
  /** Normal transfers that consume free transfers / cost hits. */
  normalTransfers: number;
  /** Transfers beyond the available allowance. */
  paidTransfers: number;
  hitCost: number;
  freeTransfersAfter: number;
}

/**
 * Normal transfer accounting: at most five saved free transfers, at most 20
 * normal transfers per gameweek, four points per transfer beyond the allowance.
 * Wildcard and Free Hit gameweeks are unlimited and free: the week's new free
 * transfer is consumed while previously saved transfers remain available after.
 */
export function accountNormalTransfers(
  transferCount: number,
  freeTransfersBefore: number,
): TransferCountResult {
  const capped = Math.max(0, Math.min(SEASON_CHIP_POLICY.maxTransfersPerGameweek, Math.trunc(transferCount)));
  const available = Math.max(0, Math.min(SEASON_CHIP_POLICY.maxFreeTransfers, Math.trunc(freeTransfersBefore)));
  const freeUsed = Math.min(capped, available);
  const paid = capped - freeUsed;
  const remaining = available - freeUsed;
  const after = Math.min(SEASON_CHIP_POLICY.maxFreeTransfers, remaining + 1);
  return {
    normalTransfers: capped,
    paidTransfers: paid,
    hitCost: paid * SEASON_CHIP_POLICY.hitCostPerTransferTenthsPoints,
    freeTransfersAfter: Math.max(0, after),
  };
}

/** Free transfer balance after a Wildcard/Free Hit week: saved transfers carry on. */
export function freeTransfersAfterChipWeek(savedBefore: number): number {
  const saved = Math.max(0, Math.min(SEASON_CHIP_POLICY.maxFreeTransfers, Math.trunc(savedBefore)));
  // The week's new free transfer is consumed by the chip; saved ones persist.
  return Math.max(0, Math.min(SEASON_CHIP_POLICY.maxFreeTransfers, saved));
}

export function applySale(
  bankTenths: number,
  purchasePriceTenths: number,
  currentPriceTenths: number,
): number {
  return Math.trunc(bankTenths) + sellingPriceTenths(purchasePriceTenths, currentPriceTenths);
}
