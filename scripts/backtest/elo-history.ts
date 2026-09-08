/**
 * Builds the two inputs the FDR arms need, for every prepared season.
 *
 *   fixture-difficulty.json  FPL's own 1-5 rating, from vaastav's fixtures.csv
 *   backtest-elo.json        a walk-forward Elo rating for both sides, pre-match
 *
 * ClubElo publishes dated ratings, but its history API returns 502 and
 * `clubelo.com/<date>/ENG` now redirects to the front page, so no historical
 * ClubElo values are obtainable. These ratings are computed here instead, from
 * the match results already in the corpus. That is a real scope limit: an arm
 * comparison run on them is a claim about the *transformation* applied to a
 * rating, not about ClubElo's numbers against FPL's. Both Elo arms read the
 * same ratings, so a difference between them is a difference of formula.
 *
 * Method, all conventional and none of it fitted to the outcome:
 *   expected = 1 / (1 + 10^-((own + homeAdvantage - opponent) / 400))
 *   K = 20, scaled by the World Football Elo goal-difference term
 *   homeAdvantage = 65 Elo points
 * Every club starts at 1500 in 2022/23; a club promoted later enters at the
 * mean rating of the clubs that went down, the usual promoted-equals-relegated
 * assumption. There is no between-season regression to the mean, matching
 * ClubElo. Fixtures update in kickoff order across the whole chain.
 *
 * The raw scale of a closed 20-team league is not ClubElo's, so the ratings are
 * finally rescaled to mean 1830 / sd 120 - the spread of the real England
 * snapshot in data/generated/club-elo.json. The transform is measured over the
 * burn-in seasons only and held fixed, so the evaluation season sees no leak.
 *
 *   npx tsx scripts/backtest/elo-history.ts [seasonsRoot]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { HistoricalMatchStat } from "@/lib/historical/types";
import { buildFixturesFromMatchRows } from "./multiSeasonData";

const SEASONS = ["2022-23", "2023-24", "2024-25", "2025-26"] as const;
/** Ratings from these seasons set the rescale; the rest are evaluated with it. */
const BURN_IN = new Set(["2022-23", "2023-24"]);
const ARCHIVE = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data";

const START_RATING = 1500;
const K = 20;
const HOME_ADVANTAGE = 65;
/** Matches the England snapshot the production code reads. */
const TARGET_MEAN = 1830;
const TARGET_SD = 120;

interface CsvFixture {
  id: number;
  kickoff: string;
  teamHome: number;
  teamAway: number;
  homeDifficulty: number;
  awayDifficulty: number;
}

/** fixtures.csv embeds a JSON-ish stats blob with commas and quotes in it. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') { cell += '"'; index += 1; } else quoted = false;
      } else cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") { cells.push(cell); cell = ""; }
    else cell += character;
  }
  cells.push(cell);
  return cells;
}

async function readSeasonCsv(season: string, cacheDir: string): Promise<CsvFixture[]> {
  const cached = path.join(cacheDir, `fixtures-${season}.csv`);
  let text: string;
  if (existsSync(cached)) text = readFileSync(cached, "utf8");
  else {
    const response = await fetch(`${ARCHIVE}/${season}/fixtures.csv`);
    if (!response.ok) throw new Error(`${season}: fixtures.csv returned HTTP ${response.status}`);
    text = await response.text();
    writeFileSync(cached, text, "utf8");
  }
  const lines = text.split("\n").filter((line) => line.trim().length);
  const header = splitCsvLine(lines[0]);
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`${season}: fixtures.csv has no ${name} column`);
    return index;
  };
  const [id, kickoff, teamH, teamA, dH, dA] = [
    column("id"), column("kickoff_time"), column("team_h"), column("team_a"),
    column("team_h_difficulty"), column("team_a_difficulty"),
  ];
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return {
      id: Number(cells[id]),
      kickoff: cells[kickoff],
      teamHome: Number(cells[teamH]),
      teamAway: Number(cells[teamA]),
      homeDifficulty: Number(cells[dH]),
      awayDifficulty: Number(cells[dA]),
    };
  }).filter((fixture) => Number.isFinite(fixture.id) && Number.isFinite(fixture.homeDifficulty));
}

/** World Football Elo: a two-goal win counts half again, and it grows from there. */
function goalDifferenceWeight(goalDifference: number): number {
  const margin = Math.abs(goalDifference);
  if (margin <= 1) return 1;
  if (margin === 2) return 1.5;
  return (11 + margin) / 8;
}

export interface EloFixtureRow {
  fixtureId: number;
  gameweek: number;
  homeElo: number;
  awayElo: number;
  /** Cross-sectional mean and spread of the 20 current ratings, pre-match. */
  leagueMeanElo: number;
  leagueSdElo: number;
}

interface SeasonInput {
  season: string;
  directory: string;
  fixtures: { fixtureId: number; gameweek: number; homeTeamId: number; awayTeamId: number; homeGoals: number; awayGoals: number }[];
  clubOf: Map<number, string>;
  csv: Map<number, CsvFixture>;
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
}

async function main(): Promise<void> {
  const root = process.argv[2]
    ?? process.env.BACKTEST_MULTI_DATA_DIR
    ?? path.join(tmpdir(), "fpl-backtest-seasons");
  const read = <T,>(directory: string, file: string): T =>
    JSON.parse(readFileSync(path.join(directory, file), "utf8")) as T;

  const inputs: SeasonInput[] = [];
  for (const season of SEASONS) {
    const directory = path.join(root, season);
    if (!existsSync(path.join(directory, "historical-match-stats.json"))) {
      console.log(`${season}: not prepared, skipped`);
      continue;
    }
    const rows = read<HistoricalMatchStat[]>(directory, "historical-match-stats.json");
    const teams = read<{ teamId: number; name: string }[]>(directory, "team-strength.json");
    const csv = await readSeasonCsv(season, root);
    inputs.push({
      season,
      directory,
      fixtures: buildFixturesFromMatchRows(rows),
      clubOf: new Map(teams.map((team) => [team.teamId, team.name])),
      csv: new Map(csv.map((fixture) => [fixture.id, fixture])),
    });
  }

  // One rating per club name, carried across season boundaries.
  const rating = new Map<string, number>();
  const raw = new Map<string, EloFixtureRow[]>();
  const burnInRatings: number[] = [];

  for (const input of inputs) {
    const clubs = [...new Set(input.clubOf.values())];
    const arriving = clubs.filter((club) => !rating.has(club));
    if (rating.size === 0) arriving.forEach((club) => rating.set(club, START_RATING));
    else if (arriving.length) {
      const leaving = [...rating.keys()].filter((club) => !clubs.includes(club));
      const entry = leaving.length ? mean(leaving.map((club) => rating.get(club)!)) : START_RATING;
      arriving.forEach((club) => rating.set(club, entry));
    }
    // Only clubs in this season's league count toward the cross-section.
    const current = () => clubs.map((club) => rating.get(club)!);

    const ordered = [...input.fixtures].sort((left, right) => {
      const a = input.csv.get(left.fixtureId)?.kickoff ?? "";
      const b = input.csv.get(right.fixtureId)?.kickoff ?? "";
      return a.localeCompare(b) || left.gameweek - right.gameweek;
    });

    const rowsOut: EloFixtureRow[] = [];
    for (const fixture of ordered) {
      const home = input.clubOf.get(fixture.homeTeamId);
      const away = input.clubOf.get(fixture.awayTeamId);
      if (!home || !away) continue;
      const homeElo = rating.get(home)!;
      const awayElo = rating.get(away)!;
      const pool = current();
      rowsOut.push({
        fixtureId: fixture.fixtureId,
        gameweek: fixture.gameweek,
        homeElo,
        awayElo,
        leagueMeanElo: mean(pool),
        leagueSdElo: standardDeviation(pool),
      });
      if (BURN_IN.has(input.season)) burnInRatings.push(homeElo, awayElo);

      const expected = 1 / (1 + 10 ** (-((homeElo + HOME_ADVANTAGE - awayElo) / 400)));
      const goalDifference = fixture.homeGoals - fixture.awayGoals;
      const result = goalDifference > 0 ? 1 : goalDifference < 0 ? 0 : 0.5;
      const change = K * goalDifferenceWeight(goalDifference) * (result - expected);
      rating.set(home, homeElo + change);
      rating.set(away, awayElo - change);
    }
    raw.set(input.season, rowsOut);
  }

  // Affine rescale onto ClubElo's observed spread, measured on burn-in only.
  const sourceMean = mean(burnInRatings);
  const sourceSd = standardDeviation(burnInRatings);
  const scale = TARGET_SD / sourceSd;
  const rescale = (value: number) => TARGET_MEAN + (value - sourceMean) * scale;
  console.log(`burn-in raw ratings: mean ${sourceMean.toFixed(1)}, sd ${sourceSd.toFixed(1)} -> scale x${scale.toFixed(3)}`);

  for (const input of inputs) {
    const rows = (raw.get(input.season) ?? []).map((row) => ({
      ...row,
      homeElo: rescale(row.homeElo),
      awayElo: rescale(row.awayElo),
      leagueMeanElo: rescale(row.leagueMeanElo),
      leagueSdElo: row.leagueSdElo * scale,
    }));
    writeFileSync(path.join(input.directory, "backtest-elo.json"), JSON.stringify(rows));

    const difficulty = [...input.csv.values()]
      .map((fixture) => ({
        fixtureId: fixture.id,
        homeDifficulty: fixture.homeDifficulty,
        awayDifficulty: fixture.awayDifficulty,
      }))
      .filter((row) => rows.some((elo) => elo.fixtureId === row.fixtureId));
    writeFileSync(path.join(input.directory, "fixture-difficulty.json"), JSON.stringify(difficulty));

    const opening = rows.filter((row) => row.gameweek <= 6);
    const spread = opening.length ? opening[0] : undefined;
    console.log(
      `${input.season}: ${rows.length} fixtures, ${difficulty.length} with FPL difficulty`
      + (spread ? `, opening league sd ${spread.leagueSdElo.toFixed(0)}` : ""),
    );
    const last = rows[rows.length - 1];
    if (last) {
      const all = rows.flatMap((row) => [row.homeElo, row.awayElo]);
      console.log(
        `   ratings seen: ${Math.min(...all).toFixed(0)} to ${Math.max(...all).toFixed(0)}`
        + `, closing league sd ${last.leagueSdElo.toFixed(0)}`,
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
