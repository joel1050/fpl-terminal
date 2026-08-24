import type {
  EntryPick,
  EntryPicks,
  FixtureView,
  LiveEntryCalculation,
  LiveEntryPlayer,
  PlayerFixtureStatus,
} from "@/types/leagues";
import type { Position } from "@/types/player";
import { aggregatePlayerStatus, teamFixturesByTeam, type PlayerStatusResult, type TeamFixtureInfo } from "./fixtureStatus";

export const ELEMENT_TYPE_POSITION: Record<number, Position> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

export type LiveStats = Record<string, number | string | boolean | null>;

const DISPLACEMENT_PRIORITY: Record<Position, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

export function statNumber(stats: LiveStats, key: string): number {
  const value = stats[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Actual FPL points recorded for a player in the live Gameweek snapshot. */
export function livePointsOf(stats: LiveStats | undefined): number {
  return stats ? statNumber(stats, "total_points") : 0;
}

/**
 * Multipliers after FPL's official automatic substitutions. A substitute always
 * comes on at a plain multiplier of one: FPL never hands the armband to a bench
 * player. When the captain is the one substituted out, the vice-captain takes
 * the armband, keeping a Triple Captain triple. If the vice-captain has already
 * been substituted out too, the multiplier is lost, exactly as FPL scores it.
 */
export function effectiveMultipliers(picks: EntryPicks): Map<number, number> {
  const multipliers = new Map(picks.picks.map((pick) => [pick.element, pick.multiplier]));
  const captain = picks.picks.find((pick) => pick.isCaptain);
  const vice = picks.picks.find((pick) => pick.isViceCaptain);
  const captainMultiplier = captain ? multipliers.get(captain.element) ?? 0 : 0;
  let captainSubstituted = false;

  for (const sub of picks.automaticSubs) {
    const outgoing = multipliers.get(sub.elementOut);
    if (outgoing === undefined || outgoing === 0) continue;
    multipliers.set(sub.elementOut, 0);
    multipliers.set(sub.elementIn, Math.max(multipliers.get(sub.elementIn) ?? 0, 1));
    if (captain && sub.elementOut === captain.element) captainSubstituted = true;
  }

  if (captainSubstituted && vice && (multipliers.get(vice.element) ?? 0) > 0) {
    multipliers.set(vice.element, Math.max(multipliers.get(vice.element) ?? 0, captainMultiplier));
  }
  return multipliers;
}

interface SquadContext {
  picks: EntryPicks;
  statsByElement: ReadonlyMap<number, LiveStats>;
  statusByElement: ReadonlyMap<number, PlayerStatusResult>;
}

function minutesOf(context: SquadContext, elementId: number): number {
  return statNumber(context.statsByElement.get(elementId) ?? {}, "minutes");
}

function idleFinished(context: SquadContext, elementId: number): boolean {
  const status = context.statusByElement.get(elementId);
  return status?.status === "DONE" && minutesOf(context, elementId) === 0;
}

function hasPlayed(context: SquadContext, elementId: number): boolean {
  return minutesOf(context, elementId) > 0;
}

/**
 * Deterministic preview of FPL's automatic-substitute rules for the window
 * before the official feed publishes them: benched players enter for finished
 * 0-minute starters while the formation stays legal, and an armband moves to
 * the vice-captain when the captain completes zero minutes.
 */
export function applyFallbackAutosubs(
  picks: EntryPicks,
  statsByElement: ReadonlyMap<number, LiveStats>,
  statusByElement: ReadonlyMap<number, PlayerStatusResult>,
): Map<number, number> {
  const context: SquadContext = { picks, statsByElement, statusByElement };
  const multipliers = new Map(picks.picks.map((pick) => [pick.element, pick.multiplier]));
  const positionCode = (pick: EntryPick): Position =>
    ELEMENT_TYPE_POSITION[pick.elementType] ?? "FWD";

  const startingGoalkeeper = picks.picks.find((pick) => pick.position <= 11 && pick.elementType === 1);
  const benchGoalkeeper = picks.picks.find((pick) => pick.position > 11 && pick.elementType === 1);
  if (startingGoalkeeper && benchGoalkeeper && idleFinished(context, startingGoalkeeper.element) && hasPlayed(context, benchGoalkeeper.element)) {
    multipliers.set(startingGoalkeeper.element, 0);
    multipliers.set(benchGoalkeeper.element, Math.max(multipliers.get(benchGoalkeeper.element) ?? 0, startingGoalkeeper.multiplier));
  }

  const substituted = new Set<number>();
  const benchOutfield = picks.picks
    .filter((pick) => pick.position > 11 && pick.elementType !== 1)
    .sort((left, right) => left.position - right.position);
  for (const candidate of benchOutfield) {
    if (!hasPlayed(context, candidate.element) || substituted.has(candidate.element)) continue;
    const idleStarters = picks.picks
      .filter((pick) => pick.position <= 11 && pick.elementType !== 1 && idleFinished(context, pick.element) && !substituted.has(pick.element))
      .sort((left, right) =>
        DISPLACEMENT_PRIORITY[positionCode(left)] - DISPLACEMENT_PRIORITY[positionCode(right)] || left.position - right.position);
    for (const outgoing of idleStarters) {
      const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
      for (const pick of picks.picks) {
        if (pick.position > 11 || pick.element === outgoing.element) continue;
        counts[positionCode(pick)] += 1;
      }
      counts[positionCode(candidate)] += 1;
      const legal = counts.GK === 1 && counts.DEF >= 3 && counts.MID >= 2 && counts.FWD >= 1;
      if (!legal) continue;
      multipliers.set(outgoing.element, 0);
      multipliers.set(candidate.element, Math.max(multipliers.get(candidate.element) ?? 0, outgoing.multiplier));
      substituted.add(outgoing.element);
      substituted.add(candidate.element);
      break;
    }
  }

  const captain = picks.picks.find((pick) => pick.isCaptain);
  const vice = picks.picks.find((pick) => pick.isViceCaptain);
  if (captain && vice && (multipliers.get(captain.element) ?? 0) > 0 && idleFinished(context, captain.element) && hasPlayed(context, vice.element)) {
    multipliers.set(vice.element, Math.max(multipliers.get(vice.element) ?? 0, multipliers.get(captain.element) ?? 0));
    multipliers.set(captain.element, 0);
  }
  return multipliers;
}

export interface CalculateLiveEntryInput {
  picks: EntryPicks;
  liveElementsByElement: ReadonlyMap<number, LiveStats>;
  fixtures: readonly FixtureView[];
  teamIdByElement: ReadonlyMap<number, number>;
  /** Model xP per player, shown only while a player has not started a fixture. */
  expectedPointsByElement?: ReadonlyMap<number, number>;
}

/**
 * Deterministic live Gameweek score for one entry.
 * Scoring trusts FPL's supplied multiplier (1 normal, 2 captain, 3 Triple
 * Captain, 0 bench) and subtracts the official transfer-hit cost.
 */
export function calculateLiveEntry(input: CalculateLiveEntryInput): LiveEntryCalculation {
  const { picks, liveElementsByElement, fixtures, teamIdByElement, expectedPointsByElement } = input;
  const fixturesByTeam = teamFixturesByTeam(fixtures);

  const statusByElement = new Map<number, PlayerStatusResult>();
  const fixtureStatusByElement = new Map<number, PlayerFixtureStatus[]>();
  for (const pick of picks.picks) {
    const teamId = teamIdByElement.get(pick.element);
    const teamFixtures: TeamFixtureInfo[] = teamId ? fixturesByTeam.get(teamId) ?? [] : [];
    const statuses: PlayerFixtureStatus[] = teamFixtures.map((fixture) => ({
      fixtureId: fixture.fixtureId,
      opponentTeamId: fixture.opponentTeamId,
      isHome: fixture.isHome,
      state: fixture.state,
      minutes: fixture.minutes,
      kickoffTime: fixture.kickoffTime ?? null,
    }));
    fixtureStatusByElement.set(pick.element, statuses);
    statusByElement.set(pick.element, aggregatePlayerStatus(statuses));
  }

  const multipliers = picks.automaticSubs.length > 0
    ? effectiveMultipliers(picks)
    : applyFallbackAutosubs(picks, liveElementsByElement, statusByElement);

  // Whoever holds the armband now, which is the vice-captain once an automatic
  // substitution has taken the captain's double away from them.
  const armband = picks.picks.find((pick) => pick.isCaptain && (multipliers.get(pick.element) ?? 0) > 1)
    ?? picks.picks.find((pick) => pick.isViceCaptain && (multipliers.get(pick.element) ?? 0) > 1)
    ?? picks.picks.find((pick) => pick.isCaptain);

  let grossPoints = 0;
  let startersPoints = 0;
  let benchPoints = 0;

  const playerPoints: LiveEntryPlayer[] = picks.picks.map((pick) => {
    const stats = liveElementsByElement.get(pick.element);
    const points = livePointsOf(stats);
    const multiplier = multipliers.get(pick.element) ?? 0;
    const onBench = pick.position > 11;
    const scored = points * multiplier;
    grossPoints += scored;
    if (onBench) benchPoints += scored;
    else startersPoints += scored;
    const status = statusByElement.get(pick.element)?.status ?? "TO_PLAY";
    return {
      elementId: pick.element,
      position: pick.position,
      elementType: pick.elementType,
      positionCode: ELEMENT_TYPE_POSITION[pick.elementType] ?? "FWD",
      onBench,
      multiplier,
      isCaptain: armband ? pick.element === armband.element : pick.isCaptain,
      isViceCaptain: pick.isViceCaptain && pick.element !== armband?.element,
      points,
      expectedPoints: expectedPointsByElement?.get(pick.element) ?? 0,
      status,
      fixtures: fixtureStatusByElement.get(pick.element) ?? [],
    };
  });

  // Only the players FPL is scoring are worth counting. Bench players carry a
  // multiplier of 0 until an automatic substitution promotes one, and a club
  // with no fixture this Gameweek has nothing left to give.
  const counting = playerPoints.filter((player) => player.multiplier > 0);
  const blank = (player: LiveEntryPlayer): boolean => player.fixtures.length === 0;
  const done = counting.filter((player) => player.status === "DONE" || blank(player)).length;
  const live = counting.filter((player) => player.status === "LIVE").length;
  const toPlay = counting.filter((player) => player.status === "TO_PLAY" && !blank(player)).length;

  const hitCost = picks.entryHistory?.eventTransfersCost ?? 0;
  return {
    grossPoints,
    hitCost,
    netPoints: grossPoints - hitCost,
    startersPoints,
    benchPoints,
    playerPoints,
    done,
    live,
    toPlay,
    pointsOnBench: benchPoints,
    activeChip: picks.activeChip,
  };
}
