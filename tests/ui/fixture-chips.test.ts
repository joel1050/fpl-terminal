import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FixtureChip, FixtureRun, RunStrip } from "@/components/terminal/fixtures/FixtureChips";
import { fixtureLabel } from "@/lib/display/fixtureLabel";
import { difficultyLevel, gameweekSlots } from "@/lib/display/fixtureRun";
import type { PlayerFixture } from "@/types/player";

function fixture(gameweek: number, opponentShortName: string, isHome: boolean, difficulty?: number): PlayerFixture {
  return { gameweek, opponentTeamId: 1, opponentShortName, isHome, difficulty };
}

function chipCount(html: string): number {
  return html.match(/class="fc /g)?.length ?? 0;
}

describe("fixtureLabel", () => {
  it("upper-cases home and lower-cases away", () => {
    expect(fixtureLabel({ opponentShortName: "LEE", isHome: true })).toBe("LEE");
    expect(fixtureLabel({ opponentShortName: "LEE", isHome: false })).toBe("lee");
  });

  it("normalises mixed-case short names before applying the venue case", () => {
    expect(fixtureLabel({ opponentShortName: "Lee", isHome: true })).toBe("LEE");
    expect(fixtureLabel({ opponentShortName: "Lee", isHome: false })).toBe("lee");
  });
});

describe("difficultyLevel", () => {
  it("treats a missing or non-numeric difficulty as the neutral level 3", () => {
    expect(difficultyLevel(undefined)).toBe(3);
    expect(difficultyLevel(Number.NaN)).toBe(3);
  });

  it("clamps to the 1–5 scale", () => {
    expect(difficultyLevel(0)).toBe(1);
    expect(difficultyLevel(-2)).toBe(1);
    expect(difficultyLevel(9)).toBe(5);
  });

  it("rounds a fractional difficulty to a whole level", () => {
    expect(difficultyLevel(2.6)).toBe(3);
    expect(difficultyLevel(2.4)).toBe(2);
  });
});

describe("gameweekSlots", () => {
  it("returns one slot per Gameweek from the start, with a blank slot for a Gameweek without a fixture", () => {
    const slots = gameweekSlots([fixture(6, "LEE", true), fixture(7, "ARS", false)], 6, 3);
    expect(slots.map((slot) => slot.gameweek)).toEqual([6, 7, 8]);
    expect(slots[2].fixtures).toEqual([]);
  });

  it("counts a double Gameweek as one slot holding both fixtures", () => {
    const slots = gameweekSlots([fixture(6, "LEE", true), fixture(6, "ARS", false), fixture(7, "CHE", true)], 6, 5);
    expect(slots).toHaveLength(5);
    expect(slots[0].fixtures.map((f) => f.opponentShortName)).toEqual(["LEE", "ARS"]);
    expect(slots[1].fixtures).toHaveLength(1);
  });

  it("ignores fixtures before the start and after the window", () => {
    const fixtures = [fixture(5, "TOT", true), fixture(7, "SUN", true), fixture(9, "BRE", true), fixture(12, "NEW", true)];
    const slots = gameweekSlots(fixtures, 6, 3);
    expect(slots.flatMap((slot) => slot.fixtures.map((f) => f.opponentShortName))).toEqual(["SUN"]);
  });

  it("stops at the last Gameweek of the season", () => {
    const slots = gameweekSlots([], 36, 5);
    expect(slots.map((slot) => slot.gameweek)).toEqual([36, 37, 38]);
  });

  it("returns no slots for a zero count", () => {
    expect(gameweekSlots([fixture(6, "LEE", true)], 6, 0)).toEqual([]);
  });
});

describe("FixtureChip", () => {
  it("shows an upper-case home opponent coloured by its difficulty", () => {
    const html = renderToStaticMarkup(createElement(FixtureChip, { fixture: fixture(6, "LEE", true, 2) }));
    expect(html).toContain('class="fc d2"');
    expect(html).toContain(">LEE<");
  });

  it("shows a lower-case away opponent", () => {
    const html = renderToStaticMarkup(createElement(FixtureChip, { fixture: fixture(6, "LEE", false, 4) }));
    expect(html).toContain('class="fc d4"');
    expect(html).toContain(">lee<");
  });

  it("uses class d3 when the difficulty is missing", () => {
    const html = renderToStaticMarkup(createElement(FixtureChip, { fixture: fixture(6, "LEE", true) }));
    expect(html).toContain('class="fc d3"');
  });

  it("clamps out-of-range difficulty to d1 and d5", () => {
    const low = renderToStaticMarkup(createElement(FixtureChip, { fixture: fixture(6, "LEE", true, 0) }));
    const high = renderToStaticMarkup(createElement(FixtureChip, { fixture: fixture(6, "LEE", true, 9) }));
    expect(low).toContain('class="fc d1"');
    expect(high).toContain('class="fc d5"');
  });
});

describe("FixtureRun", () => {
  it("shows two chips for a double Gameweek and counts five Gameweeks, not fixture rows", () => {
    const fixtures = [
      fixture(6, "LEE", true, 2),
      fixture(6, "ARS", false, 5),
      fixture(7, "CHE", true, 3),
      fixture(8, "NEW", false, 3),
      fixture(9, "BRE", true, 3),
      fixture(10, "BHA", false, 3),
      fixture(11, "MCI", true, 1),
    ];
    const html = renderToStaticMarkup(createElement(FixtureRun, { fixtures, fromGameweek: 6, count: 5 }));
    expect(chipCount(html)).toBe(6);
    expect(html).not.toContain("MCI");
  });

  it("shows a muted dash chip for a blank Gameweek", () => {
    const fixtures = [fixture(6, "LEE", true, 2), fixture(8, "ARS", false, 4)];
    const html = renderToStaticMarkup(createElement(FixtureRun, { fixtures, fromGameweek: 6, count: 3 }));
    expect(html).toContain('class="fc blank"');
    expect(html).toContain("—");
    expect(chipCount(html)).toBe(3);
  });

  it("shows a blank chip before the first fixture when the window starts earlier", () => {
    const html = renderToStaticMarkup(
      createElement(FixtureRun, { fixtures: [fixture(7, "LEE", true, 2)], fromGameweek: 6, count: 2 }),
    );
    expect(html.indexOf('class="fc blank"')).toBeLessThan(html.indexOf("LEE"));
  });

  it("shows a dash when no Gameweek is in the window", () => {
    const html = renderToStaticMarkup(createElement(FixtureRun, { fixtures: [], fromGameweek: 6, count: 0 }));
    expect(html).toBe("—");
  });
});

describe("RunStrip", () => {
  it("draws one bar per Gameweek, coloured by difficulty, with an empty bar for a blank Gameweek", () => {
    const fixtures = [
      fixture(6, "LEE", true, 2),
      fixture(7, "ARS", false, 5),
      fixture(9, "BRE", true, 1),
      fixture(10, "BHA", false, 4),
    ];
    const html = renderToStaticMarkup(createElement(RunStrip, { fixtures, fromGameweek: 6, count: 5 }));
    expect(html.match(/class="run-slot"/g)).toHaveLength(5);
    expect(html.match(/<i /g)).toHaveLength(5);
    expect(html).toContain('<i class="d2"></i>');
    expect(html).toContain('<i class="d5"></i>');
    expect(html).toContain('<i class="blank"></i>');
    expect(html).toContain('<i class="d1"></i>');
    expect(html).toContain('<i class="d4"></i>');
  });

  it("splits a double Gameweek into two bars inside one slot", () => {
    const fixtures = [fixture(6, "LEE", true, 1), fixture(6, "ARS", false, 5)];
    const html = renderToStaticMarkup(createElement(RunStrip, { fixtures, fromGameweek: 6, count: 1 }));
    expect(html.match(/class="run-slot"/g)).toHaveLength(1);
    expect(html.match(/<i /g)).toHaveLength(2);
  });

  it("is decorative, since the chips carry the labels", () => {
    const html = renderToStaticMarkup(createElement(RunStrip, { fixtures: [], fromGameweek: 6, count: 5 }));
    expect(html).toContain('aria-hidden="true"');
  });
});
