import generatedClubElo from "@/data/generated/club-elo.json";

export const CLUB_ELO_SOURCE = "https://clubelo.com/ENG";
export const CLUB_ELO_HOME_FIELD_ADVANTAGE = 40;
export const NEUTRAL_CLUB_ELO_FDR = 3;

export interface ClubEloClub {
  name: string;
  tlc: string;
  slug: string;
  elo: number;
}

export interface ClubEloSnapshot {
  source: string;
  fetchedAt: string;
  snapshotDate: string;
  homeFieldAdvantage: number;
  clubs: ClubEloClub[];
}

export interface ClubEloParseOptions {
  source?: string;
  fetchedAt?: string;
}

/**
 * FPL short names whose three-letter code differs from ClubElo's. Mapped to
 * ClubElo's slug rather than its code: the source reuses codes across
 * divisions - its England table lists both Stoke and Stockport as STO - so
 * only the slug names one club.
 */
const FPL_TO_CLUB_ELO_SLUG: Record<string, string> = {
  BHA: "Brighton",
  MUN: "ManUnited",
  NFO: "Forest",
};

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function normalizedName(value: string): string {
  return decodeHtml(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function slugify(value: string): string {
  return normalizedName(value).replace(/([a-z])([0-9])/g, "$1-$2") || "unknown";
}

function findMatchingBrace(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseEmbeddedVegaJson(html: string): unknown {
  const marker = /\bvar\s+vegaJson\s*=/.exec(html);
  if (!marker || marker.index === undefined) {
    throw new Error("ClubElo page did not contain its embedded vegaJson dataset.");
  }
  const start = html.indexOf("{", marker.index + marker[0].length);
  const end = start < 0 ? -1 : findMatchingBrace(html, start);
  if (start < 0 || end < 0) {
    throw new Error("ClubElo vegaJson dataset was truncated or malformed.");
  }
  try {
    return JSON.parse(html.slice(start, end + 1)) as unknown;
  } catch (error) {
    throw new Error(
      `ClubElo vegaJson dataset was not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

interface ExactClubRow {
  name: string;
  tlc: string;
  elo: number;
}

function collectExactRows(value: unknown, rows: ExactClubRow[] = []): ExactClubRow[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectExactRows(entry, rows));
    return rows;
  }
  if (!value || typeof value !== "object") return rows;

  const record = value as Record<string, unknown>;
  const name = typeof record.Name === "string" ? decodeHtml(record.Name) : undefined;
  const tlc = typeof record.TLC === "string" ? record.TLC.trim().toUpperCase() : undefined;
  const elo = typeof record.Elo === "number" ? record.Elo : undefined;
  const federation = typeof record.FedURL === "string"
    ? record.FedURL.trim().toUpperCase()
    : typeof record.Federation === "string"
      ? record.Federation.trim().toUpperCase()
      : undefined;
  if (name && tlc && Number.isFinite(elo) && (federation === "ENG" || federation === "ENGLAND")) {
    rows.push({ name, tlc, elo: elo as number });
  }
  Object.values(record).forEach((entry) => collectExactRows(entry, rows));
  return rows;
}

interface RankingClubRow extends ExactClubRow {
  slug: string;
}

function englandRankingHtml(html: string): string {
  const marker = /<div\s+class=["'][^"']*accordion-header[^"']*active[^"']*["']\s*>\s*<a\s+href=["']ENG["'][^>]*>\s*England\s*<\/a>/i;
  const match = marker.exec(html);
  if (!match || match.index === undefined) {
    throw new Error("ClubElo page did not contain the server-rendered England ranking.");
  }
  const start = match.index;
  const nextCountry = /<div\s+class=["']accordion-item["']\s*>\s*<div\s+class=["']accordion-header(?:\s|["'])/i.exec(
    html.slice(start + match[0].length),
  );
  const end = nextCountry ? start + match[0].length + nextCountry.index : html.length;
  return html.slice(start, end);
}

function parseRankingRows(html: string): RankingClubRow[] {
  const section = englandRankingHtml(html);
  const rows: RankingClubRow[] = [];
  const rowPattern = /<td\s+class=["']l["']>([\s\S]*?)<\/td>\s*<td\s+class=["']r["']>([^<]+)<\/td>/gi;
  for (const match of section.matchAll(rowPattern)) {
    const row = match[1];
    const clubLink = [...row.matchAll(/<a\s+href=["']\/([^"'/?]+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .find((link) => /class=["']NonAst["']/i.test(link[2]));
    const slug = clubLink?.[1];
    const tlc = row.match(/<span\s+class=["']NonAst["'][^>]*>\s*([^<]+?)\s*<\/span>/i)?.[1]?.trim().toUpperCase();
    const name = row.match(/<span\s+class=["']Ast["'][^>]*>\s*([^<]+?)\s*<\/span>/i)?.[1];
    const eloText = match[2].trim().match(/[-+]?\d+(?:\.\d+)?/);
    const elo = eloText ? Number(eloText[0]) : Number.NaN;
    if (!slug || !tlc || !name || !Number.isFinite(elo)) continue;
    rows.push({ name: decodeHtml(name), tlc, slug, elo });
  }
  return rows;
}

function snapshotDate(html: string): string {
  const date = html.match(/href=["']\/(\d{4}-\d{2}-\d{2})\/ENG["']/i)?.[1];
  if (!date) throw new Error("ClubElo page did not expose a dated England snapshot.");
  return date;
}

function mergeClubRows(exactRows: ExactClubRow[], rankingRows: RankingClubRow[]): ClubEloClub[] {
  const exactByName = new Map(exactRows.map((row) => [`${row.tlc}:${normalizedName(row.name)}`, row]));
  // Codes are not unique in the source, so a code matching two exact rows
  // names neither of them. Drop it rather than attach one club's rating to
  // another's ranking row; the ranking's own rounded Elo is the safe answer.
  const exactByTlc = new Map<string, ExactClubRow>();
  const sharedTlcs = new Set<string>();
  for (const row of exactRows) {
    if (exactByTlc.has(row.tlc)) sharedTlcs.add(row.tlc);
    exactByTlc.set(row.tlc, row);
  }
  for (const tlc of sharedTlcs) exactByTlc.delete(tlc);

  const used = new Set<string>();
  const merged = rankingRows.map((row) => {
    const exact = exactByName.get(`${row.tlc}:${normalizedName(row.name)}`) ?? exactByTlc.get(row.tlc);
    if (exact) used.add(`${exact.tlc}:${normalizedName(exact.name)}`);
    return {
      name: row.name,
      tlc: row.tlc,
      slug: row.slug,
      elo: exact?.elo ?? row.elo,
    };
  });

  for (const row of exactRows) {
    const key = `${row.tlc}:${normalizedName(row.name)}`;
    if (!used.has(key)) merged.push({ ...row, slug: slugify(row.name) });
  }

  // Ranking order currently follows Elo, but the source does not promise that
  // order. Sort by stable identity so the generated JSON is reproducible.
  return merged.sort((left, right) =>
    left.tlc.localeCompare(right.tlc) || left.slug.localeCompare(right.slug) || left.name.localeCompare(right.name),
  );
}

export function validateClubEloSnapshot(snapshot: ClubEloSnapshot): void {
  if (snapshot.source !== CLUB_ELO_SOURCE) throw new Error(`Unexpected ClubElo source: ${snapshot.source}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.snapshotDate)) {
    throw new Error("ClubElo snapshot date is missing or invalid.");
  }
  if (!Number.isFinite(Date.parse(snapshot.fetchedAt))) throw new Error("ClubElo fetchedAt is missing or invalid.");
  if (snapshot.homeFieldAdvantage !== CLUB_ELO_HOME_FIELD_ADVANTAGE) {
    throw new Error("ClubElo home-field advantage is missing or invalid.");
  }
  if (!Array.isArray(snapshot.clubs) || snapshot.clubs.length < 20) {
    throw new Error(`ClubElo ranking contained only ${snapshot.clubs?.length ?? 0} clubs.`);
  }
  const seen = new Set<string>();
  for (const club of snapshot.clubs) {
    if (!club.name || !club.tlc || !club.slug || !Number.isFinite(club.elo) || club.elo < 900 || club.elo > 2500) {
      throw new Error("ClubElo ranking contained an invalid club or Elo value.");
    }
    if (seen.has(club.slug)) throw new Error(`ClubElo ranking contained duplicate slug: ${club.slug}.`);
    seen.add(club.slug);
  }
}

export function parseClubEloPage(html: string, options: ClubEloParseOptions = {}): ClubEloSnapshot {
  const exactRows = collectExactRows(parseEmbeddedVegaJson(html));
  const rankingRows = parseRankingRows(html);
  if (!exactRows.length) throw new Error("ClubElo page contained no exact decimal Elo rows.");
  if (!rankingRows.length) throw new Error("ClubElo page contained no server-rendered England ranking rows.");
  const snapshot: ClubEloSnapshot = {
    source: options.source ?? CLUB_ELO_SOURCE,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    snapshotDate: snapshotDate(html),
    homeFieldAdvantage: CLUB_ELO_HOME_FIELD_ADVANTAGE,
    clubs: mergeClubRows(exactRows, rankingRows),
  };
  validateClubEloSnapshot(snapshot);
  return snapshot;
}

/**
 * Never guesses. A code two clubs share resolves to nothing rather than to
 * whichever of them rates higher, so the fixture falls back to neutral
 * difficulty and `npm run data:elo` refuses to write until someone names the
 * club in FPL_TO_CLUB_ELO_SLUG.
 */
export function clubEloForFplShortName(
  shortName: string | undefined,
  snapshot: ClubEloSnapshot = CLUB_ELO_SNAPSHOT,
): ClubEloClub | undefined {
  if (!shortName) return undefined;
  const normalized = shortName.trim().toUpperCase();
  const mappedSlug = FPL_TO_CLUB_ELO_SLUG[normalized];
  if (mappedSlug) return snapshot.clubs.find((club) => club.slug === mappedSlug);
  const matches = snapshot.clubs.filter((club) => club.tlc === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

export type UnresolvedClubEloReason =
  /** The team is mapped, but ClubElo no longer carries that slug. */
  | "stale-mapping"
  /** The code names more than one club, so it names none of them. */
  | "ambiguous"
  /** No club carries the code, and the team is not mapped. */
  | "missing";

export interface UnresolvedClubEloTeam {
  shortName: string;
  reason: UnresolvedClubEloReason;
}

/**
 * Names the teams a snapshot cannot rate, and why, so the ingest guard can
 * point at the repair rather than at a general direction.
 */
export function unresolvedClubEloTeams(
  shortNames: readonly string[],
  snapshot: ClubEloSnapshot = CLUB_ELO_SNAPSHOT,
): UnresolvedClubEloTeam[] {
  return shortNames.flatMap<UnresolvedClubEloTeam>((shortName) => {
    if (clubEloForFplShortName(shortName, snapshot)) return [];
    const normalized = shortName.trim().toUpperCase();
    if (FPL_TO_CLUB_ELO_SLUG[normalized]) return [{ shortName, reason: "stale-mapping" }];
    const shared = snapshot.clubs.filter((club) => club.tlc === normalized).length > 1;
    return [{ shortName, reason: shared ? "ambiguous" : "missing" }];
  });
}

export function calculateClubEloFdr(
  ownElo: number | undefined,
  opponentElo: number | undefined,
  isHome: boolean,
  homeFieldAdvantage = CLUB_ELO_HOME_FIELD_ADVANTAGE,
): number {
  if (!Number.isFinite(ownElo) || !Number.isFinite(opponentElo)) return NEUTRAL_CLUB_ELO_FDR;
  // Venue-agnostic by design: venue lives in the attack multiplier (1.102 /
  // 0.898) and the clean-sheet path, so FDR rates only the Elo gap.
  void isHome;
  void homeFieldAdvantage;
  return Math.min(5, Math.max(1, Math.round(3 + ((opponentElo as number) - (ownElo as number)) / 150)));
}

export function fixtureDifficultyFromClubElo(
  ownShortName: string | undefined,
  opponentShortName: string | undefined,
  isHome: boolean,
  snapshot: ClubEloSnapshot = CLUB_ELO_SNAPSHOT,
): number {
  return calculateClubEloFdr(
    clubEloForFplShortName(ownShortName, snapshot)?.elo,
    clubEloForFplShortName(opponentShortName, snapshot)?.elo,
    isHome,
    snapshot.homeFieldAdvantage,
  );
}


export function calculateContinuousClubEloFdr(
  ownElo: number | undefined,
  opponentElo: number | undefined,
  isHome: boolean,
  homeFieldAdvantage = CLUB_ELO_HOME_FIELD_ADVANTAGE,
): number {
  if (!Number.isFinite(ownElo) || !Number.isFinite(opponentElo)) return NEUTRAL_CLUB_ELO_FDR;
  // Venue-agnostic by design: see calculateClubEloFdr.
  void isHome;
  void homeFieldAdvantage;
  return Math.min(5, Math.max(1, 3 + ((opponentElo as number) - (ownElo as number)) / 200));
}

export function continuousFixtureDifficultyFromClubElo(
  ownShortName: string | undefined,
  opponentShortName: string | undefined,
  isHome: boolean,
  snapshot: ClubEloSnapshot = CLUB_ELO_SNAPSHOT,
): number {
  return calculateContinuousClubEloFdr(
    clubEloForFplShortName(ownShortName, snapshot)?.elo,
    clubEloForFplShortName(opponentShortName, snapshot)?.elo,
    isHome,
    snapshot.homeFieldAdvantage,
  );
}

export const CLUB_ELO_SNAPSHOT = generatedClubElo as unknown as ClubEloSnapshot;
