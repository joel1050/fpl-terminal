import type { Player, Position } from "@/types/player";
import {
  INITIAL_BUDGET_TENTHS,
  MAX_PLAYERS_PER_CLUB,
  SQUAD_SIZE,
  type SquadConstraints,
  type SquadState,
  type SquadValidation,
} from "@/types/squad";

export const DEFAULT_SQUAD_CONSTRAINTS: SquadConstraints = {
  budgetTenths: INITIAL_BUDGET_TENTHS,
  positionCounts: { GK: 2, DEF: 5, MID: 5, FWD: 3 },
  maxPlayersPerClub: MAX_PLAYERS_PER_CLUB,
};

export const POSITION_COUNTS = DEFAULT_SQUAD_CONSTRAINTS.positionCounts;

export type SquadPlayers = readonly Player[];

const positions: readonly Position[] = ["GK", "DEF", "MID", "FWD"];

export function mergeConstraints(
  constraints?: Partial<SquadConstraints>,
): SquadConstraints {
  return {
    ...DEFAULT_SQUAD_CONSTRAINTS,
    ...constraints,
    positionCounts: {
      ...DEFAULT_SQUAD_CONSTRAINTS.positionCounts,
      ...constraints?.positionCounts,
    },
  };
}

function formatPrice(tenths: number): string {
  return `£${(tenths / 10).toFixed(1)}m`;
}

function counts(players: SquadPlayers): Record<Position, number> {
  return players.reduce(
    (result, player) => {
      result[player.position] += 1;
      return result;
    },
    { GK: 0, DEF: 0, MID: 0, FWD: 0 } as Record<Position, number>,
  );
}

export function squadCostTenths(players: SquadPlayers): number {
  return players.reduce((sum, player) => sum + player.priceTenths, 0);
}

export function squadPositionCounts(
  players: SquadPlayers,
): Record<Position, number> {
  return counts(players);
}

export function squadClubCounts(players: SquadPlayers): Map<number, number> {
  const result = new Map<number, number>();
  for (const player of players) {
    result.set(player.teamId, (result.get(player.teamId) ?? 0) + 1);
  }
  return result;
}

function duplicateIds(players: SquadPlayers): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const player of players) {
    if (seen.has(player.id)) duplicates.add(player.id);
    seen.add(player.id);
  }
  return [...duplicates].sort((a, b) => a - b);
}

/**
 * Validates rules that apply while a squad is being built. A partial squad is
 * valid when it can still be a prefix of a legal 15-player squad; completion
 * feasibility belongs to `calculateBudgetFeasibility`.
 */
export function validatePartialSquad(
  players: SquadPlayers,
  constraints?: Partial<SquadConstraints>,
): SquadValidation {
  const rules = mergeConstraints(constraints);
  const errors: string[] = [];
  const warnings: string[] = [];
  const positionCounts = counts(players);
  const duplicates = duplicateIds(players);
  const cost = squadCostTenths(players);

  if (duplicates.length > 0) {
    errors.push(`Duplicate player selection: ${duplicates.join(", ")}.`);
  }
  if (players.length > SQUAD_SIZE) {
    errors.push(`A squad cannot contain more than ${SQUAD_SIZE} players.`);
  }
  if (cost > rules.budgetTenths) {
    errors.push(
      `Squad cost ${formatPrice(cost)} exceeds the ${formatPrice(rules.budgetTenths)} budget.`,
    );
  }
  for (const position of positions) {
    if (positionCounts[position] > rules.positionCounts[position]) {
      errors.push(
        `${position} has ${positionCounts[position]} players; at most ${rules.positionCounts[position]} are allowed.`,
      );
    }
  }
  for (const [teamId, count] of squadClubCounts(players)) {
    if (count > rules.maxPlayersPerClub) {
      errors.push(
        `Club ${teamId} has ${count} players; at most ${rules.maxPlayersPerClub} are allowed.`,
      );
    }
  }

  if (players.length < SQUAD_SIZE && errors.length === 0) {
    warnings.push(`${SQUAD_SIZE - players.length} squad slots remain.`);
  }
  return { legal: errors.length === 0, errors, warnings };
}

/** Enforces the full FPL squad shape, including exactly 15 players. */
export function validateSquad(
  players: SquadPlayers,
  constraints?: Partial<SquadConstraints>,
): SquadValidation {
  const rules = mergeConstraints(constraints);
  const partial = validatePartialSquad(players, rules);
  const errors = [...partial.errors];
  const warnings: string[] = [];

  if (players.length !== SQUAD_SIZE) {
    errors.push(`A complete squad must contain exactly ${SQUAD_SIZE} players.`);
  }
  const positionCounts = counts(players);
  for (const position of positions) {
    if (positionCounts[position] !== rules.positionCounts[position]) {
      errors.push(
        `${position} must contain exactly ${rules.positionCounts[position]} players; found ${positionCounts[position]}.`,
      );
    }
  }
  return { legal: errors.length === 0, errors, warnings };
}

export function isLegalSquad(
  players: SquadPlayers,
  constraints?: Partial<SquadConstraints>,
): boolean {
  return validateSquad(players, constraints).legal;
}

export const legalSquad = validateSquad;

export function isLegalPartialSquad(
  players: SquadPlayers,
  constraints?: Partial<SquadConstraints>,
): boolean {
  return validatePartialSquad(players, constraints).legal;
}

/** Converts a player array to the UI-facing state shape without changing it. */
export function toSquadState(players: SquadPlayers): SquadState {
  return {
    playerIds: players.map((player) => player.id),
    byPosition: {
      GK: players.filter((player) => player.position === "GK").map((player) => player.id),
      DEF: players.filter((player) => player.position === "DEF").map((player) => player.id),
      MID: players.filter((player) => player.position === "MID").map((player) => player.id),
      FWD: players.filter((player) => player.position === "FWD").map((player) => player.id),
    },
  };
}

export { formatPrice };
