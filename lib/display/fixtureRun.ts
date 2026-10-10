import type { PlayerFixture } from "@/types/player";

/** The last Gameweek of a season. Slots past it do not exist, so they are never blank. */
export const LAST_GAMEWEEK = 38;

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5;

/** One Gameweek in a run. No fixtures means a blank Gameweek. */
export interface GameweekSlot {
  gameweek: number;
  fixtures: PlayerFixture[];
}

/** Rounds to a whole level from 1 to 5. A missing or non-numeric difficulty is the neutral 3. */
export function difficultyLevel(difficulty: number | undefined): DifficultyLevel {
  if (difficulty === undefined || !Number.isFinite(difficulty)) return 3;
  return Math.min(5, Math.max(1, Math.round(difficulty))) as DifficultyLevel;
}

/**
 * The `count` Gameweeks from `fromGameweek`, one slot each. Counting is by
 * Gameweek, so a double Gameweek is one slot holding two fixtures. The window
 * stops at LAST_GAMEWEEK.
 */
export function gameweekSlots(fixtures: readonly PlayerFixture[], fromGameweek: number, count: number): GameweekSlot[] {
  const last = Math.min(fromGameweek + count - 1, LAST_GAMEWEEK);
  const slots: GameweekSlot[] = [];
  for (let gameweek = fromGameweek; gameweek <= last; gameweek += 1) {
    slots.push({ gameweek, fixtures: fixtures.filter((fixture) => fixture.gameweek === gameweek) });
  }
  return slots;
}
