import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ingestHistoricalData } from "@/lib/historical/ingest";
import type { HistoricalMatchStat, HistoricalPlayerRecord, HistoricalTeamStrength } from "@/lib/historical/types";
import {
  buildFixturesFromMatchRows,
  buildPlayerAnchors,
  buildPreviousSeasonTeamPriors,
} from "./multiSeasonData";

const ARCHIVE = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data";
const SEASONS = ["2022-23", "2023-24", "2024-25", "2025-26"] as const;

async function read<T>(directory: string, file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(directory, file), "utf8")) as T;
}

export async function prepareBacktestSeasons(
  outputRoot = process.env.BACKTEST_MULTI_DATA_DIR ?? path.join(tmpdir(), "fpl-backtest-seasons"),
): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  for (const season of SEASONS) {
    const outputDir = path.join(outputRoot, season);
    const summary = await ingestHistoricalData({
      outputDir,
      seasonPath: `${ARCHIVE}/${season}`,
      season: season.replace("-", "/"),
      includeCurrentMappings: false,
    });
    console.log(`${season}: ${summary.players} players, ${summary.matchStats} player-fixtures`);
  }

  for (let index = 1; index < SEASONS.length; index += 1) {
    const season = SEASONS[index];
    const anchorSeason = SEASONS[index - 1];
    const targetDir = path.join(outputRoot, season);
    const anchorDir = path.join(outputRoot, anchorSeason);
    const [targetPlayers, previousPlayers, targetTeams, previousTeams, previousRows] = await Promise.all([
      read<HistoricalPlayerRecord[]>(targetDir, "historical-players.json"),
      read<HistoricalPlayerRecord[]>(anchorDir, "historical-players.json"),
      read<HistoricalTeamStrength[]>(targetDir, "team-strength.json"),
      read<HistoricalTeamStrength[]>(anchorDir, "team-strength.json"),
      read<HistoricalMatchStat[]>(anchorDir, "historical-match-stats.json"),
    ]);
    const playerAnchors = buildPlayerAnchors(targetPlayers, previousPlayers);
    const previousFixtures = buildFixturesFromMatchRows(previousRows);
    const { priors, fallbackTeams } = buildPreviousSeasonTeamPriors(targetTeams, previousTeams, previousFixtures);
    await Promise.all([
      writeFile(path.join(targetDir, "previous-player-anchors.json"), JSON.stringify(playerAnchors)),
      writeFile(path.join(targetDir, "preseason-team-strength.json"), JSON.stringify(priors)),
      writeFile(path.join(targetDir, "backtest-season.json"), JSON.stringify({
        season,
        anchorSeason,
        playerAnchors: playerAnchors.length,
        previousFixtures: previousFixtures.length,
        fallbackTeams,
        priorMethod: "previous-season player totals and team xG; league-average fallback for clubs without a prior",
      }, null, 2)),
    ]);
    console.log(`${season}: ${playerAnchors.length} player anchors, ${20 - fallbackTeams.length}/20 returning-team priors`);
  }
  console.log(`Prepared leak-free backtest inputs in ${outputRoot}`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  prepareBacktestSeasons(process.argv[2]).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
