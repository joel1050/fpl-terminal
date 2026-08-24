import type { FeedEventKind, LiveFeedEvent } from "@/types/leagues";
import { statNumber, type LiveStats } from "./calculateLiveEntry";

export interface DiffContext {
  playerNameById?: ReadonlyMap<number, string>;
  teamIdByPlayer?: ReadonlyMap<number, number>;
  /** Fixture minute label per team: `74'` while live or `FT` when finished. */
  minuteLabelByTeam?: ReadonlyMap<number, string>;
  now?: number;
}

interface StatRule {
  key: string;
  kind: FeedEventKind;
  priority: number;
  /** Extra guard so incidental stat resets do not fabricate football events. */
  detect?: (previous: number, current: number) => boolean;
}

const RULES: StatRule[] = [
  { key: "own_goals", kind: "OWN GOAL", priority: 1 },
  { key: "red_cards", kind: "RED CARD", priority: 2 },
  { key: "goals_scored", kind: "GOAL", priority: 3 },
  { key: "penalties_missed", kind: "PENALTY MISS", priority: 4 },
  { key: "penalties_saved", kind: "PENALTY SAVE", priority: 5 },
  { key: "assists", kind: "ASSIST", priority: 6 },
  { key: "yellow_cards", kind: "YELLOW CARD", priority: 7 },
  { key: "clean_sheets", kind: "CLEAN SHEET", priority: 8, detect: (previous, current) => current > previous },
  {
    key: "saves",
    kind: "SAVE POINT",
    priority: 9,
    // Goalkeepers earn one point per three saves; only crossing a threshold is an event.
    detect: (previous, current) => Math.floor(current / 3) > Math.floor(previous / 3),
  },
  { key: "defensive_contribution", kind: "DEFENSIVE CONTRIBUTION", priority: 10 },
  { key: "bonus", kind: "BONUS CHANGE", priority: 11 },
];

const MAX_EVENTS = 100;

/**
 * Pure diff between two live Gameweek snapshots. Only provable stat movements
 * become named events; anything else falls back to POINTS CHANGE. The first
 * snapshot of a session produces no events, so no fake history is created.
 */
export function diffLiveSnapshots(
  previous: ReadonlyMap<number, LiveStats> | undefined,
  current: ReadonlyMap<number, LiveStats>,
  context: DiffContext = {},
): LiveFeedEvent[] {
  if (!previous || previous.size === 0) return [];
  const at = context.now ?? Date.now();
  const events: LiveFeedEvent[] = [];
  let sequence = 0;
  for (const [playerId, currentStats] of current) {
    const previousStats = previous.get(playerId);
    if (!previousStats) continue;
    const rawPointsDelta = statNumber(currentStats, "total_points") - statNumber(previousStats, "total_points");
    let matched: StatRule | undefined;
    for (const rule of RULES) {
      const before = statNumber(previousStats, rule.key);
      const after = statNumber(currentStats, rule.key);
      const changed = after !== before && (rule.detect ? rule.detect(before, after) : true);
      if (changed) {
        matched = rule;
        break;
      }
    }
    const kind: FeedEventKind = matched?.kind ?? "POINTS CHANGE";
    if (!matched && rawPointsDelta === 0) continue;
    sequence += 1;
    const teamId = context.teamIdByPlayer?.get(playerId);
    events.push({
      id: `${playerId}-${kind}-${at}-${sequence}`,
      kind,
      playerId,
      playerName: context.playerNameById?.get(playerId),
      rawPointsDelta,
      detail: matched ? `${matched.key} ${statNumber(previousStats, matched.key)} → ${statNumber(currentStats, matched.key)}` : "unattributed points change",
      minute: teamId !== undefined ? context.minuteLabelByTeam?.get(teamId) : undefined,
      at,
    });
    if (events.length >= MAX_EVENTS) break;
  }
  return events.slice(0, MAX_EVENTS);
}

export const LIVE_FEED_MAX_EVENTS = MAX_EVENTS;
