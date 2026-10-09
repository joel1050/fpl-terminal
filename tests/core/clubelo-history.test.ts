import { describe, expect, it } from "vitest";
import {
  buildClubEloFixturePanel,
  clubEloFixture,
  clubEloRatingsBeforeDate,
  latestPriorClubEloRating,
  parseClubEloHistoryPage,
  readClubEloHistoryCache,
  validateClubEloHistoryCache,
  type ClubEloHistoryCache,
  type ClubEloHistoryTeam,
} from "@/scripts/backtest/clubelo-history";

function page(rows: unknown[], transforms: unknown[] = []): string {
  const spec = {
    datasets: { ratings: rows },
    vconcat: [{ mark: { type: "line", interpolate: "step-after" }, ...(transforms.length ? { transform: transforms } : {}) }],
  };
  return `<script>var vegaJson = ${JSON.stringify(spec)};</script>`;
}

function team(slug: string, points: ClubEloHistoryTeam["points"]): ClubEloHistoryTeam {
  return { slug, fetchedAt: "2026-10-08T00:00:00.000Z", points };
}

describe("historical ClubElo inputs", () => {
  it("parses raw date and rating events while recording chart metadata", () => {
    const parsed = parseClubEloHistoryPage(page([
      { Date: "2025-01-02T00:00:00", Elo: 1710.25, Golo: 1.02, segment_id: 0 },
      { Date: "2025-01-09T00:00:00", Elo: 1715.5, Golo: 1.04, segment_id: 0 },
    ]));
    expect(parsed.points).toEqual([
      { date: "2025-01-02", elo: 1710.25, segmentId: 0 },
      { date: "2025-01-09", elo: 1715.5, segmentId: 0 },
    ]);
    expect(parsed).toMatchObject({
      datasetFields: ["Date", "Elo", "Golo", "segment_id"],
      mark: "line",
      interpolation: "step-after",
      transforms: 0,
    });
  });

  it("rejects duplicate dates, transformed data, and a changed chart type", () => {
    expect(() => parseClubEloHistoryPage(page([
      { Date: "2025-01-02", Elo: 1700 },
      { Date: "2025-01-02T12:00:00", Elo: 1701 },
    ]))).toThrow(/duplicate rating date/);
    expect(() => parseClubEloHistoryPage(page(
      [{ Date: "2025-01-02", Elo: 1700 }], [{ calculate: "datum.Elo" }],
    ))).toThrow(/transforms its source rows/);
    const changedMark = `<script>var vegaJson = ${JSON.stringify({
      datasets: { ratings: [{ Date: "2025-01-02", Elo: 1700 }] }, vconcat: [{ mark: { type: "area" } }],
    })};</script>`;
    expect(() => parseClubEloHistoryPage(changedMark)).toThrow(/chart mark changed/);
  });

  it("excludes same-day post-match ratings at the cutoff", () => {
    const points = [
      { date: "2025-01-02", elo: 1700 },
      { date: "2025-01-10", elo: 1800 },
      { date: "2025-01-14", elo: 1810 },
    ];
    expect(latestPriorClubEloRating(points, "2025-01-14"))
      .toEqual({ date: "2025-01-10", elo: 1800, daysLag: 4 });
    expect(latestPriorClubEloRating(points, "2025-01-01")).toBeUndefined();
    expect(() => latestPriorClubEloRating([
      { date: "2025-01-10", elo: 1800 }, { date: "2025-01-02", elo: 1700 },
    ], "2025-01-14")).toThrow(/sorted and have unique dates/);
  });

  it("joins fixture ratings by club slug and rejects missing history or duplicate fixtures", () => {
    const teams = {
      Alpha: team("Alpha", [{ date: "2025-01-01", elo: 1700 }]),
      Beta: team("Beta", [{ date: "2025-01-02", elo: 1600 }]),
    } satisfies Record<string, ClubEloHistoryTeam>;
    const fixture = {
      season: "2024-25", fixtureId: 10, date: "2025-01-03", homeTeamId: 1, awayTeamId: 2,
      homeSlug: "Alpha", awaySlug: "Beta",
    };
    const panel = buildClubEloFixturePanel([fixture], teams);
    expect(panel.rows[0]).toMatchObject({ homeElo: 1700, awayElo: 1600, homeRatingDate: "2025-01-01", awayRatingDate: "2025-01-02" });
    expect(panel.lagDays).toEqual([2, 1]);
    expect(() => buildClubEloFixturePanel([fixture, fixture], teams)).toThrow(/duplicate prepared fixture/);
    expect(() => buildClubEloFixturePanel([fixture], { Alpha: teams.Alpha })).toThrow(/missing ClubElo history/);
  });

  it("uses one complete point-in-time rating map for all teams", () => {
    const teams = {
      Arsenal: team("Arsenal", [{ date: "2025-01-01", elo: 2000 }, { date: "2025-01-10", elo: 2010 }]),
      AstonVilla: team("AstonVilla", [{ date: "2025-01-02", elo: 1750 }]),
    };
    const cache = {
      source: "https://clubelo.com",
      fetchedAt: "2026-10-08T00:00:00.000Z",
      ratingPolicy: "strictly before the UK fixture date",
      chartEvidence: {
        datasetFields: ["Date", "Elo"], mark: "line", interpolation: "step-after", transforms: 0,
        sameDayPostMatchProbe: { slug: "Arsenal", date: "2025-01-10", chartElo: 2010, pageNewElo: 2010, roundedMatch: true },
      },
      historyWindow: { firstDate: "2025-01-01", lastDate: "2025-01-10" },
      teams,
      coverage: {
        clubs: 2, fixtures: 1, teamFixtures: 2, maxLagDays: 2, p95LagDays: 2, lagsOver30Days: 0,
        lagsOver60Days: 0, bySeason: {},
      },
      fixtures: [{
        season: "2024-25", fixtureId: 10, date: "2025-01-10", homeTeamId: 1, awayTeamId: 2,
        homeSlug: "Arsenal", awaySlug: "AstonVilla", homeElo: 2000, awayElo: 1750,
        homeRatingDate: "2025-01-01", awayRatingDate: "2025-01-02", homeLagDays: 9, awayLagDays: 8,
      }],
    } satisfies ClubEloHistoryCache;
    const valid = validateClubEloHistoryCache(cache);
    expect(clubEloFixture(valid, "2024-25", 10).homeElo).toBe(2000);
    expect(() => validateClubEloHistoryCache({
      ...cache,
      fixtures: [{ ...cache.fixtures[0], homeRatingDate: "2025-01-10" }],
    })).toThrow(/latest strictly prior raw/);
    expect(() => validateClubEloHistoryCache({ ...cache, source: "https://clubelo.com.evil" }))
      .toThrow(/metadata is invalid/);
    expect(clubEloRatingsBeforeDate(valid, [
      { teamId: 1, shortName: "ARS" }, { teamId: 2, shortName: "AVL" },
    ], "2025-01-10").asOf.map(({ elo, ratingDate }) => ({ elo, ratingDate }))).toEqual([
      { elo: 2000, ratingDate: "2025-01-01" },
      { elo: 1750, ratingDate: "2025-01-02" },
    ]);
    expect(() => clubEloRatingsBeforeDate(valid, [{ teamId: 9, shortName: "NOMATCH" }], "2025-01-10"))
      .toThrow(/no ClubElo identity/);
  });

  it("keeps the checked historical cache complete and its fixture panel aligned to raw history", () => {
    const cache = readClubEloHistoryCache();
    expect(cache.coverage).toMatchObject({ clubs: 25, fixtures: 1_140, teamFixtures: 2_280 });
    expect(Object.keys(cache.teams)).toHaveLength(25);
    expect(cache.fixtures).toHaveLength(1_140);
    expect(cache.fixtures.every((fixture) => fixture.homeRatingDate < fixture.date
      && fixture.awayRatingDate < fixture.date)).toBe(true);
  });
});
