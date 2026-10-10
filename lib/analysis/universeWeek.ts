import { projectedPointsForGameweeks } from "@/lib/projections/projectPlayer";
import { valuePerMillion } from "@/lib/projections/metrics";
import { weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import type { Player } from "@/types/player";

export type UniverseWeekMetrics = { xp: number; next3: number; next5: number; next10: number; value: number; value10: number };

/** Market metrics for the planning gameweek, derived from the same weekly-lineup engine the squad uses. */
export function universeWeekFor(player: Player, gameweek: number): UniverseWeekMetrics {
  const week = weeklyPlayerMetrics(player, gameweek);
  const fixtures = player.projection?.fixtures ?? [];
  const next3 = projectedPointsForGameweeks(fixtures, gameweek, 3);
  const next5 = projectedPointsForGameweeks(fixtures, gameweek, 5);
  const next10 = projectedPointsForGameweeks(fixtures, gameweek, 10);
  return {
    xp: week.points,
    next3,
    next5,
    next10,
    value: valuePerMillion(next5, player.priceTenths),
    value10: valuePerMillion(next10, player.priceTenths),
  };
}
