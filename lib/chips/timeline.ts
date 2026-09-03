import type { ChipKind, PlannedTransfer, TransferBaseline } from "@/types/chips";
import type { Position } from "@/types/player";
import { SEASON_CHIP_POLICY } from "./seasonPolicy";
import { accountNormalTransfers, applySale, freeTransfersAfterChipWeek, sellingPriceTenths } from "./finance";

export interface TimelinePlanInput {
  playerIds: number[];
  chip: ChipKind | null;
  byPosition?: Record<Position, number[]>;
}

export interface TimelineWeek {
  gameweek: number;
  chip: ChipKind | null;
  /** Permanent squad after this gameweek's transfers (FH does not change it). */
  permanentSquadIds: number[];
  /** Squad that scores this gameweek (temporary under FH). */
  activeSquadIds: number[];
  transfers: PlannedTransfer[];
  bankTenths: number;
  freeTransfersBefore: number;
  freeTransfersAfter: number;
  hitCost: number;
  purchasePricesTenths: Record<number, number>;
  warnings: string[];
  isChipFree: boolean;
}

export interface ReplayTimelineInput {
  baseline: TransferBaseline;
  plans: Record<number, TimelinePlanInput | undefined>;
  priceById: ReadonlyMap<number, number> | Record<number, number>;
  positionById?: ReadonlyMap<number, Position> | Record<number, Position>;
  fromGameweek?: number;
  toGameweek?: number;
}

function priceOf(priceById: ReplayTimelineInput["priceById"], id: number): number | undefined {
  if (priceById instanceof Map) return priceById.get(id);
  return (priceById as Record<number, number>)[id];
}

function positionOf(
  positionById: ReplayTimelineInput["positionById"],
  fallback: Record<Position, number[]> | undefined,
  id: number,
): Position {
  if (positionById instanceof Map) {
    const found = positionById.get(id);
    if (found) return found;
  } else if (positionById) {
    const found = (positionById as Record<number, Position>)[id];
    if (found) return found;
  }
  if (fallback) {
    for (const position of ["GK", "DEF", "MID", "FWD"] as Position[]) {
      if (fallback[position]?.includes(id)) return position;
    }
  }
  return "MID";
}

function diffSquads(before: readonly number[], after: readonly number[], positionById: ReplayTimelineInput["positionById"], byPosition?: Record<Position, number[]>): PlannedTransfer[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const outs = before.filter((id) => !afterSet.has(id));
  const ins = after.filter((id) => !beforeSet.has(id));
  const count = Math.min(outs.length, ins.length);
  const transfers: PlannedTransfer[] = [];
  for (let i = 0; i < count; i += 1) {
    transfers.push({ outId: outs[i], inId: ins[i], position: positionOf(positionById, byPosition, ins[i]) });
  }
  return transfers;
}

/**
 * Shared timeline calculator: replays plans from the baseline and returns each
 * gameweek's permanent squad, active squad, bank, free transfers, hit cost,
 * purchase prices, and warnings. All money stays in integer tenths.
 */
export function replayTimeline(input: ReplayTimelineInput): Record<number, TimelineWeek> {
  const from = input.fromGameweek ?? input.baseline.startGameweek;
  const planKeys = Object.keys(input.plans).map(Number).filter((gw) => Number.isSafeInteger(gw));
  const to = input.toGameweek ?? Math.max(from, ...planKeys, from);
  const result: Record<number, TimelineWeek> = {};

  let permanent = [...input.baseline.squadPlayerIds];
  let bank = Math.trunc(input.baseline.bankTenths);
  let freeTransfers = Math.max(0, Math.min(SEASON_CHIP_POLICY.maxFreeTransfers, Math.trunc(input.baseline.freeTransfers)));
  let purchasePrices: Record<number, number> = { ...input.baseline.purchasePricesTenths };

  for (let gw = from; gw <= to; gw += 1) {
    const plan = input.plans[gw];
    const warnings: string[] = [];
    const chip = plan?.chip ?? null;
    const target = plan ? [...plan.playerIds] : [...permanent];
    const isChipFree = chip === "wildcard" || chip === "freehit";
    const transfers = diffSquads(permanent, target, input.positionById, plan?.byPosition);

    if (transfers.length > SEASON_CHIP_POLICY.maxTransfersPerGameweek) {
      warnings.push(`GW${gw}: ${transfers.length} transfers exceed the ${SEASON_CHIP_POLICY.maxTransfersPerGameweek}-transfer cap; only the first ${SEASON_CHIP_POLICY.maxTransfersPerGameweek} are costed.`);
    }
    const costedCount = Math.min(transfers.length, SEASON_CHIP_POLICY.maxTransfersPerGameweek);

    if (isChipFree) {
      // Unlimited and free. Apply sales/purchases to bank + purchase prices.
      let nextBank = bank;
      const nextPrices: Record<number, number> = { ...purchasePrices };
      const costed = transfers.slice(0, costedCount);
      // Validate funds using selling values; collect warnings instead of blocking.
      for (const transfer of costed) {
        const buyPrice = priceOf(input.priceById, transfer.inId);
        const sellCurrent = priceOf(input.priceById, transfer.outId);
        if (buyPrice === undefined || sellCurrent === undefined) {
          warnings.push(`GW${gw}: missing price for transfer ${transfer.outId}→${transfer.inId}; bank may be inaccurate.`);
          continue;
        }
        const ownedPurchase = nextPrices[transfer.outId] ?? sellCurrent;
        nextBank = applySale(nextBank, ownedPurchase, sellCurrent) - Math.trunc(buyPrice);
        delete nextPrices[transfer.outId];
        nextPrices[transfer.inId] = Math.trunc(buyPrice);
      }
      if (nextBank < 0) warnings.push(`GW${gw}: transfers exceed the available selling value plus bank.`);
      const freeAfter = freeTransfersAfterChipWeek(freeTransfers);
      const active = [...target];
      const nextPermanent = chip === "wildcard" ? [...target] : [...permanent];
      // Wildcard permanence: purchase prices follow the new permanent squad.
      // Free Hit: permanent purchase prices only change for the permanent squad
      // (unchanged), while the temporary squad is priced separately next week.
      const permanentPrices: Record<number, number> = chip === "wildcard" ? { ...nextPrices } : { ...purchasePrices };
      // For FH weeks, price the temporary actives for display but keep permanent ledger.
      if (chip === "freehit") {
        for (const transfer of costed) {
          const buyPrice = priceOf(input.priceById, transfer.inId);
          if (buyPrice !== undefined) nextPrices[transfer.inId] = Math.trunc(buyPrice);
        }
      }
      result[gw] = {
        gameweek: gw,
        chip,
        permanentSquadIds: nextPermanent,
        activeSquadIds: active,
        transfers: costed,
        bankTenths: nextBank,
        freeTransfersBefore: freeTransfers,
        freeTransfersAfter: freeAfter,
        hitCost: 0,
        purchasePricesTenths: chip === "wildcard" ? permanentPrices : permanentPrices,
        warnings,
        isChipFree,
      };
      permanent = nextPermanent;
      bank = nextBank;
      purchasePrices = permanentPrices;
      freeTransfers = freeAfter;
      continue;
    }

    // Normal week: permanent squad follows the plan.
    const accounting = accountNormalTransfers(costedCount, freeTransfers);
    let nextBank = bank;
    const nextPrices: Record<number, number> = { ...purchasePrices };
    const costed = transfers.slice(0, costedCount);
    for (const transfer of costed) {
      const buyPrice = priceOf(input.priceById, transfer.inId);
      const sellCurrent = priceOf(input.priceById, transfer.outId);
      if (buyPrice === undefined || sellCurrent === undefined) {
        warnings.push(`GW${gw}: missing price for transfer ${transfer.outId}→${transfer.inId}; bank may be inaccurate.`);
        continue;
      }
      const ownedPurchase = nextPrices[transfer.outId] ?? sellCurrent;
      void sellingPriceTenths(ownedPurchase, sellCurrent);
      nextBank = applySale(nextBank, ownedPurchase, sellCurrent) - Math.trunc(buyPrice);
      delete nextPrices[transfer.outId];
      nextPrices[transfer.inId] = Math.trunc(buyPrice);
    }
    if (nextBank < 0) warnings.push(`GW${gw}: transfers exceed the available selling value plus bank.`);
    if (accounting.hitCost > 0) warnings.push(`GW${gw}: ${accounting.paidTransfers} transfer(s) beyond the allowance cost ${accounting.hitCost} points.`);
    result[gw] = {
      gameweek: gw,
      chip,
      permanentSquadIds: [...target],
      activeSquadIds: [...target],
      transfers: costed,
      bankTenths: nextBank,
      freeTransfersBefore: freeTransfers,
      freeTransfersAfter: accounting.freeTransfersAfter,
      hitCost: accounting.hitCost,
      purchasePricesTenths: { ...nextPrices },
      warnings,
      isChipFree,
    };
    permanent = [...target];
    bank = nextBank;
    purchasePrices = { ...nextPrices };
    freeTransfers = accounting.freeTransfersAfter;
  }

  return result;
}

export function timelineWarnings(timeline: Record<number, TimelineWeek>): string[] {
  return Object.values(timeline).flatMap((week) => week.warnings);
}
