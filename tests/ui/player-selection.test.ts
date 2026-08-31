import { describe, expect, it } from "vitest";
import { normalizeBootstrap, parsePlayerSelection } from "@/components/terminal/TerminalApp";

describe("player selection payloads", () => {
  it("parses probabilities, rating, freshness, and evidence from the API shape", () => {
    expect(parsePlayerSelection({
      startProbability: 0.82,
      cameoProbability: 0.1,
      noAppearanceProbability: 0.08,
      expectedMinutes: 79,
      nailedRating: 5,
      confidence: "HIGH",
      updatedAt: "2026-08-20T18:00:00.000Z",
      evidence: [
        { source: "ROTOWIRE_XI", detail: "Named in predicted XI" },
        { source: "HISTORICAL_STARTS", detail: "Started 8 of last 10" },
      ],
    })).toEqual({
      startProbability: 0.82,
      cameoProbability: 0.1,
      noAppearanceProbability: 0.08,
      expectedMinutes: 79,
      nailedRating: 5,
      confidence: "HIGH",
      updatedAt: "2026-08-20T18:00:00.000Z",
      evidence: [
        { source: "ROTOWIRE_XI", detail: "Named in predicted XI" },
        { source: "HISTORICAL_STARTS", detail: "Started 8 of last 10" },
      ],
    });
  });

  it("keeps an absent or empty selection block explicitly unavailable", () => {
    expect(parsePlayerSelection(undefined)).toBeUndefined();
    expect(parsePlayerSelection({})).toBeUndefined();
  });

  it("preserves per-Gameweek projections used by transfer simulation", () => {
    const [player] = normalizeBootstrap({
      data: {
        players: [{
          id: 1,
          firstName: "Test",
          lastName: "Player",
          displayName: "Test Player",
          teamId: 1,
          teamName: "Test",
          teamShortName: "TST",
          position: "DEF",
          priceTenths: 50,
          current: { totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 0 },
          projection: {
            nextGW: 1,
            next3: 9,
            next5: 15,
            next10: 30,
            fixtures: [{
              gameweek: 2,
              expectedPoints: 4,
              expectedMinutes: 80,
              fixture: { gameweek: 2, opponentTeamId: 2, opponentShortName: "OPP", isHome: true },
            }],
          },
        }],
      },
    }).players;

    expect(player.projection.fixtures).toEqual([{
      gameweek: 2,
      expectedPoints: 4,
      expectedMinutes: 80,
      fixture: { gameweek: 2, opponentTeamId: 2, opponentShortName: "OPP", isHome: true, difficulty: undefined },
    }]);
  });
});
