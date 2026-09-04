import loadHighs from "highs";
import { sellingPriceTenths } from "@/lib/chips/finance";
import { projectWeeklyLineupTotal } from "@/lib/squad/weeklyLineup";
import { candidatePool } from "@/lib/optimizer/optimizer";
import {
  gameweekValue,
  hasAvailabilityRisk,
  playerMap,
  POSITIONS,
  POSITION_MINIMUMS,
} from "@/lib/analysis/context";
import type { Player, Position } from "@/types/player";
import type { Horizon } from "@/types/projection";
import type { SingleTransferSuggestion } from "@/types/analysis";

const STARTER_MINIMUMS: Record<Position, number> = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
const highsPromise = loadHighs();

export interface MilpTransferOptions {
  squad: number[] | Player[];
  players: Player[];
  bankTenths: number;
  purchasePricesTenths?: Record<number, number>;
  gameweek: number;
  horizon: Horizon;
  maxTransfers?: number;
  lockedPlayerIds?: number[];
  excludedPlayerIds?: number[];
  risk?: "SAFE" | "BALANCED" | "AGGRESSIVE";
  budgetTenths?: number;
}

function term(coefficient: number, variable: string): string {
  const sign = coefficient < 0 ? "-" : "+";
  return `${sign} ${Math.abs(coefficient).toFixed(8)} ${variable}`;
}

function expression(terms: Array<[number, string]>): string {
  return (
    terms
      .filter(([coefficient]) => Math.abs(coefficient) > 1e-12)
      .map(([coefficient, variable]) => term(coefficient, variable))
      .join(" ") || "0"
  );
}

export async function findMilpTransferSuggestions(
  options: MilpTransferOptions
): Promise<SingleTransferSuggestion[]> {
  const highs = await highsPromise;
  const {
    squad: rawSquad,
    players: allPlayers,
    bankTenths,
    purchasePricesTenths = {},
    gameweek,
    horizon,
    maxTransfers = 1,
    lockedPlayerIds = [],
    excludedPlayerIds = [],
    risk = "BALANCED",
  } = options;

  const playerUniverseMap = playerMap(allPlayers);
  const squad: Player[] = rawSquad
    .map((item) => (typeof item === "number" ? playerUniverseMap.get(item) : item))
    .filter((p): p is Player => Boolean(p));

  if (squad.length !== 15) return [];

  const squadIds = new Set(squad.map((p) => p.id));
  const lockedIds = new Set(lockedPlayerIds);
  const excludedIds = new Set(excludedPlayerIds);

  const sellingOf = (player: Player): number => {
    const purchase = purchasePricesTenths[player.id];
    return purchase !== undefined
      ? sellingPriceTenths(purchase, player.priceTenths)
      : player.priceTenths;
  };

  const currentSquadSellingValue = squad.reduce((sum, p) => sum + sellingOf(p), 0);
  const totalSpendableBudget = bankTenths + currentSquadSellingValue;

  // Prune candidate pool for fast solve while guaranteeing quality:
  // include top 25 candidates per position + all owned squad members
  const fixed = new Set(squad.map((p) => p.id));
  const prunedCandidates = POSITIONS.flatMap((pos) =>
    candidatePool(allPlayers, pos, { horizon, risk, candidateLimit: 25, excludedPlayerIds }, fixed)
  );

  const candidatePoolMap = playerMap(prunedCandidates);
  for (const player of squad) {
    if (!candidatePoolMap.has(player.id)) {
      candidatePoolMap.set(player.id, player);
    }
  }

  const candidatePoolList = Array.from(candidatePoolMap.values()).filter((p) => {
    if (squadIds.has(p.id)) return true;
    if (excludedIds.has(p.id)) return false;
    if (risk === "SAFE" && hasAvailabilityRisk(p)) return false;
    return p.status === "a" || p.status === "d";
  });

  const costOfPlayer = (player: Player) =>
    squadIds.has(player.id) ? sellingOf(player) : player.priceTenths;

  const gameweeks = Array.from({ length: horizon }, (_, i) => gameweek + i);

  // Variable names
  const squadVar = (id: number) => `x_${id}`;
  const starterVar = (gw: number, id: number) => `s${gw}_${id}`;
  const captainVar = (gw: number, id: number) => `c${gw}_${id}`;

  const binaries: string[] = [];
  const objective: Array<[number, string]> = [];
  const baseConstraints: string[] = [];

  for (const player of candidatePoolList) {
    binaries.push(squadVar(player.id));
    const weeklyXp = gameweeks.map((gw) => gameweekValue(player, gw));

    const reserveWeight = player.position === "GK" ? 0.05 : 0.15;
    const reservePoints = weeklyXp.map((pts) => pts * reserveWeight);

    objective.push([
      reservePoints.reduce((sum, pts) => sum + pts, 0),
      squadVar(player.id),
    ]);

    for (const [idx, gw] of gameweeks.entries()) {
      const sVar = starterVar(gw, player.id);
      const cVar = captainVar(gw, player.id);
      binaries.push(sVar, cVar);

      const pts = weeklyXp[idx];
      objective.push([pts - reservePoints[idx], sVar]);
      objective.push([pts, cVar]);

      baseConstraints.push(`${sVar} - ${squadVar(player.id)} <= 0`);
      baseConstraints.push(`${cVar} - ${sVar} <= 0`);
    }
  }

  // Squad size = 15
  baseConstraints.push(
    `squad_size: ${expression(candidatePoolList.map((p) => [1, squadVar(p.id)]))} = 15`
  );

  // Spendable budget constraint
  baseConstraints.push(
    `budget: ${expression(
      candidatePoolList.map((p) => [costOfPlayer(p), squadVar(p.id)])
    )} <= ${totalSpendableBudget}`
  );

  // Position constraints
  for (const pos of POSITIONS) {
    const posPlayers = candidatePoolList.filter((p) => p.position === pos);
    baseConstraints.push(
      `pos_${pos}: ${expression(posPlayers.map((p) => [1, squadVar(p.id)]))} = ${POSITION_MINIMUMS[pos]}`
    );

    for (const gw of gameweeks) {
      baseConstraints.push(
        `starters_${gw}_${pos}: ${expression(
          posPlayers.map((p) => [1, starterVar(gw, p.id)])
        )} >= ${STARTER_MINIMUMS[pos]}`
      );
      if (pos === "GK") {
        baseConstraints.push(
          `starters_${gw}_gk_max: ${expression(
            posPlayers.map((p) => [1, starterVar(gw, p.id)])
          )} <= 1`
        );
      }
    }
  }

  // Club constraints <= 3
  const teamIds = new Set(candidatePoolList.map((p) => p.teamId));
  for (const tId of teamIds) {
    const clubPlayers = candidatePoolList.filter((p) => p.teamId === tId);
    baseConstraints.push(
      `club_${tId}: ${expression(clubPlayers.map((p) => [1, squadVar(p.id)]))} <= 3`
    );
  }

  // Starter size = 11 and Captain size = 1
  for (const gw of gameweeks) {
    baseConstraints.push(
      `starter_size_${gw}: ${expression(candidatePoolList.map((p) => [1, starterVar(gw, p.id)]))} = 11`
    );
    baseConstraints.push(
      `captain_size_${gw}: ${expression(candidatePoolList.map((p) => [1, captainVar(gw, p.id)]))} = 1`
    );
  }

  // Locked players
  for (const lId of lockedIds) {
    baseConstraints.push(`locked_${lId}: ${squadVar(lId)} = 1`);
  }

  // Baseline xP calculation using full weeklyLineup engine
  const beforeXp = projectWeeklyLineupTotal({ squad, gameweek, riskMode: risk }, horizon);

  const suggestions: SingleTransferSuggestion[] = [];
  const seenSignatures = new Set<string>();

  const kLevels = Array.from({ length: maxTransfers }, (_, i) => i + 1);

  for (const k of kLevels) {
    const cuts: string[] = [];
    // Allow searching multiple candidates per transfer count tier
    const targetCount = maxTransfers === 1 ? 5 : Math.max(2, Math.min(3, 5 - k));

    for (let sol = 0; sol < targetCount; sol++) {
      const transferCountConstraint = `transfers_k: ${expression(
        squad.map((p) => [1, squadVar(p.id)])
      )} = ${15 - k}`;

      const constraints = [...baseConstraints, transferCountConstraint, ...cuts];

      const lp = [
        "Maximize",
        ` objective: ${expression(objective)}`,
        "Subject To",
        ...constraints.map((c) => ` ${c}`),
        "Binary",
        ...binaries.map((v) => ` ${v}`),
        "End",
      ].join("\n");

      const result = highs.solve(lp, {
        output_flag: false,
        log_to_console: false,
        mip_rel_gap: 0,
        presolve: "on",
      });

      if (result.Status !== "Optimal") {
        break;
      }

      const selectedIds = candidatePoolList
        .filter((p) => result.Columns[squadVar(p.id)]?.Primal > 0.5)
        .map((p) => p.id);

      const outPlayers = squad.filter((p) => !selectedIds.includes(p.id));
      const inPlayers = selectedIds
        .filter((id) => !squadIds.has(id))
        .map((id) => playerUniverseMap.get(id)!);

      if (outPlayers.length !== k || inPlayers.length !== k) {
        break;
      }

      cuts.push(
        `cut_${sol}: ${expression(inPlayers.map((p) => [1, squadVar(p.id)]))} <= ${inPlayers.length - 1}`
      );

      // Financials
      const cashReleased = outPlayers.reduce((sum, p) => sum + sellingOf(p), 0);
      const cashSpent = inPlayers.reduce((sum, p) => sum + p.priceTenths, 0);
      const cashReleasedTenths = cashReleased - cashSpent;

      // Full weekly lineup xP
      const newSquad = selectedIds.map((id) => playerUniverseMap.get(id)!);
      const afterXp = projectWeeklyLineupTotal({ squad: newSquad, gameweek, riskMode: risk }, horizon);
      const projectedDelta = Math.round((afterXp - beforeXp) * 1000) / 1000;
      const projectedDeltaPerGW = Math.round((projectedDelta / horizon) * 1000) / 1000;

      // Only transfers that induce positive points gained over that horizon
      if (projectedDelta <= 0) {
        if (sol === 0 || projectedDelta < -0.2) {
          break;
        }
        continue;
      }

      // Pair up out and in players by position
      const moves: Array<{ outgoingPlayerId: number; incomingPlayerId: number; cashReleasedTenths: number }> = [];
      for (const pos of POSITIONS) {
        const posOut = outPlayers.filter((p) => p.position === pos).sort((a, b) => b.priceTenths - a.priceTenths);
        const posIn = inPlayers.filter((p) => p.position === pos).sort((a, b) => b.priceTenths - a.priceTenths);
        for (let i = 0; i < posOut.length; i++) {
          if (posIn[i]) {
            moves.push({
              outgoingPlayerId: posOut[i].id,
              incomingPlayerId: posIn[i].id,
              cashReleasedTenths: sellingOf(posOut[i]) - posIn[i].priceTenths,
            });
          }
        }
      }

      // If any non-positional remainder, just pair by index
      if (moves.length < k) {
        const usedOut = new Set(moves.map((m) => m.outgoingPlayerId));
        const usedIn = new Set(moves.map((m) => m.incomingPlayerId));
        const remOut = outPlayers.filter((p) => !usedOut.has(p.id));
        const remIn = inPlayers.filter((p) => !usedIn.has(p.id));
        for (let i = 0; i < remOut.length; i++) {
          if (remIn[i]) {
            moves.push({
              outgoingPlayerId: remOut[i].id,
              incomingPlayerId: remIn[i].id,
              cashReleasedTenths: sellingOf(remOut[i]) - remIn[i].priceTenths,
            });
          }
        }
      }

      // Order transfers by which one is done first to free up money.
      // Doing cash-releasing transfers first prevents intermediate steps from failing due to insufficient bank.
      moves.sort((a, b) => b.cashReleasedTenths - a.cashReleasedTenths);

      const moveSignature = moves
        .map((m) => `${m.outgoingPlayerId}->${m.incomingPlayerId}`)
        .sort()
        .join("|");
      if (seenSignatures.has(moveSignature)) {
        continue;
      }
      seenSignatures.add(moveSignature);

      const maxIncomingRisk = Math.max(...inPlayers.map((p) => (hasAvailabilityRisk(p) ? 1 : 0)));

      const reason =
        k === 1
          ? `xP upgrade: +${projectedDelta.toFixed(1)} xP over ${horizon}GW, ${
              cashReleasedTenths >= 0
                ? `releases £${(cashReleasedTenths / 10).toFixed(1)}m`
                : `costs £${(-cashReleasedTenths / 10).toFixed(1)}m`
            }`
          : `${k} transfers: +${projectedDelta.toFixed(1)} xP over ${horizon}GW, ${
              cashReleasedTenths >= 0
                ? `releases £${(cashReleasedTenths / 10).toFixed(1)}m`
                : `costs £${(-cashReleasedTenths / 10).toFixed(1)}m`
            }`;

      suggestions.push({
        outgoingPlayerId: moves[0].outgoingPlayerId,
        incomingPlayerId: moves[0].incomingPlayerId,
        horizon,
        beforeXp: Math.round(beforeXp * 100) / 100,
        afterXp: Math.round(afterXp * 100) / 100,
        projectedDelta,
        projectedDeltaPerGW,
        cashReleasedTenths,
        score: projectedDelta,
        kind: cashReleasedTenths > 0 ? "BOTH" : "XP_UPGRADE",
        incomingRisk: maxIncomingRisk,
        confidence: "HIGH",
        reason,
        transfersCount: k,
        moves,
      });
    }
  }

  // Only transfers that induce points gained, ranked by points gained over that horizon
  return suggestions
    .filter((s) => s.projectedDelta > 0)
    .sort((a, b) => {
      // Primary: Rank by points gained over that horizon
      if (Math.abs(b.projectedDelta - a.projectedDelta) > 1e-4) {
        return b.projectedDelta - a.projectedDelta;
      }
      // Tie-breaker 1: Prefer fewer transfers for the same points gain
      const aCount = a.transfersCount ?? 1;
      const bCount = b.transfersCount ?? 1;
      if (aCount !== bCount) {
        return aCount - bCount;
      }
      // Tie-breaker 2: Prefer releasing more cash ITB
      if (b.cashReleasedTenths !== a.cashReleasedTenths) {
        return b.cashReleasedTenths - a.cashReleasedTenths;
      }
      // Tie-breaker 3: Lower availability risk
      return a.incomingRisk - b.incomingRisk;
    })
    .slice(0, 5);
}
