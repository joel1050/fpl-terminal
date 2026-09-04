"use client";

import { useMemo, useState } from "react";
import type { Player, Position } from "@/types";
import type { ChipKind } from "@/types/chips";
import { baselineWithMigrationFallback, useTerminalStore } from "@/store/terminalStore";
import { chipLabel, validateChipSelection } from "@/lib/chips/seasonPolicy";
import { replayTimeline } from "@/lib/chips/timeline";
import { squadFinanceSnapshot } from "@/lib/chips/finance";
import { pickWeeklyTeam } from "@/lib/squad/weeklyLineup";

export type ChipSuggestion = {
  chip: ChipKind;
  gameweek: number;
  baselineXp: number;
  chipPlanXp: number;
  incrementalXp: number;
  squad?: { playerIds: number[]; byPosition: Record<Position, number[]> };
  transfers?: Array<{ outId: number; inId: number; position: Position }>;
  lineup?: { starterIds: number[]; benchGoalkeeperId: number; benchOrder: number[]; captainId: number; viceCaptainId: number; projectedTotal: number };
  financialConfidence: "EXACT" | "ESTIMATED";
  reasons: string[];
};

const CHIP_OPTIONS: Array<{ kind: ChipKind | null; label: string }> = [
  { kind: null, label: "NONE" },
  { kind: "wildcard", label: "WC" },
  { kind: "freehit", label: "FH" },
  { kind: "bboost", label: "BB" },
  { kind: "3xc", label: "TC" },
];

/** Compact chip selector beside the Gameweek switcher. */
export function ChipSelector({ gameweek, onNotice }: { gameweek: number; onNotice: (text: string) => void }) {
  const chip = useTerminalStore((state) => state.chip);
  const gameweekPlans = useTerminalStore((state) => state.gameweekPlans);
  const usedChips = useTerminalStore((state) => state.usedChips);
  const currentGameweek = useTerminalStore((state) => state.currentGameweek);
  const setChip = useTerminalStore((state) => state.setChip);

  const planned: Record<number, ChipKind | null> = useMemo(() => {
    const result: Record<number, ChipKind | null> = {};
    for (const [key, plan] of Object.entries(gameweekPlans)) result[Number(key)] = plan.chip;
    result[gameweek] = chip;
    return result;
  }, [gameweekPlans, gameweek, chip]);

  return (
    <div className="chip-selector" role="group" aria-label="Select chip for this Gameweek">
      {CHIP_OPTIONS.map((option) => {
        const active = (chip ?? null) === option.kind;
        const validation = option.kind === null
          ? { legal: true as const }
          : validateChipSelection(
              option.kind,
              gameweek,
              usedChips,
              Object.fromEntries(Object.entries(planned).filter(([key]) => Number(key) !== gameweek)),
              currentGameweek,
            );
        return (
          <button
            key={option.label}
            type="button"
            className={`chip-option ${active ? "active" : ""}`}
            aria-pressed={active}
            disabled={!validation.legal}
            title={validation.legal ? `${option.label} for GW${gameweek}` : ("reason" in validation ? validation.reason : "")}
            onClick={() => {
              if (option.kind === chip) return;
              if (!setChip(gameweek, option.kind)) {
                onNotice(`That chip cannot be used in GW${gameweek}.`);
                return;
              }
              onNotice(option.kind ? `${chipLabel(option.kind)} planned for GW${gameweek}.` : `Chip cleared for GW${gameweek}.`);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export type WeekFinance = {
  chip: ChipKind | null;
  isChipFree: boolean;
  freeTransfersBefore: number;
  freeTransfersAfter: number;
  hitCost: number;
  bankTenths: number;
  /** Current replayed purchase ledger for every owned player. */
  purchasePricesTenths: Record<number, number>;
  /** Official selling price per currently owned player. */
  sellingPricesTenths: Record<number, number>;
  /** Sum of official selling values for the current squad. */
  squadSellingValueTenths: number;
  /** ITB plus total selling value: the budget the optimizer can spend. */
  spendableBudgetTenths: number;
  confidence: "EXACT" | "ESTIMATED";
  warnings: string[];
};

/** Replays the saved timeline to the planning Gameweek for transfer accounting. */
export function usePlanningWeekFinance(
  players: readonly Player[],
  planningGameweek: number,
): WeekFinance | null {
  const gameweekPlans = useTerminalStore((state) => state.gameweekPlans);
  const playerIds = useTerminalStore((state) => state.playerIds);
  const byPosition = useTerminalStore((state) => state.byPosition);
  const chip = useTerminalStore((state) => state.chip);
  const plannedTransfers = useTerminalStore((state) => state.plannedTransfers);
  const transferBaseline = useTerminalStore((state) => state.transferBaseline);
  const budgetTenths = useTerminalStore((state) => state.budgetTenths);

  return useMemo(() => {
    if (!playerIds.length) return null;
    const priceById = new Map(players.map((player) => [player.id, player.priceTenths]));
    const baseline = baselineWithMigrationFallback(transferBaseline, playerIds, byPosition, budgetTenths, planningGameweek, priceById);
    const from = Math.min(baseline.startGameweek, planningGameweek);
    const positionById = new Map(players.map((player) => [player.id, player.position]));
    const plans: Record<number, { playerIds: number[]; chip: ChipKind | null }> = {};
    for (const [key, plan] of Object.entries(gameweekPlans)) {
      const gw = Number(key);
      if (gw >= from && gw <= planningGameweek) plans[gw] = { playerIds: [...plan.playerIds], chip: plan.chip };
    }
    plans[planningGameweek] = { playerIds: [...playerIds], chip };
    void plannedTransfers;
    const timeline = replayTimeline({ baseline, plans, priceById, positionById, fromGameweek: from, toGameweek: planningGameweek });
    const week = timeline[planningGameweek];
    if (!week) return null;
    const finance = squadFinanceSnapshot(playerIds, week.bankTenths, week.purchasePricesTenths, priceById);
    return {
      chip: week.chip,
      isChipFree: week.isChipFree,
      freeTransfersBefore: week.freeTransfersBefore,
      freeTransfersAfter: week.freeTransfersAfter,
      hitCost: week.hitCost,
      bankTenths: week.bankTenths,
      ...finance,
      confidence: baseline.financialConfidence,
      warnings: [...baseline.warnings, ...week.warnings],
    };
  }, [gameweekPlans, playerIds, byPosition, chip, plannedTransfers, transferBaseline, budgetTenths, players, planningGameweek]);
}

/** Chip Strategy panel: remaining inventory plus ranked marginal suggestions. */
export function ChipStrategyPanel({
  players,
  planningGameweek,
  onNotice,
}: {
  players: readonly Player[];
  planningGameweek: number;
  onNotice: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cacheKey, setCacheKey] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ChipSuggestion[]>([]);
  const [state, setState] = useState<"IDLE" | "LOADING" | "READY" | "ERROR">("IDLE");
  const [message, setMessage] = useState<string | null>(null);

  const gameweekPlans = useTerminalStore((state) => state.gameweekPlans);
  const playerIds = useTerminalStore((state) => state.playerIds);
  const byPosition = useTerminalStore((state) => state.byPosition);
  const chip = useTerminalStore((state) => state.chip);
  const benchGoalkeeperId = useTerminalStore((state) => state.benchGoalkeeperId);
  const benchOrder = useTerminalStore((state) => state.benchOrder);
  const captainId = useTerminalStore((state) => state.captainId);
  const viceCaptainId = useTerminalStore((state) => state.viceCaptainId);
  const lockedPlayerIds = useTerminalStore((state) => state.lockedPlayerIds);
  const transferBaseline = useTerminalStore((state) => state.transferBaseline);
  const usedChips = useTerminalStore((state) => state.usedChips);
  const riskMode = useTerminalStore((state) => state.riskMode);
  const budgetTenths = useTerminalStore((state) => state.budgetTenths);
  const applyChipSuggestion = useTerminalStore((state) => state.applyChipSuggestion);
  const undoChipApply = useTerminalStore((state) => state.undoChipApply);
  const preApplySnapshot = useTerminalStore((state) => state.preApplySnapshot);

  const playerById = useMemo(() => new Map(players.map((player) => [player.id, player])), [players]);

  // Two chip sets per season with the first expiring at GW19, so strategy
  // plans to the end of the current chip window, not the end of the season.
  const windowEnd = planningGameweek <= 19 ? 19 : 38;

  const refresh = async () => {
    if (playerIds.length !== 15) {
      onNotice("Complete a legal 15-player squad before running chip advice.");
      return;
    }
    const endGameweek = windowEnd;
    const horizon = endGameweek - planningGameweek + 1;
    const timeline: Record<number, { playerIds: number[]; chip: ChipKind | null; benchGoalkeeperId?: number; benchOrder?: number[]; captainId?: number; viceCaptainId?: number; lockedPlayerIds?: number[] }> = {};
    for (let gw = planningGameweek; gw <= endGameweek; gw += 1) {
      const plan = gameweekPlans[gw];
      if (gw === planningGameweek) {
        timeline[gw] = {
          playerIds: [...playerIds], chip,
          benchGoalkeeperId, benchOrder: [...benchOrder],
          captainId, viceCaptainId, lockedPlayerIds: [...lockedPlayerIds],
        };
      } else if (plan) {
        timeline[gw] = {
          playerIds: [...plan.playerIds], chip: plan.chip,
          benchGoalkeeperId: plan.benchGoalkeeperId, benchOrder: [...plan.benchOrder],
          captainId: plan.captainId, viceCaptainId: plan.viceCaptainId,
          lockedPlayerIds: [...plan.lockedPlayerIds],
        };
      }
    }
    const priceById = new Map(players.map((player) => [player.id, player.priceTenths]));
    const baseline = baselineWithMigrationFallback(transferBaseline, playerIds, byPosition, budgetTenths, planningGameweek, priceById);
    const fingerprint = pickWeeklyTeam({
      squad: playerIds.map((id) => playerById.get(id)).filter((player): player is Player => Boolean(player)),
      gameweek: planningGameweek,
      riskMode,
    }).projectionFingerprint;
    const key = JSON.stringify({ timeline, baseline, fingerprint, horizon, risk: riskMode, locks: lockedPlayerIds });
    // Cache results by timeline and projection fingerprint to avoid repeated solver work.
    if (key === cacheKey && state === "READY") return;
    setState("LOADING");
    setMessage(null);
    try {
      const response = await fetch("/api/chip-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameweek: planningGameweek,
          horizon,
          risk: riskMode,
          timeline,
          usedChips,
          lockedPlayerIds,
          baseline: {
            ...baseline,
            purchasePricesTenths: Object.fromEntries(Object.entries(baseline.purchasePricesTenths).map(([id, price]) => [String(id), price])),
          },
          budgetTenths,
        }),
      });
      const body = await response.json() as { suggestions?: ChipSuggestion[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Chip advice failed");
      setSuggestions(Array.isArray(body.suggestions) ? body.suggestions : []);
      setCacheKey(key);
      setState("READY");
    } catch (error) {
      setState("ERROR");
      setMessage(error instanceof Error ? error.message : "Chip advice failed");
    }
  };

  const apply = (suggestion: ChipSuggestion) => {
    const squadPlayers = suggestion.squad
      ? suggestion.squad.playerIds.map((id) => playerById.get(id)).filter((player): player is Player => Boolean(player))
      : playerIds.map((id) => playerById.get(id)).filter((player): player is Player => Boolean(player));
    if (squadPlayers.length !== 15) {
      onNotice("The suggested squad is missing from the current market data.");
      return;
    }
    const fingerprintChip = suggestion.chip === "bboost" || suggestion.chip === "3xc" ? suggestion.chip : null;
    const fingerprint = pickWeeklyTeam({ squad: squadPlayers, gameweek: suggestion.gameweek, riskMode, chip: fingerprintChip }).projectionFingerprint;
    const lineup = suggestion.lineup ? {
      gameweek: suggestion.gameweek,
      lineupProjectionFingerprint: fingerprint,
      benchGoalkeeperId: suggestion.lineup.benchGoalkeeperId,
      benchOrder: [...suggestion.lineup.benchOrder],
      captainId: suggestion.lineup.captainId,
      viceCaptainId: suggestion.lineup.viceCaptainId,
    } : undefined;
    const applied = applyChipSuggestion({
      gameweek: suggestion.gameweek,
      chip: suggestion.chip,
      squad: suggestion.squad ? { playerIds: [...suggestion.squad.playerIds], byPosition: { ...suggestion.squad.byPosition, GK: [...suggestion.squad.byPosition.GK], DEF: [...suggestion.squad.byPosition.DEF], MID: [...suggestion.squad.byPosition.MID], FWD: [...suggestion.squad.byPosition.FWD] } } : undefined,
      lineup,
      plannedTransfers: suggestion.transfers?.map((transfer) => ({ ...transfer })),
    });
    if (applied) onNotice(`${chipLabel(suggestion.chip)} advice applied for GW${suggestion.gameweek}.`);
    else onNotice("That chip suggestion is no longer legal for the saved timeline.");
  };

  if (!open) {
    return (
      <section className="panel chip-strategy" aria-label="Chip strategy">
      <div className="subsection-head">
        <div><span className="section-kicker">CHIP STRATEGY</span><span className="panel-count">GW{planningGameweek}–{windowEnd}</span></div>
          <button type="button" className="compact-action" onClick={() => { setOpen(true); void refresh(); }}>ANALYZE CHIPS</button>
        </div>
      </section>
    );
  }

  return (
    <section className="panel chip-strategy" aria-label="Chip strategy">
      <div className="subsection-head">
        <div><span className="section-kicker">CHIP STRATEGY</span><span className="panel-count">GW{planningGameweek}–{windowEnd} · {suggestions.length} SUGGESTIONS</span></div>
        <div className="header-actions">
          <button type="button" className="compact-action" onClick={() => void refresh()}>{state === "LOADING" ? "ANALYZING…" : "REFRESH"}</button>
          <button type="button" className="compact-action" onClick={() => setOpen(false)}>CLOSE</button>
          {preApplySnapshot && <button type="button" className="compact-action" onClick={() => { if (undoChipApply()) onNotice("Chip advice undone."); }}>UNDO</button>}
        </div>
      </div>
      <div className="replacement-scroll">
        {state === "LOADING" && <div className="empty-copy">SOLVING CHIP PLANS (GW{planningGameweek}–{windowEnd})…</div>}
        {state === "ERROR" && <div className="empty-copy">{message ?? "Chip advice is unavailable."}</div>}
        {state === "READY" && !suggestions.length && <div className="empty-copy">No chips remain in this window.</div>}
        {state === "READY" && suggestions.map((suggestion) => (
          <div className="replacement-row" key={`${suggestion.chip}-${suggestion.gameweek}`}>
            <div>
              <strong>{chipLabel(suggestion.chip)} · GW{suggestion.gameweek}</strong>
              <small>
                {suggestion.incrementalXp > 0 ? `+${suggestion.incrementalXp.toFixed(1)} xP vs saved plan` : "no projected edge"}
              </small>
            </div>
            <div className="transfer-effects">
              <span className={suggestion.incrementalXp > 0 ? "green" : ""}>
                {suggestion.incrementalXp > 0 ? "+" : ""}{suggestion.incrementalXp.toFixed(1)} xP
              </span>
            </div>
            <div className="transfer-actions">
              <button type="button" className="compact-action" onClick={() => apply(suggestion)}>APPLY</button>
            </div>
            {!!suggestion.reasons.length && <small className="chip-reason">{suggestion.reasons[0]}</small>}
          </div>
        ))}
      </div>
    </section>
  );
}
