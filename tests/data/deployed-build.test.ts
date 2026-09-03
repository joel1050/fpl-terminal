import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotDirectory } from "@/lib/fpl/cache";
import { enrichBootstrapWithProjections, normalizeBootstrap } from "@/lib/fpl/normalize";
import { FplBootstrapSchema } from "@/lib/fpl/schemas";

const mocks = vi.hoisted(() => ({ fetchRotowireLineups: vi.fn() }));
vi.mock("@/lib/availability/rotowire", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/availability/rotowire")>()),
  fetchRotowireLineups: mocks.fetchRotowireLineups,
}));

function normalized() {
  const payload = FplBootstrapSchema.parse({
    events: [{ id: 1, name: "Gameweek 1", is_next: true, finished: false }],
    teams: [{ id: 1, name: "Alpha", short_name: "ALP" }, { id: 2, name: "Beta", short_name: "BET" }],
    element_types: [{ id: 3, plural_name_short: "MID" }],
    elements: [{
      id: 10, code: 100, first_name: "Test", second_name: "Player", web_name: "Player",
      team: 1, element_type: 3, now_cost: 75, status: "a", minutes: 900, total_points: 60,
    }],
    total_players: 1,
  });
  return normalizeBootstrap(payload, [{ id: 100, event: 1, team_h: 1, team_a: 2 }]);
}

/**
 * The snapshot-directory behaviour below only runs where `VERCEL` is set, which is nowhere a
 * test or a checkout runs. Without this file it would be written but never
 * executed until a deploy, which is exactly how the scrape-on-every-request bug
 * this file also guards against survived in the first place. `NODE_ENV` goes to
 * production alongside it so nothing is left taking a test-only branch.
 */
function asDeployedBuild<T>(run: () => T): T {
  // `NODE_ENV` is typed read-only; the alias is what lets a test write it.
  const env = process.env as Record<string, string | undefined>;
  const keys = ["VERCEL", "NODE_ENV", "FPL_SNAPSHOT_DIR"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, env[key]]));
  env.VERCEL = "1";
  env.NODE_ENV = "production";
  delete env.FPL_SNAPSHOT_DIR;
  try {
    return run();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete env[key];
      else env[key] = saved[key];
    }
  }
}


describe("deployed build", () => {
  beforeEach(() => mocks.fetchRotowireLineups.mockReset());

  it("never scrapes lineups while serving a request", async () => {
    // Lineups are refreshed by hand and committed. The request path may read
    // the snapshot on disk; it must never fetch one. This asserts the
    // behaviour rather than the absence of a function, so it still holds if
    // someone reintroduces an automatic path by another name.
    await enrichBootstrapWithProjections(normalized(), null);
    await asDeployedBuild(async () => enrichBootstrapWithProjections(normalized(), null));

    expect(mocks.fetchRotowireLineups).not.toHaveBeenCalled();
  });

  it("still reports how old the committed lineup snapshot is", async () => {
    // The freshness badge is the only thing left telling a user the lineups
    // are from last week, so it has to survive on the deployed build - which
    // is where the previous gating accidentally blanked it.
    const enriched = await asDeployedBuild(async () => enrichBootstrapWithProjections(normalized(), null));

    expect(enriched.metadata.lineups?.fetchedAt).toEqual(expect.any(String));
    expect(enriched.metadata.lineups?.ageSeconds).toEqual(expect.any(Number));
  });

  it("writes snapshots somewhere writable", () => {
    // Beside the source is read-only on a deployed build, so every write threw
    // and warned on each successful fetch.
    expect(asDeployedBuild(() => snapshotDirectory())).toBe("/tmp/fpl-snapshots");
  });

  it("lets an explicit directory win everywhere", () => {
    process.env.VERCEL = "1";
    process.env.FPL_SNAPSHOT_DIR = "/var/data/fpl";
    try {
      expect(snapshotDirectory()).toBe("/var/data/fpl");
    } finally {
      delete process.env.VERCEL;
      delete process.env.FPL_SNAPSHOT_DIR;
    }
  });

  it("keeps writing beside the source on a normal checkout", () => {
    expect(snapshotDirectory()).toBe(`${process.cwd()}/data/snapshots`);
  });
});
