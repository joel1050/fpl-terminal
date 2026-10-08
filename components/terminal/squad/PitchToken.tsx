import { FixtureChip, RunStrip } from "@/components/terminal/fixtures/FixtureChips";
import { availabilityOf } from "@/lib/availability/status";
import { clubColour, shirtTextColour } from "@/lib/display/clubColours";
import { points } from "@/lib/display/format";
import { weeklyPlayerMetrics } from "@/lib/squad/weeklyLineup";
import type { Player, PlayerFixture } from "@/types";
import type { ChipKind } from "@/types/chips";

/** The captain scores double; Triple Captain makes it treble. */
export function captainMultiplier(captain: boolean, chip?: ChipKind | null): number {
  return captain ? (chip === "3xc" ? 3 : 2) : 1;
}

/** Expected points for the Gameweek, with the captain's multiplier. Uses the weekly-lineup engine. */
export function pitchXp(player: Player, gameweek: number, captain: boolean, chip?: ChipKind | null): number {
  return weeklyPlayerMetrics(player, gameweek).points * captainMultiplier(captain, chip);
}

/** The player's fixtures in one Gameweek, from the projection when it has them. */
export function squadFixturesForGameweek(player: Player, gameweek: number): PlayerFixture[] {
  const projectedFixtures = player.projection?.fixtures ?? [];
  if (projectedFixtures.length) return projectedFixtures.filter((fixture) => fixture.gameweek === gameweek).map((fixture) => fixture.fixture);
  return player.fixtures.filter((fixture) => fixture.gameweek === gameweek);
}

export interface PitchTokenProps {
  player: Player;
  gameweek: number;
  role: "starter" | "bench";
  benchLabel?: string;
  captain: boolean;
  vice: boolean;
  locked: boolean;
  chip?: ChipKind | null;
  /** The action sheet is open for this player, or they are the pending swap. */
  selected: boolean;
  /** A pending swap is waiting for a player on this side. */
  swapTarget: boolean;
  showRun: boolean;
  onOpen: () => void;
}

/** One player on the pitch or the bench: shirt, role, flags, fixture, xP. Tapping it opens the action sheet. */
export function PitchToken({ player, gameweek, role, benchLabel, captain, vice, locked, chip, selected, swapTarget, showRun, onOpen }: PitchTokenProps) {
  const availability = availabilityOf(player);
  const fixtures = squadFixturesForGameweek(player, gameweek);
  const shirtColour = clubColour(player.teamShortName);
  const roleText = captain ? (chip === "3xc" ? "3×" : "C") : vice ? "V" : null;
  const benchCounting = chip === "bboost" && role === "bench";
  return (
    <button
      type="button"
      className={["pitch-token", role === "bench" ? "benched" : "", selected ? "selected" : "", swapTarget ? "swap-target" : ""].join(" ")}
      data-testid="squad-token"
      data-player={player.displayName}
      aria-pressed={selected}
      aria-haspopup="dialog"
      aria-label={`${player.displayName}, ${player.teamShortName}`}
      onClick={onOpen}
    >
      <span className="token-shirt" style={{ background: shirtColour, color: shirtTextColour(shirtColour) }} aria-hidden="true">
        {player.teamShortName}
        {roleText && <span className={`token-role ${captain ? "captain" : "vice"}`} data-testid="token-role">{roleText}</span>}
        {availability !== "AVAILABLE" && <span className={`token-flag ${availability === "UNAVAILABLE" ? "bad" : "warn"}`} data-testid="token-flag" data-availability={availability}>!</span>}
        {locked && <svg className="token-lock lock-icon" viewBox="0 0 16 16" aria-hidden="true"><path className="lock-shackle" d="M4 7V5a4 4 0 0 1 8 0v2" /><rect className="lock-body" x="2.5" y="7" width="11" height="7" /></svg>}
      </span>
      <span className="token-name">{player.displayName}</span>
      <span className="token-fixture" data-testid="token-fixture">
        {fixtures.length ? fixtures.map((fixture, index) => <FixtureChip key={index} fixture={fixture} />) : <span className="token-blank">BLANK</span>}
      </span>
      <b className="token-xp" data-testid="token-xp">{points(pitchXp(player, gameweek, captain, chip))} xP</b>
      {role === "bench" && benchLabel && <span className="token-bench" data-testid="token-bench">{benchLabel}{benchCounting ? " · Counts" : ""}</span>}
      {showRun && <RunStrip fixtures={player.fixtures} fromGameweek={gameweek} count={5} />}
    </button>
  );
}
