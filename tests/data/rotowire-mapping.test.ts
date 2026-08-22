import { describe, expect, it } from "vitest";
import type { Player } from "@/types/player";
import { mapRotowireLineups, normalizeRotowireName } from "@/lib/availability/rotowireMapping";
import type { RotowireLineupSnapshot } from "@/lib/availability/rotowire";

const player = (id: number, firstName: string, lastName: string, teamId = 1, teamName = "North London FC"): Player => ({
  id,
  firstName,
  lastName,
  displayName: `${firstName} ${lastName}`,
  teamId,
  teamName,
  teamShortName: "NLF",
  position: "MID",
  priceTenths: 50,
  ownership: 0,
  status: "a",
  current: { totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 0 },
  fixtures: [],
});

const snapshot = (name: string, rotowireId = 100, teamName = "North London FC"): RotowireLineupSnapshot => ({
  source: "https://www.rotowire.com/soccer/lineups.php",
  fetchedAt: "2026-08-20T12:00:00.000Z",
  dateRange: "test",
  fixtures: [{
    kickoff: "August 21 3:00 PM ET",
    home: {
      name: teamName,
      abbreviation: teamName === "North London FC" ? "NLF" : "UNK",
      side: "HOME",
      status: "PREDICTED",
      starters: [{ rotowireId, name, position: "M", profileUrl: "" }],
      unavailable: [],
    },
    away: {
      name: "South FC",
      abbreviation: "SOU",
      side: "AWAY",
      status: "PREDICTED",
      starters: [],
      unavailable: [],
    },
  }],
});

describe("RotoWire player mapping", () => {
  it("normalizes accents, punctuation, and Unicode name variants", () => {
    expect(normalizeRotowireName("Ødegaard’s João")) .toBe("odegaards joao");
  });

  it("uses a saved mapping before name matching and rejects a stale club mapping", () => {
    const players = [player(7, "Correct", "Name"), player(8, "Other", "Name", 2, "South FC")];
    const result = mapRotowireLineups(snapshot("Wrong Source Name"), players, { confirmedMappings: { 100: 7 } });
    expect(result.mapped[0]).toMatchObject({ rotowireId: 100, playerId: 7, method: "CONFIRMED_MAPPING" });

    const stale = mapRotowireLineups(snapshot("Correct Name"), players, { confirmedMappings: { 100: 8 } });
    expect(stale.mapped).toHaveLength(0);
    expect(stale.unresolved[0]).toMatchObject({ reason: "INVALID_CONFIRMED_MAPPING" });
  });

  it("requires a club constraint before accepting a name match", () => {
    const result = mapRotowireLineups(snapshot("Correct Name", 101, "Unmapped FC"), [player(7, "Correct", "Name")]);
    expect(result.mapped).toHaveLength(0);
    expect(result.unresolved[0]).toMatchObject({ reason: "NO_CLUB_MAPPING" });
  });

  it("accepts unique exact and safe fallback matches, but leaves collisions ambiguous", () => {
    const exact = mapRotowireLineups(snapshot("Córrect Name"), [player(7, "Correct", "Name")]);
    expect(exact.mapped[0]).toMatchObject({ playerId: 7, method: "EXACT_NAME" });

    const fallback = mapRotowireLineups(snapshot("Name", 101), [player(7, "Correct", "Name")]);
    expect(fallback.mapped[0]).toMatchObject({ playerId: 7, method: "UNIQUE_FALLBACK" });

    const ambiguous = mapRotowireLineups(snapshot("Name", 102), [player(7, "Correct", "Name"), player(8, "Other", "Name")]);
    expect(ambiguous.mapped).toHaveLength(0);
    expect(ambiguous.unresolved[0]).toMatchObject({ reason: "AMBIGUOUS" });
    expect(ambiguous.ambiguous).toHaveLength(1);
    expect(ambiguous.ambiguous[0].candidates.map((candidate) => candidate.playerId)).toEqual([7, 8]);
  });
});
