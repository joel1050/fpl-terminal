/**
 * The Leagues workspace addresses a league by a short key: `overall` for the
 * global table, `classic-<id>` or `h2h-<id>` for a mini-league. The key is
 * persisted, so the store and the data hook read it through this one parser.
 */
export type LeagueSelection =
  | { type: "OVERALL" }
  | { type: "CLASSIC"; id: number }
  | { type: "H2H"; id: number };

export function parseLeagueKey(key: string | null | undefined): LeagueSelection | null {
  if (!key) return null;
  if (key === "overall") return { type: "OVERALL" };
  const classic = /^classic-(\d+)$/.exec(key);
  if (classic) {
    const id = Number(classic[1]);
    return Number.isSafeInteger(id) && id > 0 ? { type: "CLASSIC", id } : null;
  }
  const h2h = /^h2h-(\d+)$/.exec(key);
  if (h2h) {
    const id = Number(h2h[1]);
    return Number.isSafeInteger(id) && id > 0 ? { type: "H2H", id } : null;
  }
  return null;
}

export function isLeagueKey(key: unknown): key is string {
  return typeof key === "string" && parseLeagueKey(key) !== null;
}
