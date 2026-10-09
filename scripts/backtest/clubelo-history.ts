/**
 * Fetches dated ClubElo event history and joins it to prepared Vaastav fixtures.
 * Ratings are event-day post-match values, so a fixture can only use an event
 * dated strictly before its UK kickoff date.
 *
 *   npm run backtest:prepare
 *   npx tsx scripts/backtest/clubelo-history.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HistoricalMatchStat, HistoricalTeamStrength } from "@/lib/historical/types";
import { clubEloForFplShortName, CLUB_ELO_SNAPSHOT } from "@/lib/clubElo";
import { buildFixturesFromMatchRows } from "./multiSeasonData";
import { readSeasonCsv } from "./vaastavFixtures";

const SOURCE = "https://clubelo.com";
const SEASONS = ["2023-24", "2024-25", "2025-26"] as const;
const PREPARED_ROOT = process.env.BACKTEST_MULTI_DATA_DIR ?? path.join(tmpdir(), "fpl-backtest-seasons");
const OUTPUT = path.resolve("scripts/backtest/results/clubelo-history.json");
const REQUEST_TIMEOUT_MS = 20_000;
const FETCH_CONCURRENCY = 4;

export interface ClubEloHistoryPoint {
  /** ClubElo's date for this rating event, without a time component. */
  date: string;
  /** Raw event rating. On the event date this is the post-match value. */
  elo: number;
  segmentId?: string | number;
}

export interface ClubEloHistoryTeam {
  slug: string;
  fetchedAt: string;
  points: ClubEloHistoryPoint[];
}

export interface ClubEloFixtureRating {
  season: string;
  fixtureId: number;
  date: string;
  homeTeamId?: number;
  awayTeamId?: number;
  homeSlug: string;
  awaySlug: string;
  homeElo: number;
  awayElo: number;
  homeRatingDate: string;
  awayRatingDate: string;
  homeLagDays: number;
  awayLagDays: number;
}

export interface ClubEloHistoryCache {
  source: string;
  fetchedAt: string;
  ratingPolicy: string;
  chartEvidence: {
    datasetFields: string[];
    mark: string;
    interpolation: string | null;
    transforms: number;
    sameDayPostMatchProbe: {
      slug: string;
      date: string;
      chartElo: number;
      pageNewElo: number;
      roundedMatch: boolean;
    };
  };
  historyWindow: { firstDate: string; lastDate: string };
  teams: Record<string, ClubEloHistoryTeam>;
  coverage: {
    clubs: number;
    fixtures: number;
    teamFixtures: number;
    maxLagDays: number;
    p95LagDays: number;
    lagsOver30Days: number;
    lagsOver60Days: number;
    bySeason: Record<string, { fixtures: number; teamFixtures: number; maxLagDays: number; lagsOver30Days: number }>;
  };
  fixtures: ClubEloFixtureRating[];
}

export interface ParsedClubEloHistoryPage {
  points: ClubEloHistoryPoint[];
  datasetFields: string[];
  mark: string;
  interpolation: string | null;
  transforms: number;
  pageNewEloByDate: Map<string, number>;
}

export interface PreparedClubEloFixture {
  season: string;
  fixtureId: number;
  date: string;
  homeTeamId: number;
  awayTeamId: number;
  homeSlug: string;
  awaySlug: string;
}

function dayNumber(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`invalid ISO date: ${date}`);
  }
  const timestamp = new Date(`${date}T00:00:00Z`);
  if (timestamp.toISOString().slice(0, 10) !== date) throw new Error(`invalid calendar date: ${date}`);
  return timestamp.getTime() / 86_400_000;
}

function dateFromChart(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = value.slice(0, 10);
  try { dayNumber(date); return date; } catch { return undefined; }
}

function dateInLondon(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`invalid fixture kickoff: ${isoTimestamp}`);
  const values = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) => values.find((value) => value.type === type)?.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  dayNumber(date);
  return date;
}

function extractEmbeddedVega(html: string): Record<string, unknown> {
  const marker = /\bvar\s+vegaJson\s*=/.exec(html);
  if (!marker || marker.index === undefined) throw new Error("ClubElo page has no embedded vegaJson history chart.");
  const start = html.indexOf("{", marker.index + marker[0].length);
  if (start < 0) throw new Error("ClubElo vegaJson is missing its opening object.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) { end = index; break; }
    }
  }
  if (end < 0) throw new Error("ClubElo vegaJson object is truncated.");
  let parsed: unknown;
  try { parsed = JSON.parse(html.slice(start, end + 1)) as unknown; }
  catch (error) {
    throw new Error(`ClubElo vegaJson is malformed: ${error instanceof Error ? error.message : "unknown parse error"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ClubElo vegaJson is not an object.");
  return parsed as Record<string, unknown>;
}

function visitRows(value: unknown, rows: Record<string, unknown>[], fields: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const candidate = entry as Record<string, unknown>;
        if ("Date" in candidate && "Elo" in candidate) {
          rows.push(candidate);
          Object.keys(candidate).forEach((key) => fields.add(key));
        }
      }
      visitRows(entry, rows, fields);
    }
  } else if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) visitRows(nested, rows, fields);
  }
}

function countTransforms(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, entry) => sum + countTransforms(entry), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const own = Array.isArray(record.transform) ? record.transform.length : 0;
  return own + Object.values(record).reduce<number>((sum, entry) => sum + countTransforms(entry), 0);
}

function chartPresentation(value: unknown): { mark: string; interpolation: string | null } {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = chartPresentation(entry);
      if (found.mark !== "unknown") return found;
    }
    return { mark: "unknown", interpolation: null };
  }
  if (!value || typeof value !== "object") return { mark: "unknown", interpolation: null };
  const record = value as Record<string, unknown>;
  if (record.mark && typeof record.mark === "object") {
    const mark = record.mark as Record<string, unknown>;
    return { mark: typeof mark.type === "string" ? mark.type : "unknown", interpolation: typeof mark.interpolate === "string" ? mark.interpolate : null };
  }
  for (const nested of Object.values(record)) {
    const found = chartPresentation(nested);
    if (found.mark !== "unknown") return found;
  }
  return { mark: "unknown", interpolation: null };
}

function htmlText(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

function postMatchEloByDate(html: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = match[1];
    const date = row.match(/href=["']\/(\d{4}-\d{2}-\d{2})["']/i)?.[1];
    if (!date) continue;
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => htmlText(cell[1]));
    const value = cells.length >= 2 ? Number(cells[cells.length - 2].replace(/,/g, "")) : Number.NaN;
    if (Number.isFinite(value)) result.set(date, value);
  }
  return result;
}

/** Reads the raw dated event values embedded in ClubElo's public club page. */
export function parseClubEloHistoryPage(html: string): ParsedClubEloHistoryPage {
  const spec = extractEmbeddedVega(html);
  const rows: Record<string, unknown>[] = [];
  const fields = new Set<string>();
  visitRows(spec.datasets, rows, fields);
  if (!rows.length) throw new Error("ClubElo chart contains no Date/Elo event rows.");
  const points = rows.map((row): ClubEloHistoryPoint => {
    const date = dateFromChart(row.Date);
    const elo = row.Elo;
    if (!date || typeof elo !== "number" || !Number.isFinite(elo) || elo < 700 || elo > 2500) {
      throw new Error(`ClubElo chart contains an invalid rating row: ${JSON.stringify(row)}`);
    }
    return typeof row.segment_id === "string" || typeof row.segment_id === "number"
      ? { date, elo, segmentId: row.segment_id }
      : { date, elo };
  }).sort((left, right) => left.date.localeCompare(right.date));
  const dates = new Set<string>();
  for (const point of points) {
    if (dates.has(point.date)) throw new Error(`ClubElo chart has duplicate rating date ${point.date}.`);
    dates.add(point.date);
  }
  const transforms = countTransforms(spec);
  if (transforms !== 0) throw new Error(`ClubElo chart transforms its source rows (${transforms} transforms); raw history is required.`);
  const presentation = chartPresentation(spec.vconcat);
  if (presentation.mark !== "line") throw new Error(`ClubElo Elo history chart mark changed to ${presentation.mark}.`);
  return { points, datasetFields: [...fields].sort(), ...presentation, transforms, pageNewEloByDate: postMatchEloByDate(html) };
}

/** Selects the latest event strictly before the fixture's UK kickoff date. */
export function latestPriorClubEloRating(
  points: readonly ClubEloHistoryPoint[],
  targetDate: string,
): { date: string; elo: number; daysLag: number } | undefined {
  const targetDay = dayNumber(targetDate);
  let selected: ClubEloHistoryPoint | undefined;
  let previous = "";
  for (const point of points) {
    dayNumber(point.date);
    if (point.date <= previous) throw new Error("ClubElo history points must be sorted and have unique dates.");
    if (!Number.isFinite(point.elo) || point.elo < 700 || point.elo > 2500) throw new Error("ClubElo history has an invalid rating.");
    previous = point.date;
    if (point.date < targetDate) selected = point;
  }
  return selected ? { ...selected, daysLag: targetDay - dayNumber(selected.date) } : undefined;
}

/** Uses the current snapshot only to map stable FPL team codes to ClubElo page slugs. */
function slugForShortName(shortName: string, season: string): string {
  const club = clubEloForFplShortName(shortName, CLUB_ELO_SNAPSHOT);
  if (!club) throw new Error(`${season}: no ClubElo club identity for FPL team ${shortName}.`);
  return club.slug;
}

/** Builds dated fixture identities from prepared Vaastav stats plus its fixtures.csv. */
export async function loadPreparedClubEloFixtures(season: string): Promise<PreparedClubEloFixture[]> {
  const directory = path.join(PREPARED_ROOT, season);
  const read = <T,>(file: string): T => {
    try { return JSON.parse(readFileSync(path.join(directory, file), "utf8")) as T; }
    catch { throw new Error(`${path.join(directory, file)} is missing; run npm run backtest:prepare.`); }
  };
  const rows = read<HistoricalMatchStat[]>("historical-match-stats.json");
  const teams = read<HistoricalTeamStrength[]>("team-strength.json");
  const slugByTeamId = new Map(teams.map((team) => [team.teamId, slugForShortName(team.shortName, season)]));
  const csvFixtures = new Map((await readSeasonCsv(season, PREPARED_ROOT)).map((fixture) => [fixture.id, fixture]));
  const fixtures = buildFixturesFromMatchRows(rows).map((fixture): PreparedClubEloFixture => {
    const csv = csvFixtures.get(fixture.fixtureId);
    const homeSlug = slugByTeamId.get(fixture.homeTeamId);
    const awaySlug = slugByTeamId.get(fixture.awayTeamId);
    if (!csv || !homeSlug || !awaySlug) throw new Error(`${season}: fixture ${fixture.fixtureId} has no kickoff or ClubElo club identity.`);
    if (csv.teamHome !== fixture.homeTeamId || csv.teamAway !== fixture.awayTeamId) {
      throw new Error(`${season}: fixture ${fixture.fixtureId} disagrees between player stats and fixtures.csv.`);
    }
    return {
      season,
      fixtureId: fixture.fixtureId,
      date: dateInLondon(csv.kickoff),
      homeTeamId: fixture.homeTeamId,
      awayTeamId: fixture.awayTeamId,
      homeSlug,
      awaySlug,
    };
  });
  const ids = new Set(fixtures.map((fixture) => fixture.fixtureId));
  if (ids.size !== 380) throw new Error(`${season}: expected 380 prepared fixtures, found ${ids.size}.`);
  return fixtures;
}

export function buildClubEloFixturePanel(
  fixtures: readonly PreparedClubEloFixture[],
  teams: Readonly<Record<string, ClubEloHistoryTeam>>,
): { rows: ClubEloFixtureRating[]; lagDays: number[] } {
  const seen = new Set<string>();
  const lagDays: number[] = [];
  const rows = fixtures.map((fixture): ClubEloFixtureRating => {
    const key = `${fixture.season}|${fixture.fixtureId}`;
    if (seen.has(key)) throw new Error(`duplicate prepared fixture ${key}`);
    seen.add(key);
    const home = teams[fixture.homeSlug];
    const away = teams[fixture.awaySlug];
    if (!home || !away) throw new Error(`${key}: missing ClubElo history for ${fixture.homeSlug} or ${fixture.awaySlug}.`);
    const homeRating = latestPriorClubEloRating(home.points, fixture.date);
    const awayRating = latestPriorClubEloRating(away.points, fixture.date);
    if (!homeRating || !awayRating) throw new Error(`${key}: no ClubElo rating strictly before ${fixture.date}.`);
    lagDays.push(homeRating.daysLag, awayRating.daysLag);
    return {
      ...fixture,
      homeElo: homeRating.elo,
      awayElo: awayRating.elo,
      homeRatingDate: homeRating.date,
      awayRatingDate: awayRating.date,
      homeLagDays: homeRating.daysLag,
      awayLagDays: awayRating.daysLag,
    };
  });
  return { rows, lagDays };
}

/** Returns a validated fixture panel row for use by rating-map consumers. */
export function clubEloFixture(
  cache: ClubEloHistoryCache,
  season: string,
  fixtureId: number,
): ClubEloFixtureRating {
  const matches = cache.fixtures.filter((fixture) => fixture.season === season && fixture.fixtureId === fixtureId);
  if (matches.length !== 1) throw new Error(`${season} fixture ${fixtureId} has ${matches.length} ClubElo history rows.`);
  const [fixture] = matches;
  if (fixture.homeRatingDate >= fixture.date || fixture.awayRatingDate >= fixture.date) {
    throw new Error(`${season} fixture ${fixtureId} includes a same-day or future ClubElo rating.`);
  }
  return fixture;
}

/** Resolves every prepared club to its latest dated ClubElo event before a cutoff. */
export function clubEloRatingsBeforeDate(
  cache: ClubEloHistoryCache,
  teams: readonly { teamId: number; shortName: string }[],
  cutoffDate: string,
): { ratings: Map<number, number>; asOf: Array<{ teamId: number; shortName: string; slug: string; elo: number; ratingDate: string; lagDays: number }> } {
  dayNumber(cutoffDate);
  const ratings = new Map<number, number>();
  const asOf = teams.map((team) => {
    const identity = clubEloForFplShortName(team.shortName, CLUB_ELO_SNAPSHOT);
    if (!identity) throw new Error(`no ClubElo identity for FPL team ${team.shortName}.`);
    const history = cache.teams[identity.slug];
    if (!history) throw new Error(`ClubElo history cache has no club ${identity.slug} (${team.shortName}).`);
    const prior = latestPriorClubEloRating(history.points, cutoffDate);
    if (!prior) throw new Error(`ClubElo history has no ${team.shortName} rating strictly before ${cutoffDate}.`);
    if (ratings.has(team.teamId)) throw new Error(`prepared teams repeat team id ${team.teamId}.`);
    ratings.set(team.teamId, prior.elo);
    return { teamId: team.teamId, shortName: team.shortName, slug: identity.slug, elo: prior.elo, ratingDate: prior.date, lagDays: prior.daysLag };
  });
  return { ratings, asOf };
}

export function validateClubEloHistoryCache(value: unknown): ClubEloHistoryCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ClubElo history cache is not an object.");
  const cache = value as ClubEloHistoryCache;
  if (cache.source !== SOURCE
    || !Number.isFinite(Date.parse(cache.fetchedAt)) || !cache.teams || !Array.isArray(cache.fixtures)) {
    throw new Error("ClubElo history cache metadata is invalid.");
  }
  for (const [slug, team] of Object.entries(cache.teams)) {
    if (team.slug !== slug || !Number.isFinite(Date.parse(team.fetchedAt)) || !Array.isArray(team.points)) {
      throw new Error(`ClubElo history team metadata is invalid for ${slug}.`);
    }
    latestPriorClubEloRating(team.points, "9999-12-31");
  }
  const keys = new Set<string>();
  for (const fixture of cache.fixtures) {
    const key = `${fixture.season}|${fixture.fixtureId}`;
    if (keys.has(key)) throw new Error(`ClubElo history cache repeats fixture ${key}.`);
    keys.add(key);
    dayNumber(fixture.date);
    if (!Number.isInteger(fixture.fixtureId)
      || (fixture.homeTeamId !== undefined && !Number.isInteger(fixture.homeTeamId))
      || (fixture.awayTeamId !== undefined && !Number.isInteger(fixture.awayTeamId))
      || (fixture.homeTeamId !== undefined && fixture.homeTeamId === fixture.awayTeamId)
      || !Number.isInteger(fixture.homeLagDays) || !Number.isInteger(fixture.awayLagDays)
      || !Number.isFinite(fixture.homeElo) || !Number.isFinite(fixture.awayElo)) {
      throw new Error(`${key}: ClubElo fixture panel fields are invalid.`);
    }
    const home = cache.teams[fixture.homeSlug];
    const away = cache.teams[fixture.awaySlug];
    const expectedHome = home && latestPriorClubEloRating(home.points, fixture.date);
    const expectedAway = away && latestPriorClubEloRating(away.points, fixture.date);
    if (!expectedHome || !expectedAway
      || expectedHome.elo !== fixture.homeElo || expectedAway.elo !== fixture.awayElo
      || expectedHome.date !== fixture.homeRatingDate || expectedAway.date !== fixture.awayRatingDate
      || expectedHome.daysLag !== fixture.homeLagDays || expectedAway.daysLag !== fixture.awayLagDays) {
      throw new Error(`${key}: fixture panel does not match the latest strictly prior raw ClubElo history.`);
    }
  }
  return cache;
}

export function readClubEloHistoryCache(file = OUTPUT): ClubEloHistoryCache {
  return validateClubEloHistoryCache(JSON.parse(readFileSync(file, "utf8")) as unknown);
}

async function fetchClubHistory(slug: string): Promise<{ fetchedAt: string; parsed: ParsedClubEloHistoryPage }> {
  const url = `${SOURCE}/${encodeURIComponent(slug)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`ClubElo history ${slug}: HTTP ${response.status}.`);
  if (response.url !== url) throw new Error(`ClubElo history ${slug} redirected to ${response.url}.`);
  const html = await response.text();
  return { fetchedAt: new Date().toISOString(), parsed: parseClubEloHistoryPage(html) };
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function main(): Promise<void> {
  const fixtures = (await Promise.all(SEASONS.map(loadPreparedClubEloFixtures))).flat();
  if (fixtures.length !== SEASONS.length * 380) throw new Error(`expected ${SEASONS.length * 380} fixtures, found ${fixtures.length}.`);
  const slugs = [...new Set(fixtures.flatMap((fixture) => [fixture.homeSlug, fixture.awaySlug]))].sort();
  const fetched = await mapConcurrent(slugs, FETCH_CONCURRENCY, async (slug) => {
    console.log(`fetching ClubElo history: ${slug}`);
    return { slug, ...(await fetchClubHistory(slug)) };
  });
  const teams = Object.fromEntries(fetched.map(({ slug, fetchedAt, parsed }) => [slug, { slug, fetchedAt, points: parsed.points }]));
  const panel = buildClubEloFixturePanel(fixtures, teams);
  const allPoints = fetched.flatMap((team) => team.parsed.points);
  const dates = allPoints.map((point) => point.date).sort();
  const firstDate = dates[0];
  const lastDate = dates.at(-1);
  if (!firstDate || !lastDate) throw new Error("ClubElo history cache has no dated events.");

  const probeTeam = fetched.find((team) => team.slug === "Arsenal");
  const probe = probeTeam?.parsed.points.find((point) => probeTeam.parsed.pageNewEloByDate.has(point.date));
  if (!probeTeam || !probe) throw new Error("could not cross-check an Arsenal chart event against its New Elo column.");
  const pageNewElo = probeTeam.parsed.pageNewEloByDate.get(probe.date)!;
  const roundedMatch = Math.round(probe.elo) === Math.round(pageNewElo);
  if (!roundedMatch) throw new Error(`Arsenal same-day event ${probe.date} does not match the page's New Elo column.`);

  const bySeason = Object.fromEntries(SEASONS.map((season) => {
    const rows = panel.rows.filter((row) => row.season === season);
    const lags = rows.flatMap((row) => [row.homeLagDays, row.awayLagDays]);
    return [season, { fixtures: rows.length, teamFixtures: lags.length, maxLagDays: Math.max(...lags), lagsOver30Days: lags.filter((lag) => lag > 30).length }];
  }));
  const cache: ClubEloHistoryCache = validateClubEloHistoryCache({
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    ratingPolicy: "Use the latest ClubElo chart event strictly before the fixture's UK kickoff date; same-day chart values are post-match.",
    chartEvidence: {
      datasetFields: [...new Set(fetched.flatMap((team) => team.parsed.datasetFields))].sort(),
      mark: probeTeam.parsed.mark,
      interpolation: probeTeam.parsed.interpolation,
      transforms: Math.max(...fetched.map((team) => team.parsed.transforms)),
      sameDayPostMatchProbe: { slug: "Arsenal", date: probe.date, chartElo: probe.elo, pageNewElo, roundedMatch },
    },
    historyWindow: { firstDate, lastDate },
    teams,
    fixtures: panel.rows,
    coverage: {
      clubs: slugs.length,
      fixtures: panel.rows.length,
      teamFixtures: panel.lagDays.length,
      maxLagDays: Math.max(...panel.lagDays),
      p95LagDays: percentile95(panel.lagDays),
      lagsOver30Days: panel.lagDays.filter((lag) => lag > 30).length,
      lagsOver60Days: panel.lagDays.filter((lag) => lag > 60).length,
      bySeason,
    },
  });

  mkdirSync(path.dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(cache, null, 2)}\n`);
  console.log(`ClubElo history: ${cache.coverage.clubs} clubs, ${cache.coverage.fixtures} fixtures, ${cache.coverage.teamFixtures} as-of ratings.`);
  console.log(`Same-day check: Arsenal ${probe.date} chart ${probe.elo.toFixed(3)} vs page New Elo ${pageNewElo.toFixed(0)}.`);
  console.log(`Wrote ${OUTPUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
