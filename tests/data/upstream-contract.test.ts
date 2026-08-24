import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FplClassicLeagueStandingsSchema,
  FplEntryHistorySchema,
  FplEntryPicksSchema,
  FplEntrySchema,
  FplFixturesSchema,
  FplLiveResponseSchema,
} from "@/lib/fpl/schemas";
import { normalizeManagerProfile, normalizeClassicLeagueStandings } from "@/lib/fpl/normalizeLeagues";
import { normalizeLiveGameweek } from "@/lib/fpl/normalize";

/**
 * Guards the upstream contract against real FPL responses. The payloads in
 * `tests/fixtures/upstream/` are captured with `npm run data:capture` and only
 * have their manager identities replaced; every field name, type and nesting
 * comes from the live API. Refresh them with the script, never by hand.
 */
function upstream(name: string): unknown {
  return JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/upstream", name), "utf8"));
}

describe("upstream FPL payload contract", () => {
  it("accepts the entry payload, whose league_type is a string and cup an object", () => {
    const parsed = FplEntrySchema.safeParse(upstream("entry.json"));
    expect(parsed.error?.issues[0]).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it("normalizes every classic league from a real entry payload", () => {
    const payload = FplEntrySchema.parse(upstream("entry.json"));
    const profile = normalizeManagerProfile(payload);
    expect(profile.leagues.classic.length).toBeGreaterThan(0);
    expect(profile.leagues.classic[0].name).toBeTruthy();
    expect(profile.leagues.cup).toEqual([]);
  });

  it("reads league size from rank_count", () => {
    const profile = normalizeManagerProfile(FplEntrySchema.parse(upstream("entry.json")));
    expect(profile.leagues.classic[0].size).toBeGreaterThan(0);
  });

  it("accepts the entry history payload", () => {
    expect(FplEntryHistorySchema.safeParse(upstream("entry-history.json")).success).toBe(true);
  });

  it("accepts the entry picks payload", () => {
    expect(FplEntryPicksSchema.safeParse(upstream("entry-picks.json")).success).toBe(true);
  });

  it("accepts the classic standings payload and keeps the official Gameweek total", () => {
    const parsed = FplClassicLeagueStandingsSchema.safeParse(upstream("league-standings.json"));
    expect(parsed.error?.issues[0]).toBeUndefined();
    expect(parsed.success).toBe(true);
    const standings = normalizeClassicLeagueStandings(
      FplClassicLeagueStandingsSchema.parse(upstream("league-standings.json")),
    );
    expect(standings.results[0].eventTotal).toBeGreaterThan(0);
  });

  it("accepts live stats that contain booleans and keeps the scored points", () => {
    const parsed = FplLiveResponseSchema.safeParse(upstream("live.json"));
    expect(parsed.error?.issues[0]).toBeUndefined();
    expect(parsed.success).toBe(true);
    const live = normalizeLiveGameweek(1, FplLiveResponseSchema.parse(upstream("live.json")));
    expect(live.elements[0].stats.total_points).toBeGreaterThan(0);
    expect(live.elements[0].stats.in_dreamteam).toBe(false);
  });

  it("accepts the fixtures payload", () => {
    expect(FplFixturesSchema.safeParse(upstream("fixtures.json")).success).toBe(true);
  });
});
