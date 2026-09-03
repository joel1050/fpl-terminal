import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RotowireLineupSnapshot } from "@/lib/availability/rotowire";
import type { Player } from "@/types/player";

function player(id: number, first: string, second: string, web: string): Player {
  return {
    id,
    code: id,
    firstName: first,
    lastName: second,
    displayName: web,
    teamId: 1,
    teamName: "Brentford",
    teamShortName: "BRE",
    position: "FWD",
    priceTenths: 80,
    ownership: 1,
    status: "a",
    chanceOfPlaying: null,
    current: { totalPoints: 0, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 0, saves: 0 },
    fixtures: [],
  };
}

function team(name: string, abbreviation: string, side: "HOME" | "AWAY", starter: string) {
  return {
    name,
    abbreviation,
    side,
    status: "PREDICTED",
    starters: [{ rotowireId: side === "HOME" ? 1 : 2, name: starter, position: "FWD", profileUrl: "" }],
    unavailable: [],
  };
}

function snapshotAt(fetchedAt: string): RotowireLineupSnapshot {
  return {
    source: "https://www.rotowire.com/soccer/lineups.php",
    fetchedAt,
    dateRange: "Starting lineups for September 5, 2026 - September 6, 2026",
    fixtures: [{
      kickoff: "September 5 10:00 AM ET",
      home: team("Brentford", "BRE", "HOME", "Igor Thiago"),
      away: team("Sunderland", "SUN", "AWAY", "Wilson Isidor"),
    }],
  } as unknown as RotowireLineupSnapshot;
}

const squad = [player(106, "Igor", "Thiago", "Thiago")];

describe("manual lineup import", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "fpl-rotowire-refresh-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function writeExisting(fetchedAt: string): Promise<void> {
    await writeFile(
      path.join(directory, "rotowire-lineups.json"),
      JSON.stringify(snapshotAt(fetchedAt)),
      "utf8",
    );
  }

  it("writes the snapshot and its mappings together", async () => {
    const fetchSnapshot = vi.fn(async () => snapshotAt("2026-09-05T11:55:00Z"));

    const { refreshRotowireLineups } = await import("@/lib/availability/refreshLineups");
    const result = await refreshRotowireLineups(squad, { generatedDir: directory, fetchSnapshot });

    expect(result.mapped).toBeGreaterThan(0);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    const written = JSON.parse(await readFile(path.join(directory, "rotowire-lineups.json"), "utf8"));
    expect(written.fetchedAt).toBe("2026-09-05T11:55:00Z");
    const mappings = JSON.parse(await readFile(path.join(directory, "rotowire-player-mappings.json"), "utf8"));
    expect(mappings.sourceFetchedAt).toBe("2026-09-05T11:55:00Z");
  });

  it("keeps the committed snapshot when the fetch fails", async () => {
    await writeExisting("2026-09-03T23:00:00Z");
    const fetchSnapshot = vi.fn(async () => { throw new Error("Upstream returned HTTP 503."); });

    const { refreshRotowireLineups } = await import("@/lib/availability/refreshLineups");
    await expect(refreshRotowireLineups(squad, { generatedDir: directory, fetchSnapshot }))
      .rejects.toThrow(/503/);

    const kept = JSON.parse(await readFile(path.join(directory, "rotowire-lineups.json"), "utf8"));
    expect(kept.fetchedAt).toBe("2026-09-03T23:00:00Z");
  });

  it("keeps the committed snapshot when the new one maps no players", async () => {
    // A snapshot nothing maps onto silently strips every predicted XI, so it
    // is refused the same way a partial page is - the run fails and the file
    // on disk is left as it was.
    await writeExisting("2026-09-03T23:00:00Z");
    const fetchSnapshot = vi.fn(async () => snapshotAt("2026-09-05T11:55:00Z"));

    const { refreshRotowireLineups } = await import("@/lib/availability/refreshLineups");
    await expect(refreshRotowireLineups([], { generatedDir: directory, fetchSnapshot }))
      .rejects.toThrow(/no players/i);

    const kept = JSON.parse(await readFile(path.join(directory, "rotowire-lineups.json"), "utf8"));
    expect(kept.fetchedAt).toBe("2026-09-03T23:00:00Z");
  });
});

describe("snapshot age", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "fpl-rotowire-age-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reports how old the committed snapshot is", async () => {
    await writeFile(
      path.join(directory, "rotowire-lineups.json"),
      JSON.stringify(snapshotAt("2026-09-04T18:00:00Z")),
      "utf8",
    );

    const { rotowireSnapshotAge } = await import("@/lib/availability/refreshLineups");
    const age = await rotowireSnapshotAge({ generatedDir: directory, now: Date.parse("2026-09-05T12:00:00Z") });

    expect(age?.fetchedAt).toBe("2026-09-04T18:00:00Z");
    expect(age?.ageMs).toBe(18 * 60 * 60 * 1000);
  });

  it("says nothing rather than guessing when there is no snapshot", async () => {
    const { rotowireSnapshotAge } = await import("@/lib/availability/refreshLineups");
    expect(await rotowireSnapshotAge({ generatedDir: directory })).toBeNull();
  });
});
