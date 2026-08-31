import type { LiveEntryPlayer, PlayerFixtureStatus } from "@/types/leagues";

export type RoleMarker = "C" | "VC";

/**
 * Only the two real captaincy holders receive a marker. No bench labels and no
 * interactive role controls exist on the Leagues screen.
 */
export function roleMarkerFor(player: { isCaptain: boolean; isViceCaptain: boolean }): RoleMarker | null {
  if (player.isCaptain) return "C";
  if (player.isViceCaptain) return "VC";
  return null;
}

export function kickoffLabel(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fixtureTag(
  fixture: PlayerFixtureStatus,
  shortNames: ReadonlyMap<number, string>,
): string {
  const opponent = shortNames.get(fixture.opponentTeamId) ?? String(fixture.opponentTeamId);
  const venue = fixture.isHome ? "H" : "A";
  if (fixture.state === "FINISHED") return `${opponent}(${venue}) · FT`;
  if (fixture.state === "LIVE") return `${opponent}(${venue}) · ${Math.min(90, Math.floor(fixture.minutes ?? 0))}'`;
  const time = kickoffLabel(fixture.kickoffTime);
  return time ? `${opponent}(${venue}) · ${time}` : `${opponent}(${venue})`;
}

export interface PlayerValueLabel {
  value: string;
  unit: "xP" | "P";
  started: boolean;
}

/**
 * xP comes from the projection model and is shown only before a player's first
 * Gameweek fixture starts; afterwards the actual FPL points take over. Both
 * carry the armband: a captain's card shows what the captain is worth to the
 * score, doubled or tripled, exactly as FPL's own points view does. A benched
 * player scores nothing, so their card shows their own value rather than zero.
 */
export function playerValueLabel(player: LiveEntryPlayer): PlayerValueLabel {
  const multiplier = Math.max(player.multiplier, 1);
  if (player.status === "TO_PLAY") {
    return { value: (player.expectedPoints * multiplier).toFixed(1), unit: "xP", started: false };
  }
  return { value: `${Math.round(player.points * multiplier)}`, unit: "P", started: true };
}

/**
 * How long ago the feed saw an event land. Only meaningful for one watched as
 * it happened: a reconstructed row records when it was read, never when it
 * happened, so it goes without an age rather than with a wrong one.
 *
 * The clock ticks on an interval, so an event that has just arrived can carry a
 * timestamp slightly ahead of it. That still reads as brand new, not as nothing.
 */
export function feedAgeLabel(event: { seeded: boolean; at: number }, now: number): string | null {
  if (event.seeded) return null;
  const minutes = Math.floor((now - event.at) / 60_000);
  if (!Number.isFinite(minutes)) return null;
  return minutes < 1 ? "<1M" : `${minutes}M`;
}
