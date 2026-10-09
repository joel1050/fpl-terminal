import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ARCHIVE = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data";

/** One Vaastav `fixtures.csv` row, narrowed to fields used by backtests. */
export interface CsvFixture {
  id: number;
  kickoff: string;
  teamHome: number;
  teamAway: number;
  homeDifficulty: number;
  awayDifficulty: number;
}

/** The stats blob in fixtures.csv contains quoted commas, so split it as CSV. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') { cell += '"'; index += 1; } else quoted = false;
      } else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { cells.push(cell); cell = ""; }
    else cell += character;
  }
  if (quoted) throw new Error("Vaastav fixture CSV has an unterminated quoted field.");
  cells.push(cell);
  return cells;
}

/** Reads one season's fixtures.csv, caching it under the prepared backtest root. */
export async function readSeasonCsv(season: string, cacheDir: string): Promise<CsvFixture[]> {
  const cached = path.join(cacheDir, `fixtures-${season}.csv`);
  let text: string;
  try {
    text = readFileSync(cached, "utf8");
  } catch {
    const response = await fetch(`${ARCHIVE}/${season}/fixtures.csv`, {
      headers: { Accept: "text/csv" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`${season}: fixtures.csv returned HTTP ${response.status}`);
    text = await response.text();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, text, "utf8");
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error(`${season}: fixtures.csv is empty.`);
  const header = splitCsvLine(lines[0]);
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`${season}: fixtures.csv has no ${name} column`);
    return index;
  };
  const [id, kickoff, teamH, teamA, difficultyH, difficultyA] = [
    column("id"), column("kickoff_time"), column("team_h"), column("team_a"),
    column("team_h_difficulty"), column("team_a_difficulty"),
  ];
  const fixtures = lines.slice(1).map((line, rowIndex): CsvFixture => {
    const cells = splitCsvLine(line);
    const fixture = {
      id: Number(cells[id]),
      kickoff: cells[kickoff],
      teamHome: Number(cells[teamH]),
      teamAway: Number(cells[teamA]),
      homeDifficulty: Number(cells[difficultyH]),
      awayDifficulty: Number(cells[difficultyA]),
    };
    if (!Number.isInteger(fixture.id) || !Number.isFinite(Date.parse(fixture.kickoff))
      || !Number.isInteger(fixture.teamHome) || !Number.isInteger(fixture.teamAway)
      || fixture.teamHome === fixture.teamAway
      || !Number.isFinite(fixture.homeDifficulty) || !Number.isFinite(fixture.awayDifficulty)) {
      throw new Error(`${season}: fixtures.csv row ${rowIndex + 2} is malformed.`);
    }
    return fixture;
  });
  const ids = new Set<number>();
  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) throw new Error(`${season}: fixtures.csv repeats fixture ${fixture.id}.`);
    ids.add(fixture.id);
  }
  return fixtures;
}
