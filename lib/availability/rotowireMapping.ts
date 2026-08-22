import type { Player } from "@/types/player";
import type {
  RotowireFixtureLineup,
  RotowireLineupSnapshot,
  RotowirePlayer,
  RotowireTeamLineup,
  RotowireUnavailablePlayer,
} from "./rotowire";

export interface RotowireClubMapping {
  name?: string;
  abbreviation?: string;
  teamId: number;
}

export type RotowireClubMappings =
  | ReadonlyMap<string, number>
  | Readonly<Record<string, number>>
  | readonly RotowireClubMapping[];

export type RotowireConfirmedMappings =
  | ReadonlyMap<number, number>
  | Readonly<Record<string, number>>
  | readonly { rotowireId: number; playerId: number }[];

export interface RotowireMappingOptions {
  clubMappings?: RotowireClubMappings;
  confirmedMappings?: RotowireConfirmedMappings;
  /** Alias for imports that call these persisted mappings. */
  savedMappings?: RotowireConfirmedMappings;
}

export type RotowireMappingMethod = "CONFIRMED_MAPPING" | "EXACT_NAME" | "UNIQUE_FALLBACK";
export type RotowireUnresolvedReason =
  | "NO_CLUB_MAPPING"
  | "NO_CLUB_PLAYERS"
  | "INVALID_CONFIRMED_MAPPING"
  | "NO_NAME_MATCH"
  | "AMBIGUOUS";

interface RotowireSourceRecord {
  fixtureIndex: number;
  teamSide: RotowireTeamLineup["side"];
  teamName: string;
  teamAbbreviation: string;
  lineupStatus: RotowireTeamLineup["status"];
  rotowireId: number;
  name: string;
  position: string;
  source: "STARTER" | "UNAVAILABLE";
  availabilityStatus?: string;
}

export interface RotowireMappingCandidate {
  playerId: number;
  name: string;
  teamId: number;
  teamName: string;
}

export interface RotowireMappedRecord extends RotowireSourceRecord {
  playerId: number;
  method: RotowireMappingMethod;
}

export interface RotowireUnresolvedRecord extends RotowireSourceRecord {
  reason: RotowireUnresolvedReason;
  candidates: RotowireMappingCandidate[];
}

export interface RotowireMappingResult {
  mapped: RotowireMappedRecord[];
  /** Every source record that was not mapped, including ambiguous records. */
  unresolved: RotowireUnresolvedRecord[];
  /** The ambiguous subset of unresolved records. */
  ambiguous: RotowireUnresolvedRecord[];
}

export function normalizeRotowireName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ß]/g, "ss")
    .replace(/[ø]/gi, "o")
    .replace(/[đ]/gi, "d")
    .replace(/[ł]/gi, "l")
    .replace(/[æ]/gi, "ae")
    .replace(/[œ]/gi, "oe")
    .replace(/[\u0027\u2018\u2019\u0060]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function clubLookup(mappings: RotowireClubMappings | undefined): Map<string, number> {
  const result = new Map<string, number>();
  if (!mappings) return result;
  if (mappings instanceof Map) {
    for (const [key, value] of mappings) result.set(normalizeRotowireName(key), value);
    return result;
  }
  if (Array.isArray(mappings)) {
    for (const mapping of mappings) {
      if (mapping.name) result.set(normalizeRotowireName(mapping.name), mapping.teamId);
      if (mapping.abbreviation) result.set(normalizeRotowireName(mapping.abbreviation), mapping.teamId);
    }
    return result;
  }
  for (const [key, value] of Object.entries(mappings)) result.set(normalizeRotowireName(key), value);
  return result;
}

function confirmedLookup(mappings: RotowireConfirmedMappings | undefined): Map<number, number> {
  const result = new Map<number, number>();
  if (!mappings) return result;
  if (mappings instanceof Map) {
    for (const [key, value] of mappings) result.set(key, value);
    return result;
  }
  if (Array.isArray(mappings)) {
    for (const mapping of mappings) result.set(mapping.rotowireId, mapping.playerId);
    return result;
  }
  for (const [key, value] of Object.entries(mappings)) {
    const rotowireId = Number(key);
    if (Number.isInteger(rotowireId)) result.set(rotowireId, value);
  }
  return result;
}

function sourceRecords(snapshot: RotowireLineupSnapshot): RotowireSourceRecord[] {
  const records: RotowireSourceRecord[] = [];
  const addTeam = (fixture: RotowireFixtureLineup, fixtureIndex: number, team: RotowireTeamLineup) => {
    const base = {
      fixtureIndex,
      teamSide: team.side,
      teamName: team.name,
      teamAbbreviation: team.abbreviation,
      lineupStatus: team.status,
    } satisfies Pick<RotowireSourceRecord, "fixtureIndex" | "teamSide" | "teamName" | "teamAbbreviation" | "lineupStatus">;
    for (const player of team.starters) {
      records.push({ ...base, ...player, source: "STARTER" });
    }
    for (const player of team.unavailable) {
      records.push({ ...base, ...player, source: "UNAVAILABLE", availabilityStatus: player.status });
    }
  };
  snapshot.fixtures.forEach((fixture, fixtureIndex) => {
    addTeam(fixture, fixtureIndex, fixture.home);
    addTeam(fixture, fixtureIndex, fixture.away);
  });
  return records;
}

function playerFullName(player: Player): string {
  return normalizeRotowireName(`${player.firstName} ${player.lastName}`);
}

function playerCandidate(player: Player): RotowireMappingCandidate {
  return { playerId: player.id, name: player.displayName, teamId: player.teamId, teamName: player.teamName };
}

function tokens(value: string): string[] {
  return normalizeRotowireName(value).split(" ").filter(Boolean);
}

function initialisedFullNameMatch(source: string, player: Player): boolean {
  const sourceTokens = tokens(source);
  const playerTokens = tokens(`${player.firstName} ${player.lastName}`);
  if (sourceTokens.length !== playerTokens.length) return false;
  let abbreviated = false;
  for (let index = 0; index < sourceTokens.length; index += 1) {
    if (sourceTokens[index] === playerTokens[index]) continue;
    if (sourceTokens[index].length !== 1 || !playerTokens[index].startsWith(sourceTokens[index])) return false;
    abbreviated = true;
  }
  return abbreviated;
}

function singleTokenAliasMatch(source: string, player: Player): boolean {
  const sourceTokens = tokens(source);
  if (sourceTokens.length !== 1) return false;
  const token = sourceTokens[0];
  return token === normalizeRotowireName(player.firstName) || token === normalizeRotowireName(player.lastName);
}

function candidateNames(source: RotowireSourceRecord, players: readonly Player[]): {
  exact: Player[];
  fallback: Player[];
} {
  const sourceName = normalizeRotowireName(source.name);
  const exact = players.filter((player) => {
    const displayName = normalizeRotowireName(player.displayName);
    return playerFullName(player) === sourceName || (tokens(displayName).length > 1 && displayName === sourceName);
  });
  if (exact.length) return { exact, fallback: [] };
  const fallback = players.filter((player) => {
    const displayName = normalizeRotowireName(player.displayName);
    return displayName === sourceName || initialisedFullNameMatch(sourceName, player) || singleTokenAliasMatch(sourceName, player);
  });
  return { exact, fallback };
}

function autoClubIds(players: readonly Player[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const player of players) {
    for (const key of [player.teamName, player.teamShortName]) {
      const normalized = normalizeRotowireName(key);
      if (!normalized) continue;
      const ids = result.get(normalized) ?? new Set<number>();
      ids.add(player.teamId);
      result.set(normalized, ids);
    }
  }
  return result;
}

function resolveClubId(
  source: RotowireSourceRecord,
  explicit: Map<string, number>,
  inferred: Map<string, Set<number>>,
): number | undefined {
  for (const key of [source.teamName, source.teamAbbreviation]) {
    const normalized = normalizeRotowireName(key);
    const explicitId = explicit.get(normalized);
    if (explicitId !== undefined) return explicitId;
    const inferredIds = inferred.get(normalized);
    if (inferredIds?.size === 1) return [...inferredIds][0];
  }
  return undefined;
}

function sortCandidates(players: Player[]): Player[] {
  return [...players].sort((left, right) => left.id - right.id);
}

export function mapRotowireLineups(
  snapshot: RotowireLineupSnapshot,
  players: readonly Player[],
  options: RotowireMappingOptions = {},
): RotowireMappingResult {
  const clubMappings = clubLookup(options.clubMappings);
  const confirmedMappings = confirmedLookup(options.confirmedMappings ?? options.savedMappings);
  const inferredClubs = autoClubIds(players);
  const byId = new Map(players.map((player) => [player.id, player]));
  const mapped: RotowireMappedRecord[] = [];
  const unresolved: RotowireUnresolvedRecord[] = [];

  for (const source of sourceRecords(snapshot)) {
    const clubId = resolveClubId(source, clubMappings, inferredClubs);
    const clubPlayers = clubId === undefined ? [] : players.filter((player) => player.teamId === clubId);
    const possiblePlayers = clubId === undefined ? [...players] : clubPlayers;
    const names = candidateNames(source, possiblePlayers);
    const candidates = sortCandidates(names.exact.length ? names.exact : names.fallback);
    const confirmedId = confirmedMappings.get(source.rotowireId);
    const confirmedPlayer = confirmedId === undefined ? undefined : byId.get(confirmedId);

    if (confirmedId !== undefined) {
      if (!confirmedPlayer || clubId === undefined || confirmedPlayer.teamId !== clubId) {
        unresolved.push({
          ...source,
          reason: "INVALID_CONFIRMED_MAPPING",
          candidates: (confirmedPlayer ? [confirmedPlayer, ...candidates] : candidates)
            .filter((player, index, all) => all.findIndex((item) => item.id === player.id) === index)
            .map(playerCandidate),
        });
        continue;
      }
      mapped.push({ ...source, playerId: confirmedPlayer.id, method: "CONFIRMED_MAPPING" });
      continue;
    }

    if (clubId === undefined) {
      unresolved.push({ ...source, reason: "NO_CLUB_MAPPING", candidates: candidates.map(playerCandidate) });
      continue;
    }
    if (!clubPlayers.length) {
      unresolved.push({ ...source, reason: "NO_CLUB_PLAYERS", candidates: [] });
      continue;
    }
    if (names.exact.length === 1) {
      mapped.push({ ...source, playerId: names.exact[0].id, method: "EXACT_NAME" });
      continue;
    }
    if (names.exact.length > 1) {
      unresolved.push({ ...source, reason: "AMBIGUOUS", candidates: names.exact.map(playerCandidate) });
      continue;
    }
    if (names.fallback.length === 1) {
      mapped.push({ ...source, playerId: names.fallback[0].id, method: "UNIQUE_FALLBACK" });
      continue;
    }
    unresolved.push({
      ...source,
      reason: names.fallback.length ? "AMBIGUOUS" : "NO_NAME_MATCH",
      candidates: names.fallback.map(playerCandidate),
    });
  }

  return { mapped, unresolved, ambiguous: unresolved.filter((record) => record.reason === "AMBIGUOUS") };
}

export const mapRotowireSnapshot = mapRotowireLineups;

export type { RotowirePlayer, RotowireUnavailablePlayer };
