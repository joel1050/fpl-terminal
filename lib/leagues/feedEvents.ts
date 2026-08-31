import type { FeedEventKind, LiveFeedEvent } from "@/types/leagues";

/**
 * The feed keeps a Gameweek's worth of scoring events, not just the last few
 * minutes, so the ceiling is generous. Routine appearance points have their own
 * far smaller ceiling: they are true, they arrive in their hundreds at kickoff,
 * and they must never push a goal out of the list.
 */
export const LIVE_FEED_MAX_EVENTS = 400;
export const LIVE_FEED_MAX_ROUTINE_EVENTS = 60;

/** How much a row is worth keeping when something has to be dropped. */
const WEIGHT: Record<FeedEventKind, number> = {
  "GOAL": 100,
  "RED CARD": 95,
  "OWN GOAL": 90,
  "PENALTY SAVE": 88,
  "PENALTY MISS": 86,
  "ASSIST": 80,
  "BONUS CHANGE": 70,
  "CLEAN SHEET": 60,
  "DEFENSIVE CONTRIBUTION": 55,
  "SAVE POINT": 50,
  "YELLOW CARD": 40,
  "POINTS CHANGE": 20,
  "APPEARANCE": 10,
  "SIXTY MINUTES": 10,
};

export function feedEventWeight(kind: FeedEventKind): number {
  return WEIGHT[kind] ?? 0;
}

export function isRoutineEvent(event: LiveFeedEvent): boolean {
  return event.eventClass === "ROUTINE";
}

/**
 * Which of two readings of the same event to keep. An event watched happening
 * carries a minute and a real timestamp, so it always beats the same event read
 * back from cumulative stats; otherwise the later reading wins, which is how a
 * settled bonus score replaces the provisional one.
 */
function supersedes(candidate: LiveFeedEvent, incumbent: LiveFeedEvent): boolean {
  if (candidate.seeded !== incumbent.seeded) return !candidate.seeded;
  return candidate.at >= incumbent.at;
}

/**
 * Folds a fresh batch into the feed. Event ids are stable, so re-reading a
 * Gameweek collapses onto the history already held instead of doubling it.
 * The cap is applied after ranking, never by arrival order, so one crowded poll
 * cannot silently delete the goals someone is still reading.
 */
export function mergeFeedEvents(
  existing: readonly LiveFeedEvent[],
  incoming: readonly LiveFeedEvent[],
): LiveFeedEvent[] {
  const byId = new Map<string, LiveFeedEvent>();
  for (const event of [...existing, ...incoming]) {
    const incumbent = byId.get(event.id);
    if (!incumbent || supersedes(event, incumbent)) byId.set(event.id, event);
  }

  const ranked = [...byId.values()].sort((left, right) =>
    right.at - left.at
    || feedEventWeight(right.kind) - feedEventWeight(left.kind)
    || left.id.localeCompare(right.id));

  const kept: LiveFeedEvent[] = [];
  let routine = 0;
  for (const event of ranked) {
    if (isRoutineEvent(event)) {
      if (routine >= LIVE_FEED_MAX_ROUTINE_EVENTS) continue;
      routine += 1;
    }
    kept.push(event);
    if (kept.length >= LIVE_FEED_MAX_EVENTS) break;
  }
  return kept;
}

export type FeedTone = "gain" | "loss" | "flat";

/**
 * Colour says what an event did to the viewer's own score, and nothing else.
 * A player they do not field scores neutral however many points he took off
 * the board — including one sitting on their own bench, who earns them nothing.
 */
export function feedTone(yourPoints: number): FeedTone {
  if (yourPoints > 0) return "gain";
  if (yourPoints < 0) return "loss";
  return "flat";
}

export const FEED_FILTERS = ["FOCUS", "MY TEAM", "MY LEAGUE", "BONUS", "LOSSES", "ALL"] as const;
export type FeedFilter = (typeof FEED_FILTERS)[number];

export interface FeedRowContext {
  /** The viewer has this player in their own squad, bench included. */
  owned: boolean;
  /** How many sampled managers in the selected league hold the player. */
  ownerCount: number;
  /** The viewer's own multiplier: 0 on the bench and for players they do not own. */
  userMultiplier: number;
}

/** Events worth surfacing to someone who owns nobody involved. */
function isHeadline(event: LiveFeedEvent): boolean {
  return event.kind === "GOAL" || event.kind === "RED CARD" || event.kind === "OWN GOAL"
    || event.kind === "PENALTY SAVE" || event.kind === "PENALTY MISS";
}

/**
 * Every filter in one place so the buttons and the counts cannot disagree.
 * FOCUS is the default: the viewer's own players, players their league rivals
 * hold, and the handful of events that matter whoever owns them.
 */
export function matchesFeedFilter(
  event: LiveFeedEvent,
  filter: FeedFilter,
  context: FeedRowContext,
): boolean {
  switch (filter) {
    case "MY TEAM":
      return context.owned;
    case "MY LEAGUE":
      return !isRoutineEvent(event) && context.ownerCount > 0;
    case "BONUS":
      return event.kind === "BONUS CHANGE";
    case "LOSSES":
      // What it cost the viewer, not what it cost anyone. A booking on their
      // bench takes nothing off their score, so it is not one of their losses;
      // for a player they do not own, the event's own points are the measure.
      if (context.owned) {
        return context.userMultiplier > 0 && event.pointsDelta * context.userMultiplier < 0;
      }
      return event.pointsDelta < 0;
    case "ALL":
      return true;
    case "FOCUS":
    default:
      return !isRoutineEvent(event)
        && (context.owned || context.ownerCount > 0 || isHeadline(event));
  }
}
