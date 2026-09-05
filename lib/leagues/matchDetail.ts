import type { FixtureStatEntry, FixtureStatLine, FixtureView, LiveEntryPlayer } from "@/types/leagues";

export type MatchSide = "HOME" | "AWAY";

/** A player who scored or assisted, and whether they are in your own squad. */
export interface MatchContributor {
  elementId: number;
  name: string;
  side: MatchSide;
  count: number;
  owned: boolean;
}

export interface MatchBonusRow {
  elementId: number;
  name: string;
  side: MatchSide;
  bps: number;
  bonus: number;
  owned: boolean;
}

export interface MatchDetail {
  /** Squad members whose club plays in this match, bench included. */
  owned: readonly LiveEntryPlayer[];
  /** What those players have put on your score: points times their multiplier. */
  ownedPoints: number;
  scorers: readonly MatchContributor[];
  assists: readonly MatchContributor[];
  bonus: readonly MatchBonusRow[];
  /** False while the bonus shown is our own reading of the BPS table. */
  bonusSettled: boolean;
}

export interface MatchDetailContext {
  ownedPlayers: readonly LiveEntryPlayer[];
  teamIdByElement: ReadonlyMap<number, number>;
  nameByElement: ReadonlyMap<number, string>;
}

const BONUS_AWARDS = [3, 2, 1] as const;

/**
 * Bonus points from a BPS table, following FPL's own tie rules: a shared first
 * place hands three points to everyone in it and pushes the next player down to
 * whatever slot is left, so two tied leaders leave one point for third and
 * three tied leaders leave nothing for anybody.
 */
export function allocateBonus(
  entries: readonly { elementId: number; bps: number }[],
): Map<number, number> {
  const awards = new Map<number, number>(entries.map((entry) => [entry.elementId, 0]));
  const scoring = [...entries]
    .filter((entry) => entry.bps > 0)
    .sort((left, right) => right.bps - left.bps || left.elementId - right.elementId);

  let slot = 0;
  let index = 0;
  while (index < scoring.length && slot < BONUS_AWARDS.length) {
    const bps = scoring[index].bps;
    const tied = scoring.filter((entry) => entry.bps === bps);
    for (const entry of tied) awards.set(entry.elementId, BONUS_AWARDS[slot]);
    slot += tied.length;
    index += tied.length;
  }
  return awards;
}

function lineOf(
  stats: readonly FixtureStatLine[] | undefined,
  identifier: string,
): FixtureStatLine | undefined {
  return stats?.find((line) => line.identifier === identifier);
}

/** Walks one stat line home side first, which is how a scoreline reads. */
function bySide(line: FixtureStatLine | undefined): Array<{ entry: FixtureStatEntry; side: MatchSide }> {
  if (!line) return [];
  return [
    ...line.home.map((entry) => ({ entry, side: "HOME" as MatchSide })),
    ...line.away.map((entry) => ({ entry, side: "AWAY" as MatchSide })),
  ];
}

export function buildMatchDetail(fixture: FixtureView, context: MatchDetailContext): MatchDetail {
  const { ownedPlayers, teamIdByElement, nameByElement } = context;
  const ownedIds = new Set(ownedPlayers.map((player) => player.elementId));
  const nameOf = (elementId: number): string => nameByElement.get(elementId) ?? `#${elementId}`;

  const owned = ownedPlayers.filter((player) => {
    const teamId = teamIdByElement.get(player.elementId);
    return teamId === fixture.homeTeamId || teamId === fixture.awayTeamId;
  });
  // A bench player carries a multiplier of zero and so adds nothing, exactly as
  // FPL scores them. In a Double Gameweek a player's Gameweek total is the same
  // figure under each of their fixtures, because FPL keeps only one running
  // points tally per player.
  const ownedPoints = owned.reduce((total, player) => total + player.points * player.multiplier, 0);

  const contributors = (identifier: string): MatchContributor[] =>
    bySide(lineOf(fixture.stats, identifier))
      .filter(({ entry }) => entry.value > 0)
      .map(({ entry, side }) => ({
        elementId: entry.element,
        name: nameOf(entry.element),
        side,
        count: entry.value,
        owned: ownedIds.has(entry.element),
      }));

  const bpsEntries = bySide(lineOf(fixture.stats, "bps")).map(({ entry, side }) => ({
    elementId: entry.element,
    side,
    bps: entry.value,
  }));
  const settledLine = fixture.bonusSettled ? lineOf(fixture.stats, "bonus") : undefined;
  const settled = settledLine
    ? new Map(bySide(settledLine).map(({ entry }) => [entry.element, entry.value]))
    : null;
  const provisional = settled ? null : allocateBonus(bpsEntries);

  const bonus = bpsEntries
    .map((entry) => ({
      elementId: entry.elementId,
      name: nameOf(entry.elementId),
      side: entry.side,
      bps: entry.bps,
      bonus: settled ? settled.get(entry.elementId) ?? 0 : provisional?.get(entry.elementId) ?? 0,
      owned: ownedIds.has(entry.elementId),
    }))
    .sort((left, right) => right.bps - left.bps || left.elementId - right.elementId);

  return {
    owned,
    ownedPoints,
    scorers: contributors("goals_scored"),
    assists: contributors("assists"),
    bonus,
    bonusSettled: Boolean(settled),
  };
}
