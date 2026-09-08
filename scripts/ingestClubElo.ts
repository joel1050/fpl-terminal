import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CLUB_ELO_SOURCE,
  parseClubEloPage,
  unresolvedClubEloTeams,
  validateClubEloSnapshot,
  type UnresolvedClubEloReason,
} from "@/lib/clubElo";
import teamStrengthData from "@/data/manual/team-strengths.json";

const REPAIR: Record<UnresolvedClubEloReason, string> = {
  "stale-mapping": "mapped slug is gone from ClubElo; point its FPL_TO_CLUB_ELO_SLUG entry at the new slug",
  ambiguous: "code names more than one club; map it by slug in FPL_TO_CLUB_ELO_SLUG",
  missing: "no club carries the code; map it by slug in FPL_TO_CLUB_ELO_SLUG",
};

const OUTPUT_DIR = path.join(process.cwd(), "data", "generated");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "club-elo.json");
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = "FPL-Terminal/0.1 data:elo (https://clubelo.com/ENG)";

async function fetchClubElo(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(CLUB_ELO_SOURCE, {
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ClubElo returned HTTP ${response.status}.`);
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function writeSnapshot(snapshot: ReturnType<typeof parseClubEloPage>): Promise<void> {
  validateClubEloSnapshot(snapshot);
  // Only as good as team-strengths.json being current: it is hand-maintained,
  // so a promoted club absent from it is a club this guard never checks.
  const unresolved = unresolvedClubEloTeams(
    teamStrengthData.teams.map((team) => team.shortName),
    snapshot,
  );
  if (unresolved.length) {
    const detail = unresolved.map((team) => `${team.shortName} (${REPAIR[team.reason]})`).join("; ");
    throw new Error(`ClubElo snapshot cannot rate current teams: ${detail}.`);
  }
  await mkdir(OUTPUT_DIR, { recursive: true });
  const temporaryFile = `${OUTPUT_FILE}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(temporaryFile, OUTPUT_FILE);
}

async function main(): Promise<void> {
  const page = await fetchClubElo();
  const snapshot = parseClubEloPage(page, {
    source: CLUB_ELO_SOURCE,
    fetchedAt: new Date().toISOString(),
  });
  await writeSnapshot(snapshot);
  console.log(`ClubElo snapshot written: ${snapshot.clubs.length} clubs, dated ${snapshot.snapshotDate}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "ClubElo ingestion failed.");
  process.exitCode = 1;
});
