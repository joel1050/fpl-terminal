import { availabilityOf } from "@/lib/availability/status";
import { weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import type { Player, SquadAlert } from "@/types";

const MAX_ALERTS = 5;
const HARD_RUN_AVERAGE = 3.6;
const RUN_GAMEWEEKS = 5;
const ORDINAL = ["1st", "2nd", "3rd"];

function slotLabel(id: number, input: { starterIds: number[]; benchOrder: number[]; benchGoalkeeperId: number }): string {
  if (input.starterIds.includes(id)) return "starter";
  if (id === input.benchGoalkeeperId) return "bench GK";
  const index = input.benchOrder.indexOf(id);
  return index >= 0 ? `${ORDINAL[index]} on bench` : "in squad";
}

export function squadAlerts(input: {
  squad: Player[]; starterIds: number[]; benchOrder: number[]; benchGoalkeeperId: number; gameweek: number;
}): SquadAlert[] {
  const unavailable: SquadAlert[] = [];
  const doubtful: SquadAlert[] = [];
  const hardRun: SquadAlert[] = [];
  const schedule: SquadAlert[] = [];

  for (const player of input.squad) {
    const level = availabilityOf(player);
    if (level !== "AVAILABLE") {
      const week = weeklyPlayerMetrics(player, input.gameweek);
      const chance = typeof player.chanceOfPlaying !== "number" ? "" : `, ${player.chanceOfPlaying}%`;
      (level === "UNAVAILABLE" ? unavailable : doubtful).push({
        kind: "AVAILABILITY",
        severity: level === "UNAVAILABLE" ? "BAD" : "WARN",
        playerId: player.id,
        title: `${player.displayName} ${level === "UNAVAILABLE" ? "unavailable" : "doubtful"}${chance}`,
        detail: `${slotLabel(player.id, input)} · ${Math.round(week.minutes)} min expected · ${week.points.toFixed(1)} xP`,
      });
    }

    // The run is the next five Gameweeks, not the next five fixture rows, so a
    // double counts both games and a blank counts none.
    const lastRunWeek = input.gameweek + RUN_GAMEWEEKS - 1;
    const upcoming = player.fixtures.filter((f) => f.gameweek >= input.gameweek && f.gameweek <= lastRunWeek);
    const covered = player.fixtures.some((f) => f.gameweek >= lastRunWeek);
    if (input.starterIds.includes(player.id) && covered && upcoming.length > 0) {
      const average = upcoming.reduce((sum, f) => sum + (f.difficulty ?? 3), 0) / upcoming.length;
      if (average >= HARD_RUN_AVERAGE) {
        const runXp = Array.from({ length: RUN_GAMEWEEKS }, (_, i) => input.gameweek + i)
          .reduce((sum, gw) => sum + weeklyPlayerMetrics(player, gw).points, 0);
        hardRun.push({
          kind: "HARD_RUN", severity: "INFO", playerId: player.id,
          title: `${player.displayName} has a hard run`,
          detail: `${upcoming.map((f) => f.opponentShortName).join(" · ")} → ${runXp.toFixed(1)} xP over ${RUN_GAMEWEEKS} GWs`,
        });
      }
    }

    const count = player.fixtures.filter((f) => f.gameweek === input.gameweek).length;
    if (count === 0) schedule.push({ kind: "BLANK", severity: "INFO", playerId: player.id, title: `${player.displayName} has no fixture`, detail: `Blank gameweek ${input.gameweek}` });
    if (count > 1) schedule.push({ kind: "DOUBLE", severity: "INFO", playerId: player.id, title: `${player.displayName} plays twice`, detail: `Double gameweek ${input.gameweek}` });
  }

  return [...unavailable, ...doubtful, ...hardRun, ...schedule].slice(0, MAX_ALERTS);
}
