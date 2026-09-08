import { describe, expect, it } from "vitest";
import {
  CLUB_ELO_HOME_FIELD_ADVANTAGE,
  CLUB_ELO_SNAPSHOT,
  CLUB_ELO_SOURCE,
  NEUTRAL_CLUB_ELO_FDR,
  calculateClubEloFdr,
  clubEloForFplShortName,
  unresolvedClubEloTeams,
  fixtureDifficultyFromClubElo,
  parseClubEloPage,
  type ClubEloSnapshot,
} from "@/lib/clubElo";
import { FplBootstrapSchema, FplPlayerSummarySchema } from "@/lib/fpl/schemas";
import {
  enrichBootstrapWithProjections,
  normalizeBootstrap,
  normalizeFixtures,
  normalizePlayer,
  normalizePlayerDetail,
} from "@/lib/fpl/normalize";

const rankingRows = [
  ["Arsenal", "ARS", "Arsenal", 2034],
  ...Array.from({ length: 19 }, (_, index) => {
    const number = index + 1;
    return [`Club ${number}`, `T${String(number).padStart(2, "0")}`, `Club${number}`, 1700 - number];
  }),
  ["Millwall", "MIL", "Millwall", 1647],
] as const;

const page = `
<h1><a href="/2026-09-06/ENG">England</a></h1>
<script>var vegaJson = ${JSON.stringify({
  datasets: {
    chart: [
      { Name: "Arsenal", TLC: "ARS", Elo: 2034.1982, FedURL: "ENG", Federation: "England" },
    ],
  },
})};</script>
<div class="accordion-header active"> <a href="ENG">England</a></div>
<div class="accordion-content active"><table>
${rankingRows.map(([name, tlc, slug, elo]) => `<tr><td class="l"><a href="/ENG"><img alt="ENG"></a> <a href="/${slug}"><span class="NonAst">${tlc}</span><span class="Ast">${name}</span></a></td><td class="r">${elo}</td></tr>`).join("\n")}
</table></div>
<div class="accordion-item"><div class="accordion-header"> <a href="GER">Germany</a></div></div>
`;

const SNAPSHOT: ClubEloSnapshot = {
  source: CLUB_ELO_SOURCE,
  fetchedAt: "2026-09-08T00:00:00.000Z",
  snapshotDate: "2026-09-06",
  homeFieldAdvantage: CLUB_ELO_HOME_FIELD_ADVANTAGE,
  clubs: [
    { name: "Brighton", tlc: "BRI", slug: "Brighton", elo: 1800 },
    { name: "Man United", tlc: "MNU", slug: "ManUnited", elo: 1800 },
    { name: "Forest", tlc: "FOR", slug: "Forest", elo: 1800 },
    { name: "Arsenal", tlc: "ARS", slug: "Arsenal", elo: 2000 },
    { name: "Chelsea", tlc: "CHE", slug: "Chelsea", elo: 1800 },
  ],
};

describe("ClubElo snapshot and FDR", () => {
  it("keeps exact vega values and adds rounded server ranking rows", () => {
    const snapshot = parseClubEloPage(page, {
      source: CLUB_ELO_SOURCE,
      fetchedAt: "2026-09-08T00:00:00.000Z",
    });

    expect(snapshot.clubs).toHaveLength(21);
    expect(snapshot.clubs.find((club) => club.tlc === "ARS")).toMatchObject({ elo: 2034.1982, slug: "Arsenal" });
    expect(snapshot.clubs.find((club) => club.tlc === "MIL")).toMatchObject({ elo: 1647, slug: "Millwall" });
    expect(snapshot.clubs.map((club) => club.tlc)).toEqual([...snapshot.clubs].sort((left, right) => left.tlc.localeCompare(right.tlc)).map((club) => club.tlc));
  });

  it("applies the venue-adjusted Elo formula, aliases, and neutral fallback", () => {
    expect(calculateClubEloFdr(1700, 1800, true)).toBe(3);
    expect(calculateClubEloFdr(1700, 1800, false)).toBe(4);
    expect(calculateClubEloFdr(2200, 1200, true)).toBe(1);
    expect(calculateClubEloFdr(1200, 2200, false)).toBe(5);
    expect(calculateClubEloFdr(undefined, 1800, true)).toBe(3);
    expect(calculateClubEloFdr(1800, undefined, true)).toBe(3);

    expect(clubEloForFplShortName("BHA", SNAPSHOT)?.tlc).toBe("BRI");
    expect(clubEloForFplShortName("MUN", SNAPSHOT)?.tlc).toBe("MNU");
    expect(clubEloForFplShortName("NFO", SNAPSHOT)?.tlc).toBe("FOR");
    expect(fixtureDifficultyFromClubElo("UNKNOWN", "CHE", true, SNAPSHOT)).toBe(3);
  });
});

const AMBIGUOUS: ClubEloSnapshot = {
  ...SNAPSHOT,
  clubs: [
    ...SNAPSHOT.clubs,
    { name: "Stoke", tlc: "STO", slug: "Stoke", elo: 1673 },
    { name: "Stockport", tlc: "STO", slug: "Stockport", elo: 1483 },
    { name: "Brighton & Hove Albion U21", tlc: "BRI", slug: "BrightonU21", elo: 1950 },
  ],
};

describe("ClubElo club identity", () => {
  it("refuses to guess when two clubs share a three-letter code", () => {
    expect(clubEloForFplShortName("STO", AMBIGUOUS)).toBeUndefined();
    expect(fixtureDifficultyFromClubElo("STO", "CHE", true, AMBIGUOUS)).toBe(NEUTRAL_CLUB_ELO_FDR);
  });

  it("names why a team cannot be resolved so the ingest guard can say so", () => {
    expect(unresolvedClubEloTeams(["ARS", "STO", "LUT", "BHA"], AMBIGUOUS)).toEqual([
      { shortName: "STO", reason: "ambiguous" },
      { shortName: "LUT", reason: "missing" },
    ]);
  });

  it("separates a mapping gone stale from a club that was never there", () => {
    const renamed: ClubEloSnapshot = {
      ...AMBIGUOUS,
      clubs: AMBIGUOUS.clubs.filter((club) => club.slug !== "Brighton"),
    };
    expect(unresolvedClubEloTeams(["BHA", "LUT"], renamed)).toEqual([
      { shortName: "BHA", reason: "stale-mapping" },
      { shortName: "LUT", reason: "missing" },
    ]);
  });

  it("resolves a mapped club by slug so a same-code club cannot displace it", () => {
    expect(clubEloForFplShortName("BHA", AMBIGUOUS)).toMatchObject({ slug: "Brighton", elo: 1800 });
  });

  it("keeps the ranking Elo when two exact rows share a code and neither matches by name", () => {
    const html = page.replace(
      '"chart":[{"Name":"Arsenal"',
      '"chart":[{"Name":"Millwall Reserves","TLC":"MIL","Elo":1900.5,"FedURL":"ENG","Federation":"England"},'
      + '{"Name":"Millwall Academy","TLC":"MIL","Elo":1500.25,"FedURL":"ENG","Federation":"England"},'
      + '{"Name":"Arsenal"',
    );
    const snapshot = parseClubEloPage(html, { fetchedAt: "2026-09-08T00:00:00.000Z" });
    expect(snapshot.clubs.find((club) => club.slug === "Millwall")?.elo).toBe(1647);
  });
});

describe("ClubElo snapshot freshness", () => {
  it("reports the snapshot date and age alongside the other projection inputs", async () => {
    const payload = FplBootstrapSchema.parse({
      events: [],
      teams: [{ id: 1, name: "Arsenal", short_name: "ARS" }],
      element_types: [{ id: 3, plural_name_short: "MID" }],
      elements: [{ id: 10, team: 1, element_type: 3, now_cost: 75 }],
    });
    const enriched = await enrichBootstrapWithProjections(normalizeBootstrap(payload), null);
    expect(enriched.metadata.clubElo).toMatchObject({
      fetchedAt: CLUB_ELO_SNAPSHOT.fetchedAt,
      snapshotDate: CLUB_ELO_SNAPSHOT.snapshotDate,
    });
    expect(enriched.metadata.clubElo?.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(enriched.metadata.clubElo?.ageSeconds)).toBe(true);
  });
});

describe("ClubElo snapshot injection", () => {
  // A gap wide enough that the committed snapshot (ARS 2034, CHE 1885 -> 2/4)
  // can never produce these values, so the assertions fail if the injected
  // snapshot is ignored.
  const INJECTED: ClubEloSnapshot = {
    ...SNAPSHOT,
    clubs: [
      { name: "Arsenal", tlc: "ARS", slug: "Arsenal", elo: 2200 },
      { name: "Chelsea", tlc: "CHE", slug: "Chelsea", elo: 1400 },
    ],
  };
  const teamMap = new Map([
    [1, { id: 1, name: "Arsenal", shortName: "ARS" }],
    [2, { id: 2, name: "Chelsea", shortName: "CHE" }],
  ]);

  it("rates fixtures from the given snapshot, ignoring FPL's supplied difficulty", () => {
    const payload = FplBootstrapSchema.parse({
      events: [],
      teams: [
        { id: 1, name: "Arsenal", short_name: "ARS" },
        { id: 2, name: "Chelsea", short_name: "CHE" },
      ],
      element_types: [],
      elements: [],
    });
    // ARS 2200 at home (+40) vs CHE 1400 -> 3 + (1400 - 2240) / 200 = -1.2 -> 1.
    // CHE 1400 away (-40) vs ARS 2200 -> 3 + (2200 - 1360) / 200 = 7.2 -> 5.
    const fixtures = normalizeFixtures(
      [{ id: 1, team_h: 1, team_a: 2, team_h_difficulty: 5, team_a_difficulty: 1 }],
      payload.teams,
      INJECTED,
    );
    expect(fixtures[0]).toMatchObject({ homeDifficulty: 1, awayDifficulty: 5 });
  });

  it("rates player detail fixtures from the given snapshot, ignoring FPL's difficulty", () => {
    const playerPayload = FplBootstrapSchema.parse({
      events: [],
      teams: [
        { id: 1, name: "Arsenal", short_name: "ARS" },
        { id: 2, name: "Chelsea", short_name: "CHE" },
      ],
      element_types: [{ id: 3, plural_name_short: "MID" }],
      elements: [{ id: 10, team: 1, element_type: 3, now_cost: 75 }],
    });
    const player = normalizePlayer(playerPayload.elements[0]!, teamMap);
    const summary = FplPlayerSummarySchema.parse({
      fixtures: [{ id: 2, team_h: 1, team_a: 2, event: 1, is_home: true, difficulty: 5 }],
      history: [],
      history_past: [],
    });
    expect(normalizePlayerDetail(player, summary, teamMap, INJECTED).fixtures[0]?.difficulty).toBe(1);
  });
});
