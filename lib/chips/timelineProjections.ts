import type { Player } from "@/types/player";
import type { ChipKind } from "@/types/chips";
import { pickWeeklyTeam, scoreLineupWithChip } from "@/lib/squad/weeklyLineup";
import type { TimelineWeek } from "./timeline";

export interface TimelineGameweekProjection {
  gameweek: number;
  chip: ChipKind | null;
  activeSquadIds: number[];
  projectedXI: number;
  captainBonus: number;
  autosubValue: number;
  chipEffect: number;
  lineupTotal: number;
  hitCost: number;
  netTotal: number;
  captainId: number;
  viceCaptainId: number;
}

export interface TimelineProjectionInput {
  timeline: Record<number, TimelineWeek>;
  playersById: ReadonlyMap<number, Player>;
  riskMode: "SAFE" | "BALANCED" | "AGGRESSIVE";
  savedLineups?: Record<number, { starterIds: number[]; benchGoalkeeperId: number; benchOrder: number[]; captainId: number; viceCaptainId: number } | undefined>;
}

/**
 * Shared timeline projection helper: totals the active squad, lineup, chip
 * effect, and transfer hits for each saved gameweek. Replaces UI-side horizon
 * aggregation so every surface scores chips identically.
 */
export function projectTimeline(input: TimelineProjectionInput): Record<number, TimelineGameweekProjection> {
  const result: Record<number, TimelineGameweekProjection> = {};
  for (const week of Object.values(input.timeline)) {
    const squad = week.activeSquadIds
      .map((id) => input.playersById.get(id))
      .filter((player): player is Player => Boolean(player));
    if (squad.length !== 15) {
      result[week.gameweek] = {
        gameweek: week.gameweek,
        chip: week.chip,
        activeSquadIds: [...week.activeSquadIds],
        projectedXI: 0,
        captainBonus: 0,
        autosubValue: 0,
        chipEffect: 0,
        lineupTotal: 0,
        hitCost: week.hitCost,
        netTotal: -week.hitCost,
        captainId: 0,
        viceCaptainId: 0,
      };
      continue;
    }
    const saved = input.savedLineups?.[week.gameweek];
    const chipPlan = saved
      ? scoreLineupWithChip(squad, week.gameweek, input.riskMode, week.chip, saved)
      : pickWeeklyTeam({ squad, gameweek: week.gameweek, riskMode: input.riskMode, chip: week.chip });
    const baseline = saved
      ? scoreLineupWithChip(squad, week.gameweek, input.riskMode, null, saved)
      : pickWeeklyTeam({ squad, gameweek: week.gameweek, riskMode: input.riskMode, chip: null });
    const chipEffect = Math.round((chipPlan.projectedTotal - baseline.projectedTotal) * 1000) / 1000;
    result[week.gameweek] = {
      gameweek: week.gameweek,
      chip: week.chip,
      activeSquadIds: [...week.activeSquadIds],
      projectedXI: chipPlan.projectedXI,
      captainBonus: chipPlan.captainBonus,
      autosubValue: chipPlan.autosubValue,
      chipEffect,
      lineupTotal: chipPlan.projectedTotal,
      hitCost: week.hitCost,
      netTotal: Math.round((chipPlan.projectedTotal - week.hitCost) * 1000) / 1000,
      captainId: chipPlan.captainId,
      viceCaptainId: chipPlan.viceCaptainId,
    };
  }
  return result;
}

export function sumTimelineNet(projections: Record<number, TimelineGameweekProjection>, from: number, to: number): number {
  let total = 0;
  for (let gw = from; gw <= to; gw += 1) total += projections[gw]?.netTotal ?? 0;
  return Math.round(total * 1000) / 1000;
}
