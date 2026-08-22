export const ROTOWIRE_LINEUPS_URL = "https://www.rotowire.com/soccer/lineups.php";

export type RotowireLineupStatus = "PREDICTED" | "CONFIRMED";
export type RotowireAvailabilityStatus = "QUES" | "OUT" | "SUS" | string;

export interface RotowirePlayer {
  rotowireId: number;
  name: string;
  position: string;
  profileUrl: string;
}

export interface RotowireUnavailablePlayer extends RotowirePlayer {
  status: RotowireAvailabilityStatus;
}

export interface RotowireTeamLineup {
  name: string;
  abbreviation: string;
  side: "HOME" | "AWAY";
  status: RotowireLineupStatus;
  starters: RotowirePlayer[];
  unavailable: RotowireUnavailablePlayer[];
}

export interface RotowireFixtureLineup {
  kickoff: string;
  home: RotowireTeamLineup;
  away: RotowireTeamLineup;
}

export interface RotowireLineupSnapshot {
  source: typeof ROTOWIRE_LINEUPS_URL;
  fetchedAt: string;
  dateRange: string;
  fixtures: RotowireFixtureLineup[];
}

const entities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

function decodeHtml(value: string): string {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => String.fromCodePoint(code[0].toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => entities[name.toLowerCase()] ?? match);
}

function text(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function capture(value: string, pattern: RegExp): string {
  return text(pattern.exec(value)?.[1] ?? "");
}

function playerRows(value: string, unavailable: boolean): Array<RotowirePlayer | RotowireUnavailablePlayer> {
  return [...value.matchAll(/<li class="lineup__player">([\s\S]*?)<\/li>/g)].flatMap((match) => {
    const row = match[1];
    const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/.exec(row);
    const attributes = anchor?.[1] ?? "";
    const href = /href="([^"]+)"/.exec(attributes)?.[1];
    const name = decodeHtml(/title="([^"]+)"/.exec(attributes)?.[1] ?? text(anchor?.[2] ?? ""));
    const id = href ? Number(/-(\d+)\/?$/.exec(href)?.[1]) : Number.NaN;
    if (!href || !name || !Number.isInteger(id)) return [];
    const base: RotowirePlayer = {
      rotowireId: id,
      name,
      position: capture(row, /<div class="lineup__pos[^>]*>([\s\S]*?)<\/div>/),
      profileUrl: new URL(href, ROTOWIRE_LINEUPS_URL).toString(),
    };
    return unavailable
      ? [{ ...base, status: capture(row, /<span class="lineup__inj">([\s\S]*?)<\/span>/) }]
      : [base];
  });
}

function parseTeamList(
  list: string,
  name: string,
  abbreviation: string,
  side: RotowireTeamLineup["side"],
): RotowireTeamLineup {
  const injuryMarker = list.search(/<li class="lineup__title[^>]*>\s*Injuries\s*<\/li>/i);
  const starterHtml = injuryMarker < 0 ? list : list.slice(0, injuryMarker);
  const unavailableHtml = injuryMarker < 0 ? "" : list.slice(injuryMarker);
  const statusClass = /<li class="lineup__status ([^"]+)"/.exec(list)?.[1] ?? "";
  return {
    name,
    abbreviation,
    side,
    status: /confirm/i.test(statusClass) ? "CONFIRMED" : "PREDICTED",
    starters: playerRows(starterHtml, false) as RotowirePlayer[],
    unavailable: playerRows(unavailableHtml, true) as RotowireUnavailablePlayer[],
  };
}

function fixtureBlocks(html: string): string[] {
  const starts = [...html.matchAll(/<div class="lineup is-soccer[^"]*">/g)].map((match) => match.index);
  return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length));
}

export function parseRotowireLineups(html: string, fetchedAt = new Date().toISOString()): RotowireLineupSnapshot {
  const fixtures = fixtureBlocks(html).flatMap((block): RotowireFixtureLineup[] => {
    const names = [
      capture(block, /<div class="lineup__mteam is-home">([\s\S]*?)<\/div>/),
      capture(block, /<div class="lineup__mteam is-visit">([\s\S]*?)<\/div>/),
    ];
    const abbreviations = [...block.matchAll(/<div class="lineup__abbr">([\s\S]*?)<\/div>/g)].slice(0, 2).map((match) => text(match[1]));
    const homeList = /<ul class="lineup__list is-home">([\s\S]*?)<\/ul>/.exec(block)?.[1];
    const awayList = /<ul class="lineup__list is-visit">([\s\S]*?)<\/ul>/.exec(block)?.[1];
    if (!names[0] || !names[1] || abbreviations.length !== 2 || !homeList || !awayList) return [];
    return [{
      kickoff: capture(block, /<div class="lineup__time">([\s\S]*?)<\/div>/),
      home: parseTeamList(homeList, names[0], abbreviations[0], "HOME"),
      away: parseTeamList(awayList, names[1], abbreviations[1], "AWAY"),
    }];
  });
  if (!fixtures.length) throw new Error("RotoWire returned no EPL lineup fixtures; its page structure may have changed.");
  const invalid = fixtures.flatMap((fixture) => [fixture.home, fixture.away]).filter((team) => team.starters.length !== 11 || new Set(team.starters.map((player) => player.rotowireId)).size !== 11);
  if (invalid.length) throw new Error(`RotoWire lineup validation failed for: ${invalid.map((team) => `${team.name} (${team.starters.length} starters)`).join(", ")}.`);
  return {
    source: ROTOWIRE_LINEUPS_URL,
    fetchedAt,
    dateRange: capture(html, /<div class="page-title__secondary">([\s\S]*?)<\/div>/),
    fixtures,
  };
}

export async function fetchRotowireLineups(fetcher: typeof fetch = fetch): Promise<RotowireLineupSnapshot> {
  const response = await fetcher(ROTOWIRE_LINEUPS_URL, {
    cache: "no-store",
    headers: {
      Accept: "text/html",
      "User-Agent": "FPL-Terminal/0.1 manual-lineup-import",
    },
  });
  if (!response.ok) throw new Error(`RotoWire returned HTTP ${response.status}.`);
  return parseRotowireLineups(await response.text());
}
