import type { TransferBaseline } from "@/types/chips";
import { sellingPriceTenths } from "./finance";

export interface BaselineCheck {
  /** Team value implied by the reconstructed purchase prices, in tenths. */
  impliedValueTenths: number;
  /** Team value FPL reports for the same gameweek, in tenths. */
  reportedValueTenths: number;
  /** implied − reported. Positive means the reconstruction is too generous. */
  deltaTenths: number;
  matches: boolean;
}

type PriceSource = Record<number, number> | ReadonlyMap<number, number>;

function priceOf(prices: PriceSource, id: number): number | undefined {
  return prices instanceof Map ? prices.get(id) : (prices as Record<number, number>)[id];
}

function money(tenths: number): string {
  return `£${(tenths / 10).toFixed(1)}m`;
}

/**
 * FPL publishes the answer key: entry_history.value equals the bank plus the
 * selling value of the squad. Recomputing it from reconstructed purchase
 * prices says whether the reconstruction is right.
 */
export function verifyBaselineValue(
  baseline: TransferBaseline,
  currentPricesTenths: PriceSource,
  reportedValueTenths: number,
): BaselineCheck {
  const reported = Math.trunc(reportedValueTenths);
  let implied = Math.trunc(baseline.bankTenths);
  let complete = true;
  for (const id of baseline.squadPlayerIds) {
    const current = priceOf(currentPricesTenths, id);
    if (current === undefined) {
      complete = false;
      continue;
    }
    const purchase = baseline.purchasePricesTenths[id] ?? current;
    implied += sellingPriceTenths(purchase, current);
  }
  const delta = implied - reported;
  return {
    impliedValueTenths: implied,
    reportedValueTenths: reported,
    deltaTenths: delta,
    matches: complete && delta === 0,
  };
}

/**
 * Downgrades confidence when the checksum disagrees. Never upgrades: agreeing
 * in aggregate does not prove each player's purchase price, and individual
 * transfers depend on the per-player figure.
 */
export function applyBaselineCheck(
  baseline: TransferBaseline,
  check: BaselineCheck,
): TransferBaseline {
  if (check.matches) return baseline;
  const direction = check.deltaTenths > 0 ? "too high" : "too low";
  return {
    ...baseline,
    financialConfidence: "ESTIMATED",
    warnings: [
      ...baseline.warnings,
      `Reconstructed team value is ${money(check.impliedValueTenths)} but FPL reports ${money(check.reportedValueTenths)}`
        + ` (${money(Math.abs(check.deltaTenths))} ${direction}); finances are ESTIMATED.`,
    ],
  };
}
