import { fixtureLabel } from "@/lib/display/fixtureLabel";
import { difficultyLevel, gameweekSlots } from "@/lib/display/fixtureRun";
import type { PlayerFixture } from "@/types/player";

export { fixtureLabel } from "@/lib/display/fixtureLabel";

/** One fixture: the opponent's label, coloured by difficulty. */
export function FixtureChip({ fixture }: { fixture: PlayerFixture }) {
  const level = difficultyLevel(fixture.difficulty);
  return (
    <span className={`fc d${level}`} title={`${fixture.isHome ? "Home" : "Away"} · difficulty ${level}`}>
      {fixtureLabel(fixture)}
    </span>
  );
}

export interface FixtureRunProps {
  fixtures: readonly PlayerFixture[];
  /** First Gameweek of the window. Pass the planning Gameweek so leading blanks show. */
  fromGameweek: number;
  /** Number of Gameweeks in the window, not fixture rows. */
  count: number;
}

/** The window as chips: one per fixture, so a double shows two, and a dash for a blank Gameweek. */
export function FixtureRun({ fixtures, fromGameweek, count }: FixtureRunProps) {
  const slots = gameweekSlots(fixtures, fromGameweek, count);
  if (!slots.length) return <>—</>;
  return (
    <span className="fixture-chips">
      {slots.flatMap((slot) =>
        slot.fixtures.length
          ? slot.fixtures.map((fixture, index) => <FixtureChip key={`${slot.gameweek}-${index}`} fixture={fixture} />)
          : [<span className="fc blank" key={slot.gameweek} title={`Gameweek ${slot.gameweek}: blank`}>—</span>],
      )}
    </span>
  );
}

/** One bar per Gameweek. A double splits its bar in two; a blank Gameweek is an empty bar. */
export function RunStrip({ fixtures, fromGameweek, count }: FixtureRunProps) {
  return (
    <span className="run" aria-hidden="true">
      {gameweekSlots(fixtures, fromGameweek, count).map((slot) => (
        <span className="run-slot" key={slot.gameweek}>
          {slot.fixtures.length
            ? slot.fixtures.map((fixture, index) => <i className={`d${difficultyLevel(fixture.difficulty)}`} key={index} />)
            : <i className="blank" />}
        </span>
      ))}
    </span>
  );
}
