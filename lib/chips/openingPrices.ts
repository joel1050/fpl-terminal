/** One row of FPL's element-summary history: the player's price that gameweek. */
export type SummaryLike = { history: ReadonlyArray<{ round?: number; value?: number }> };

export interface OpeningPrice {
  priceTenths: number;
  /** True when the price came from the requested gameweek itself. */
  exact: boolean;
}

/**
 * The player's price at `gameweek`, read from their own per-gameweek history.
 * Prices do not move before the season's first deadline, so a GW1 row is the
 * purchase price for anyone in the opening squad. A player who had no fixture
 * that week yields the earliest later row, flagged inexact.
 */
export function openingPriceFromSummary(
  summary: SummaryLike | null | undefined,
  gameweek: number,
): OpeningPrice | undefined {
  if (!summary || !Array.isArray(summary.history)) return undefined;
  let best: { round: number; value: number } | undefined;
  for (const row of summary.history) {
    const round = row.round;
    const value = row.value;
    if (round === undefined || value === undefined) continue;
    if (!Number.isSafeInteger(round) || !Number.isFinite(value)) continue;
    if (round < gameweek) continue;
    if (!best || round < best.round) best = { round, value: Math.trunc(value) };
  }
  if (!best) return undefined;
  return { priceTenths: best.value, exact: best.round === gameweek };
}

export function openingPricesFromSummaries(
  summaries: ReadonlyMap<number, SummaryLike | null>,
  gameweek: number,
): Record<number, OpeningPrice> {
  const result: Record<number, OpeningPrice> = {};
  for (const [id, summary] of summaries) {
    const price = openingPriceFromSummary(summary, gameweek);
    if (price) result[id] = price;
  }
  return result;
}
