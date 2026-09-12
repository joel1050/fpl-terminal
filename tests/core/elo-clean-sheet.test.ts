import { describe, expect, it } from "vitest";
import type { TeamStrength } from "@/types/projection";
import type { PlayerFixture } from "@/types/player";
import {
  deriveCleanSheetStrengths,
  CLEAN_SHEET_SKEW_WEIGHT,
  ELO_LEVEL_SLOPE,
} from "@/lib/projections/cleanSheetStrength";
import {
  calculateFixtureAdjustment,
  cleanSheetFromRates,
  CLEAN_SHEET_DISPERSION,
  LEAGUE_MEAN_XG,
} from "@/lib/projections/fixtureAdjustment";
import type { ClubEloSnapshot } from "@/lib/clubElo";
import { CLUB_ELO_HOME_FIELD_ADVANTAGE, CLUB_ELO_SOURCE } from "@/lib/clubElo";

const snapshot: ClubEloSnapshot = {
  source: CLUB_ELO_SOURCE,
  fetchedAt: "2026-09-06T00:00:00.000Z",
  snapshotDate: "2026-09-06",
  homeFieldAdvantage: CLUB_ELO_HOME_FIELD_ADVANTAGE,
  clubs: [
    { name: "Arsenal", tlc: "ARS", slug: "Arsenal", elo: 2034 },
    { name: "Everton", tlc: "EVE", slug: "Everton", elo: 1817 },
    { name: "Hull", tlc: "HUL", slug: "Hull", elo: 1633 },
  ],
};

const flat = (teamId: number, attack: number, defence: number): TeamStrength => ({
  teamId, attackHome: attack, attackAway: attack, defenceHome: defence, defenceAway: defence,
  overall: (attack + defence) / 2,
});

const names = new Map([[1, "ARS"], [2, "EVE"], [3, "HUL"]]);
const strengths = { 1: flat(1, 1.2, 1.15), 2: flat(2, 1.0, 1.05), 3: flat(3, 0.82, 0.83) };

describe("deriveCleanSheetStrengths", () => {
  it("spreads teams by Elo at the measured slope", () => {
    const rates = deriveCleanSheetStrengths(strengths, names, snapshot);
    const level = (id: number) => Math.log(rates[id].attack) + Math.log(rates[id].defence);
    // Level is a pure function of the Elo gap, whatever the strengths say.
    expect(level(1) - level(3)).toBeCloseTo(ELO_LEVEL_SLOPE * (2034 - 1633), 10);
    expect(level(1) - level(2)).toBeCloseTo(ELO_LEVEL_SLOPE * (2034 - 1817), 10);
  });

  it("keeps the attack-minus-defence lean, shrunk", () => {
    const rates = deriveCleanSheetStrengths(strengths, names, snapshot);
    const skew = (id: number) => Math.log(rates[id].attack) - Math.log(rates[id].defence);
    expect(skew(1)).toBeCloseTo(CLEAN_SHEET_SKEW_WEIGHT * Math.log(1.2 / 1.15), 10);
    // Arsenal leans attacking here; the shrunk lean must keep that sign.
    expect(skew(1)).toBeGreaterThan(0);
  });

  it("drops a team ClubElo cannot name, and returns nothing when none resolve", () => {
    const withUnknown = { ...strengths, 4: flat(4, 1, 1) };
    const rates = deriveCleanSheetStrengths(withUnknown, new Map([...names, [4, "ZZZ"]]), snapshot);
    expect(rates[4]).toBeUndefined();
    expect(Object.keys(rates)).toHaveLength(3);
    expect(deriveCleanSheetStrengths(strengths, new Map(), snapshot)).toEqual({});
  });
});

describe("cleanSheetFromRates", () => {
  it("reads P(0) off the negative binomial at the fitted mean", () => {
    const { cleanSheetProbability, goalsAgainst } = cleanSheetFromRates(true, 1, 1);
    expect(goalsAgainst).toBeCloseTo(LEAGUE_MEAN_XG * 0.898, 10);
    expect(cleanSheetProbability).toBeCloseTo(
      (CLEAN_SHEET_DISPERSION / (CLEAN_SHEET_DISPERSION + goalsAgainst)) ** CLEAN_SHEET_DISPERSION, 10);
  });

  it("favours the home side, and a better defence over a stronger attack", () => {
    expect(cleanSheetFromRates(true, 1, 1).cleanSheetProbability)
      .toBeGreaterThan(cleanSheetFromRates(false, 1, 1).cleanSheetProbability);
    expect(cleanSheetFromRates(true, 1.3, 1).cleanSheetProbability)
      .toBeGreaterThan(cleanSheetFromRates(true, 1, 1).cleanSheetProbability);
    expect(cleanSheetFromRates(true, 1, 1.3).cleanSheetProbability)
      .toBeLessThan(cleanSheetFromRates(true, 1, 1).cleanSheetProbability);
  });

  it("reaches above the 5x5 table's ceiling for a strong defence against a weak attack", () => {
    // The table maxes at 0.50 before compression; the point of the change is
    // that a lopsided fixture is not capped there.
    expect(cleanSheetFromRates(true, 1.45, 0.7).cleanSheetProbability).toBeGreaterThan(0.5);
  });
});

describe("calculateFixtureAdjustment clean-sheet source", () => {
  const fixture: PlayerFixture = {
    gameweek: 4, opponentTeamId: 3, opponentShortName: "HUL", isHome: true, difficulty: 2,
  };
  const own = flat(1, 1.2, 1.15);
  const opponent = flat(3, 0.82, 0.83);

  it("uses the rated path when both sides have rates, and the table when they do not", () => {
    const rates = deriveCleanSheetStrengths(strengths, names, snapshot);
    const rated = calculateFixtureAdjustment(fixture, {
      ownTeam: own, opponentTeam: opponent,
      ownCleanSheet: rates[1], opponentCleanSheet: rates[3],
    });
    const tabled = calculateFixtureAdjustment(fixture, { ownTeam: own, opponentTeam: opponent });
    expect(rated.cleanSheetProbability).toBeCloseTo(
      cleanSheetFromRates(true, rates[1].defence, rates[3].attack).cleanSheetProbability, 10);
    expect(rated.cleanSheetProbability).not.toBeCloseTo(tabled.cleanSheetProbability, 3);
    // One rate missing is not enough; it must fall back rather than half-apply.
    expect(calculateFixtureAdjustment(fixture, {
      ownTeam: own, opponentTeam: opponent, ownCleanSheet: rates[1],
    }).cleanSheetProbability).toBeCloseTo(tabled.cleanSheetProbability, 10);
  });

  it("does not compress the rated read, and keeps goals-against consistent with it", () => {
    const rates = deriveCleanSheetStrengths(strengths, names, snapshot);
    const rated = calculateFixtureAdjustment(fixture, {
      ownTeam: own, opponentTeam: opponent,
      ownCleanSheet: rates[1], opponentCleanSheet: rates[3],
    });
    const raw = cleanSheetFromRates(true, rates[1].defence, rates[3].attack);
    expect(rated.cleanSheetProbability).toBeCloseTo(raw.cleanSheetProbability, 10);
    expect(rated.expectedGoalsAgainst).toBeCloseTo(raw.goalsAgainst, 10);
    // The Poisson inversion the table path uses would understate this mean.
    expect(raw.goalsAgainst).toBeGreaterThan(-Math.log(raw.cleanSheetProbability));
  });

  it("still compresses the table read above the base rate", () => {
    const strong = flat(9, 1.0, 1.16);
    const weak = flat(8, 0.84, 1.0);
    const tabled = calculateFixtureAdjustment(fixture, { ownTeam: strong, opponentTeam: weak });
    expect(tabled.cleanSheetProbability).toBeLessThan(0.5);
    expect(tabled.expectedGoalsAgainst).toBeCloseTo(-Math.log(tabled.cleanSheetProbability), 10);
  });
});

describe("deriveCleanSheetStrengths level blend", () => {
  // A side whose attack and defence have both collapsed is a worse team, but
  // its attack-minus-defence lean is unchanged, so a level taken purely from
  // Elo cannot see it. These cover the handover to the in-season fit.
  const collapsed = { ...strengths, 2: flat(2, 0.70, 0.74) };

  it("ignores the fitted level when no matches have been played", () => {
    const none = deriveCleanSheetStrengths(collapsed, names, snapshot, new Map());
    const elo = deriveCleanSheetStrengths(collapsed, names, snapshot);
    for (const id of [1, 2, 3]) {
      expect(none[id].defence).toBeCloseTo(elo[id].defence, 12);
      expect(none[id].attack).toBeCloseTo(elo[id].attack, 12);
    }
  });

  it("marks a collapsed side down once its matches carry the level", () => {
    const played = new Map([[1, 20], [2, 20], [3, 20]]);
    const before = deriveCleanSheetStrengths(collapsed, names, snapshot);
    const after = deriveCleanSheetStrengths(collapsed, names, snapshot, played);
    // Everton's lean barely moves, so the shipped read barely moves either.
    expect(Math.abs(after[2].defence - before[2].defence)).toBeGreaterThan(0.02);
    expect(after[2].defence).toBeLessThan(before[2].defence);
  });

  it("keeps the lean untouched and moves only the level", () => {
    const played = new Map([[1, 20], [2, 20], [3, 20]]);
    const after = deriveCleanSheetStrengths(collapsed, names, snapshot, played);
    const skew = (id: number) => Math.log(after[id].attack) - Math.log(after[id].defence);
    expect(skew(2)).toBeCloseTo(CLEAN_SHEET_SKEW_WEIGHT * Math.log(0.70 / 0.74), 10);
  });

  it("holds the fitted level to the spread Elo already has", () => {
    // Only true in the limit: at any finite match count the level is a blend of
    // two differently ordered series, whose spread is legitimately narrower
    // than either. The claim under test is about the stretch, so take the
    // weight to 1.
    const played = new Map([[1, 1e7], [2, 1e7], [3, 1e7]]);
    const after = deriveCleanSheetStrengths(collapsed, names, snapshot, played);
    const level = (id: number) => Math.log(after[id].attack) + Math.log(after[id].defence);
    const eloOnly = deriveCleanSheetStrengths(collapsed, names, snapshot);
    const eloLevel = (id: number) => Math.log(eloOnly[id].attack) + Math.log(eloOnly[id].defence);
    const spread = (f: (id: number) => number) => {
      const values = [1, 2, 3].map(f);
      const m = values.reduce((s, v) => s + v, 0) / values.length;
      return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
    };
    expect(spread(level)).toBeCloseTo(spread(eloLevel), 6);
  });
});
