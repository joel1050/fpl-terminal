import type { FeedEventClass, FeedEventKind, LiveFeedEvent } from "@/types/leagues";
import type { Position } from "@/types/player";
import { statNumber, type LiveStats } from "./calculateLiveEntry";
import { feedEventWeight } from "./feedEvents";

/** One scoring line from FPL's own points breakdown for a player. */
export interface LiveExplainStat {
  identifier: string;
  points: number;
  value: number;
}

/** FPL explains a player's points once per fixture they played in the Gameweek. */
export interface LiveExplainBlock {
  fixtureId?: number;
  stats: readonly LiveExplainStat[];
}

export interface DiffContext {
  playerNameById?: ReadonlyMap<number, string>;
  teamIdByPlayer?: ReadonlyMap<number, number>;
  positionByPlayer?: ReadonlyMap<number, Position>;
  /** Fixture minute label per team: `74'` while live or `FT` when finished. */
  minuteLabelByTeam?: ReadonlyMap<number, string>;
  /** FPL's own per-fixture points breakdown, when the live payload carried one. */
  explainByPlayer?: ReadonlyMap<number, readonly LiveExplainBlock[]>;
  now?: number;
}

interface StatRule {
  key: string;
  kind: FeedEventKind;
  eventClass: FeedEventClass;
  /**
   * The line to read in FPL's breakdown, where one exists for this rule alone.
   * Left unset when FPL prices several of our events together, as it does with
   * the two appearance points: sharing that line out would count it twice.
   */
  explainIdentifier?: string;
  /** How many scoring instances a cumulative reading of the stat represents. */
  instances: (value: number) => number;
  /** What one instance is worth when FPL sends no breakdown of its own. */
  fallbackPoints: (position: Position | undefined) => number;
}

const each = (value: number): number => Math.max(0, Math.floor(value));
const flat = (points: number) => (): number => points;

const RULES: StatRule[] = [
  { key: "goals_scored", explainIdentifier: "goals_scored", kind: "GOAL", eventClass: "ATTACKING", instances: each, fallbackPoints: (position) => (position === "GK" || position === "DEF" ? 6 : position === "FWD" ? 4 : 5) },
  { key: "assists", explainIdentifier: "assists", kind: "ASSIST", eventClass: "ATTACKING", instances: each, fallbackPoints: flat(3) },
  { key: "own_goals", explainIdentifier: "own_goals", kind: "OWN GOAL", eventClass: "DISCIPLINE", instances: each, fallbackPoints: flat(-2) },
  { key: "red_cards", explainIdentifier: "red_cards", kind: "RED CARD", eventClass: "DISCIPLINE", instances: each, fallbackPoints: flat(-3) },
  { key: "yellow_cards", explainIdentifier: "yellow_cards", kind: "YELLOW CARD", eventClass: "DISCIPLINE", instances: each, fallbackPoints: flat(-1) },
  { key: "penalties_missed", explainIdentifier: "penalties_missed", kind: "PENALTY MISS", eventClass: "DISCIPLINE", instances: each, fallbackPoints: flat(-2) },
  { key: "penalties_saved", explainIdentifier: "penalties_saved", kind: "PENALTY SAVE", eventClass: "DEFENSIVE", instances: each, fallbackPoints: flat(5) },
  { key: "clean_sheets", explainIdentifier: "clean_sheets", kind: "CLEAN SHEET", eventClass: "DEFENSIVE", instances: each, fallbackPoints: (position) => (position === "GK" || position === "DEF" ? 4 : position === "MID" ? 1 : 0) },
  { key: "defensive_contribution", explainIdentifier: "defensive_contribution", kind: "DEFENSIVE CONTRIBUTION", eventClass: "DEFENSIVE", instances: each, fallbackPoints: flat(2) },
  // Goalkeepers earn one point per three saves, so only a crossed threshold scores.
  { key: "saves", explainIdentifier: "saves", kind: "SAVE POINT", eventClass: "DEFENSIVE", instances: (value) => Math.max(0, Math.floor(value / 3)), fallbackPoints: flat(1) },
  // The two appearance points, kept apart so each one can be named.
  { key: "minutes", kind: "APPEARANCE", eventClass: "ROUTINE", instances: (value) => (value >= 1 ? 1 : 0), fallbackPoints: flat(1) },
  { key: "minutes", kind: "SIXTY MINUTES", eventClass: "ROUTINE", instances: (value) => (value >= 60 ? 1 : 0), fallbackPoints: flat(1) },
];

const BONUS_KEY = "bonus";
/** One crowded poll should not be able to fill the whole feed on its own. */
const MAX_BATCH_EVENTS = 250;

const EMPTY_STATS: LiveStats = {};

interface ExplainReading {
  points: number;
  value: number;
  /** Set only when a single fixture accounts for the stat, so doubles stay honest. */
  fixtureId?: number;
}

/** Sums FPL's own breakdown of one scoring identifier across a player's fixtures. */
function readExplain(
  blocks: readonly LiveExplainBlock[] | undefined,
  identifier: string | undefined,
): ExplainReading | undefined {
  if (!identifier || !blocks?.length) return undefined;
  let points = 0;
  let value = 0;
  let contributors = 0;
  let fixtureId: number | undefined;
  for (const block of blocks) {
    for (const stat of block.stats) {
      if (stat.identifier !== identifier) continue;
      points += stat.points;
      value += stat.value;
      if (stat.value !== 0) {
        contributors += 1;
        fixtureId = block.fixtureId;
      }
    }
  }
  if (!contributors) return undefined;
  return { points, value, fixtureId: contributors === 1 ? fixtureId : undefined };
}

/**
 * What one instance of a scoring event is worth. FPL's breakdown is preferred
 * because it already knows the player's position and the season's rules; the
 * standard points table only stands in when the payload carries no breakdown.
 */
function pointsPerInstance(
  rule: StatRule,
  explain: ExplainReading | undefined,
  position: Position | undefined,
): number {
  if (explain) {
    const units = rule.instances(explain.value);
    if (units > 0) return Math.round(explain.points / units);
  }
  return rule.fallbackPoints(position);
}

/**
 * Pure diff between two live Gameweek snapshots.
 *
 * A missing previous snapshot counts as a Gameweek that has not started, so the
 * first read of a session reconstructs everything the cumulative stats already
 * record rather than showing an empty panel. Those rows are marked `seeded`:
 * they are known to have happened but not when, so they carry no minute.
 *
 * Event ids are derived from the event itself — a player's second goal is always
 * their second goal — so reading the same Gameweek again collapses onto the
 * history already held instead of duplicating it.
 */
export function diffLiveSnapshots(
  previous: ReadonlyMap<number, LiveStats> | undefined,
  current: ReadonlyMap<number, LiveStats>,
  context: DiffContext = {},
): LiveFeedEvent[] {
  const at = context.now ?? Date.now();
  const seeding = !previous || previous.size === 0;
  const events: LiveFeedEvent[] = [];

  for (const [playerId, currentStats] of current) {
    const previousStats = previous?.get(playerId) ?? EMPTY_STATS;
    const explain = context.explainByPlayer?.get(playerId);
    const position = context.positionByPlayer?.get(playerId);
    const teamId = context.teamIdByPlayer?.get(playerId);
    const playerName = context.playerNameById?.get(playerId);
    const seeded = seeding || !previous?.has(playerId);
    // A reconstructed event is known to have happened but not when, so it goes
    // out without a minute rather than borrowing the clock from this poll.
    const minute = seeded ? undefined : (teamId !== undefined ? context.minuteLabelByTeam?.get(teamId) : undefined);
    const playerPointsDelta = statNumber(currentStats, "total_points") - statNumber(previousStats, "total_points");
    let attributed = 0;

    for (const rule of RULES) {
      const before = rule.instances(statNumber(previousStats, rule.key));
      const after = rule.instances(statNumber(currentStats, rule.key));
      if (after <= before) continue;
      const reading = readExplain(explain, rule.explainIdentifier);
      const perInstance = pointsPerInstance(rule, reading, position);
      for (let instance = before + 1; instance <= after; instance += 1) {
        attributed += perInstance;
        events.push({
          id: `${playerId}-${rule.kind}-${instance}`,
          kind: rule.kind,
          eventClass: rule.eventClass,
          playerId,
          playerName,
          pointsDelta: perInstance,
          fixtureId: reading?.fixtureId,
          detail: `${rule.key} ${statNumber(previousStats, rule.key)} → ${statNumber(currentStats, rule.key)}`,
          minute,
          seeded,
          at,
        });
      }
    }

    // Bonus is a running score rather than an increment: it climbs as the match
    // goes on and is rewritten once FPL settles it, so each fixture keeps one
    // row that reports where the bonus stands now.
    const bonusBefore = statNumber(previousStats, BONUS_KEY);
    const bonusAfter = statNumber(currentStats, BONUS_KEY);
    if (bonusAfter !== bonusBefore && bonusAfter !== 0) {
      const reading = readExplain(explain, BONUS_KEY);
      const bonusPoints = reading ? reading.points : bonusAfter;
      attributed += bonusPoints - bonusBefore;
      events.push({
        id: `${playerId}-BONUS CHANGE-${reading?.fixtureId ?? 0}`,
        kind: "BONUS CHANGE",
        eventClass: "BONUS",
        playerId,
        playerName,
        pointsDelta: bonusPoints,
        fixtureId: reading?.fixtureId,
        detail: `bonus ${bonusBefore} → ${bonusAfter}`,
        minute,
        seeded,
        at,
      });
    }

    // Whatever FPL scored that none of the rules above explain. Keeping it means
    // the rows always add up to the player's points, however FPL changes.
    const residual = playerPointsDelta - attributed;
    if (residual !== 0) {
      events.push({
        id: `${playerId}-POINTS CHANGE-${statNumber(currentStats, "total_points")}`,
        kind: "POINTS CHANGE",
        eventClass: "ROUTINE",
        playerId,
        playerName,
        pointsDelta: residual,
        detail: "unattributed points change",
        minute,
        seeded,
        at,
      });
    }
  }

  // Ranked before the cap, never truncated by whatever order FPL listed players
  // in, so a kickoff full of appearance points cannot bury the goals.
  events.sort((left, right) => feedEventWeight(right.kind) - feedEventWeight(left.kind));
  return events.slice(0, MAX_BATCH_EVENTS);
}
