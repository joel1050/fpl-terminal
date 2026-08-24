/**
 * Captures small, real FPL responses into `tests/fixtures/upstream/` so the
 * schema contract is checked against the shapes FPL actually sends.
 *
 * These files are committed, so names that identify a person or a private
 * league are replaced: manager and team names, league names, region, join date
 * and club badge links. Everything else — field names, types, nesting, ranks,
 * scores, picks — is kept exactly as FPL sent it, because that is the point.
 *
 * Run it by hand when the season turns over or a schema changes:
 *
 *   npm run data:capture -- --entry 1654208 --league 342328 --gameweek 1
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.FPL_API_BASE_URL ?? "https://fantasy.premierleague.com/api";
const OUTPUT = path.join(process.cwd(), "tests", "fixtures", "upstream");

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function get<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${BASE}/${endpoint}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`FPL returned HTTP ${response.status} for ${endpoint}`);
  return (await response.json()) as T;
}

async function save(name: string, data: unknown): Promise<void> {
  await writeFile(path.join(OUTPUT, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`wrote ${name}`);
}

async function main(): Promise<void> {
  const entryId = argument("entry", "1654208");
  const leagueId = argument("league", "342328");
  const gameweek = argument("gameweek", "1");
  await mkdir(OUTPUT, { recursive: true });

  const entry = await get<Record<string, unknown>>(`entry/${entryId}/`);
  const leagues = entry.leagues as { classic: Array<Record<string, unknown>> };
  await save("entry.json", {
    ...entry,
    id: 4827193,
    name: "Expected Toulouse",
    player_first_name: "Sam",
    player_last_name: "Tester",
    player_region_id: 241,
    player_region_name: "England",
    player_region_iso_code_short: "EN",
    player_region_iso_code_long: "ENG",
    joined_time: "2026-07-23T12:00:00.000000Z",
    club_badge_src: null,
    leagues: {
      ...leagues,
      classic: leagues.classic.slice(0, 3).map((league, index) => ({
        ...league,
        name: `League ${index + 1}`,
        short_name: `league-${index + 1}`,
      })),
    },
  });

  const history = await get<{ past: unknown[] }>(`entry/${entryId}/history/`);
  await save("entry-history.json", { ...history, past: history.past.slice(0, 2) });

  await save("entry-picks.json", await get(`entry/${entryId}/event/${gameweek}/picks/`));

  const standings = await get<{
    league: Record<string, unknown>;
    standings: { results: Array<Record<string, unknown>> };
    new_entries?: { results: unknown[] };
  }>(`leagues-classic/${leagueId}/standings/?page_standings=1`);
  await save("league-standings.json", {
    ...standings,
    league: { ...standings.league, name: "Sample League" },
    standings: {
      ...standings.standings,
      results: standings.standings.results.slice(0, 4).map((row, index) => ({
        ...row,
        entry: index === 0 ? 4827193 : 1001 + index,
        entry_name: `Team ${index + 1}`,
        player_name: `Manager ${index + 1}`,
        club_badge_src: null,
      })),
    },
    new_entries: { ...standings.new_entries, results: [] },
  });

  const live = await get<{ elements: Array<{ stats: Record<string, number> }> }>(`event/${gameweek}/live/`);
  const scoring = live.elements.filter((element) => (element.stats.total_points ?? 0) > 0).slice(0, 3);
  const blank = live.elements.filter((element) => (element.stats.minutes ?? 0) === 0).slice(0, 1);
  await save("live.json", { elements: [...scoring, ...blank] });

  const fixtures = await get<unknown[]>(`fixtures/?event=${gameweek}`);
  await save("fixtures.json", fixtures.slice(0, 3));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
