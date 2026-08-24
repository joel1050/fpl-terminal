import type { Player } from "@/types/player";

export interface ExpectedMinutesOptions {
  currentGameweek?: number;
  recentMinutes?: number;
  recentStarts?: number;
  recentMatches?: number;
  recentSubstituteAppearances?: number;
  /** Explicit minutes are useful when a caller has already built a minutes model. */
  override?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

// Mirrors officialAvailability in lib/availability/selection.ts, so a
// player without a selection model is treated identically to one with a
// selection model for the same underlying fact. player.status is always
// FPL's short code (i, d, s, u, n, ...), never descriptive text.
function statusAvailability(player: Player): number {
  const status = player.status.trim().toLowerCase();
  const unavailable = ["i", "u", "n", "s"].includes(status);
  const chance = typeof player.chanceOfPlaying === "number" ? clamp(player.chanceOfPlaying, 0, 100) / 100 : undefined;
  let availability = 1;
  if (unavailable) {
    availability = 0.01;
    if (chance !== undefined) availability *= chance;
  } else if (status === "d") {
    // chanceOfPlaying is already FPL's specific estimate for this doubtful
    // player; use it directly rather than stacking a generic discount on
    // top of an already-specific number.
    availability = chance ?? 0.7;
  }
  return clamp(availability, 0, 1);
}

function scenarioMinutes(startRate: number): number {
  // A 38-match season prior maps zero starts to a cameo role and an every-match
  // starter to roughly 82 minutes, without letting a short sample saturate.
  return 22 + clamp(startRate, 0, 1) * 60;
}

function priorMinutes(player: Player): number {
  const history = player.historical;
  // Without a sample, assume no minutes until another source establishes a role.
  if (!history || history.minutes <= 0) return 0;
  const estimatedMatches = 38;
  const startRate = history.starts === undefined
    ? 0.5
    : clamp(history.starts / estimatedMatches, 0, 1);
  return scenarioMinutes(startRate);
}

function observedRecentMinutes(player: Player, options: ExpectedMinutesOptions): number | undefined {
  if (options.override !== undefined) return options.override;
  const minutes = options.recentMinutes ??
    (options.currentGameweek && options.currentGameweek > 0 ? player.current.minutes : undefined);
  if (minutes === undefined) return undefined;
  const matches = options.recentMatches ?? options.currentGameweek ?? 1;
  if (matches <= 0) return undefined;
  const starts = options.recentStarts;
  if (starts !== undefined) {
    const startRate = clamp(starts / matches, 0, 1);
    const averageMinutes = clamp(minutes / matches, 0, 90);
    return clamp(averageMinutes * 0.35 + scenarioMinutes(startRate) * 0.65, 0, 90);
  }
  const averageMinutes = clamp(minutes / matches, 0, 90);
  const subRate = options.recentSubstituteAppearances === undefined
    ? 0
    : clamp(options.recentSubstituteAppearances / matches, 0, 1);
  return clamp(averageMinutes * (1 - subRate * 0.25), 0, 90);
}

/** Estimates minutes in one upcoming fixture on a 0–90 scale. */
export function estimateExpectedMinutes(
  player: Player,
  options: ExpectedMinutesOptions = {},
): number {
  if (options.override !== undefined) return clamp(options.override, 0, 90);
  if (player.selection && Number.isFinite(player.selection.expectedMinutes)) {
    return clamp(player.selection.expectedMinutes, 0, 90);
  }
  const prior = priorMinutes(player);
  const recent = observedRecentMinutes(player, options);
  let estimate = recent === undefined
    ? prior
    : prior * (1 - clamp((options.currentGameweek ?? 1) / 8, 0.15, 0.65)) +
      recent * clamp((options.currentGameweek ?? 1) / 8, 0.15, 0.65);
  estimate *= statusAvailability(player);
  return Math.round(clamp(estimate, 0, 90) * 10) / 10;
}

export const expectedMinutes = estimateExpectedMinutes;
