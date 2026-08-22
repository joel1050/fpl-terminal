import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildCurrentMatchStats } from "@/lib/availability/currentMatchStats";
import { FplBootstrapSchema, FplLiveResponseSchema, parseExternal } from "@/lib/fpl/schemas";
import { normalizeLiveGameweek } from "@/lib/fpl/normalize";

const generated = path.join(process.cwd(), "data", "generated");
const api = "https://fantasy.premierleague.com/api";

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`FPL returned HTTP ${response.status} for ${url}.`);
  return response.json();
}

/**
 * Only finished gameweeks count. A gameweek in progress reports zero minutes
 * for everyone whose match has not kicked off, which would read as a benching.
 */
async function finishedGameweeks(): Promise<number[]> {
  const bootstrap = parseExternal(FplBootstrapSchema, await json(`${api}/bootstrap-static/`), "bootstrap-static");
  return bootstrap.events.filter((event) => event.finished).map((event) => event.id);
}

async function main(): Promise<void> {
  const gameweeks = await finishedGameweeks();
  const live = [];
  for (const gameweek of gameweeks) {
    const payload = parseExternal(FplLiveResponseSchema, await json(`${api}/event/${gameweek}/live/`), `event-${gameweek}-live`);
    live.push(normalizeLiveGameweek(gameweek, payload));
  }
  const rows = buildCurrentMatchStats(live);
  await mkdir(generated, { recursive: true });
  await writeFile(
    path.join(generated, "current-match-stats.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), gameweeks, rows }, null, 2)}\n`,
  );
  console.log(`Wrote ${rows.length} rows across ${gameweeks.length} finished gameweeks.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
