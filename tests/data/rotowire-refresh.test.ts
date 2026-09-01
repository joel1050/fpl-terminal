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

describe("ensureFreshRotowireLineups", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "fpl-rotowire-refresh-"));
    const { resetRotowireRefreshState } = await import("@/lib/availability/refreshLineups");
    resetRotowireRefreshState();
    process.env.FPL_ROTOWIRE_AUTO_REFRESH = "1";
  });

  afterEach(async () => {
    delete process.env.FPL_ROTOWIRE_AUTO_REFRESH;
    await rm(directory, { recursive: true, force: true });
  });

  async function writeExisting(fetchedAt: string): Promise<void> {
    await writeFile(
      path.join(directory, "rotowire-lineups.json"),
      JSON.stringify(snapshotAt(fetchedAt)),
      "utf8",
    );
  }

  it("leaves the snapshot alone when it is younger than the maximum age", async () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    await writeExisting("2026-09-04T18:00:00Z"); // 18 hours old
    const fetchSnapshot = vi.fn();

    const { ensureFreshRotowireLineups } = await import("@/lib/availability/refreshLineups");
    const result = await ensureFreshRotowireLineups([], {
      generatedDir: directory,
      fetchSnapshot,
      now,
    });

    expect(result).toMatchObject({ refreshed: false, reason: "fresh" });
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("refetches and rewrites the snapshot once it is older than the maximum age", async () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    await writeExisting("2026-09-03T23:00:00Z"); // 37 hours old
    const fresh = snapshotAt("2026-09-05T11:55:00Z");
    const fetchSnapshot = vi.fn(async () => fresh);

    const { ensureFreshRotowireLineups } = await import("@/lib/availability/refreshLineups");
    const result = await ensureFreshRotowireLineups(squad, {
      generatedDir: directory,
      fetchSnapshot,
      now,
    });

    expect(result).toMatchObject({ refreshed: true, reason: "refreshed" });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    const written = JSON.parse(await readFile(path.join(directory, "rotowire-lineups.json"), "utf8"));
    expect(written.fetchedAt).toBe("2026-09-05T11:55:00Z");
    const mappings = JSON.parse(await readFile(path.join(directory, "rotowire-player-mappings.json"), "utf8"));
    expect(mappings.sourceFetchedAt).toBe("2026-09-05T11:55:00Z");
  });

  it("keeps the previous snapshot when the refresh fails", async () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    await writeExisting("2026-09-03T23:00:00Z");
    const fetchSnapshot = vi.fn(async () => {
      throw new Error("RotoWire returned HTTP 503.");
    });

    const { ensureFreshRotowireLineups } = await import("@/lib/availability/refreshLineups");
    const result = await ensureFreshRotowireLineups([], {
      generatedDir: directory,
      fetchSnapshot,
      now,
    });

    expect(result).toMatchObject({ refreshed: false, reason: "failed" });
    expect(result.error).toContain("503");
    const kept = JSON.parse(await readFile(path.join(directory, "rotowire-lineups.json"), "utf8"));
    expect(kept.fetchedAt).toBe("2026-09-03T23:00:00Z");
  });

  it("does not refetch after a failure until the retry cooldown has passed", async () => {
    await writeExisting("2026-09-03T23:00:00Z");
    const fetchSnapshot = vi.fn(async () => {
      throw new Error("RotoWire returned HTTP 503.");
    });

    const { ensureFreshRotowireLineups } = await import("@/lib/availability/refreshLineups");
    const options = { generatedDir: directory, fetchSnapshot };
    await ensureFreshRotowireLineups([], { ...options, now: Date.parse("2026-09-05T12:00:00Z") });
    const second = await ensureFreshRotowireLineups([], { ...options, now: Date.parse("2026-09-05T12:01:00Z") });

    expect(second).toMatchObject({ refreshed: false, reason: "cooling-down" });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("refreshes when no snapshot exists yet", async () => {
    const fresh = snapshotAt("2026-09-05T11:55:00Z");
    const fetchSnapshot = vi.fn(async () => fresh);

    const { ensureFreshRotowireLineups } = await import("@/lib/availability/refreshLineups");
    const result = await ensureFreshRotowireLineups(squad, {
      generatedDir: directory,
      fetchSnapshot,
      now: Date.parse("2026-09-05T12:00:00Z"),
    });

    expect(result).toMatchObject({ refreshed: true, reason: "refreshed" });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous snapshot when the refreshed one maps no players", async () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    await writeExisting("2026-09-03T23:00:00Z");
    const fetchSnapshot = vi.fn(async () => snapshotAt("2026-09-05T11:55:00Z"));

    const { ensureFreshRotowireLineups } = await import("@/lib/availability/refreshLineups");
    const result = await ensureFreshRotowireLineups([], { generatedDir: directory, fetchSnapshot, now });

    expect(result).toMatchObject({ refreshed: false, reason: "failed" });
    expect(result.error).toMatch(/no players/i);
    const kept = JSON.parse(await readFile(path.join(directory, "rotowire-lineups.json"), "utf8"));
    expect(kept.fetchedAt).toBe("2026-09-03T23:00:00Z");
  });

  it("does not reach RotoWire during a test run unless explicitly opted in", async () => {
    delete process.env.FPL_ROTOWIRE_AUTO_REFRESH;
    await writeExisting("2026-09-03T23:00:00Z");
    const fetchSnapshot = vi.fn();

    const { ensureFreshRotowireLineups } = await import("@/lib/availability/refreshLineups");
    const result = await ensureFreshRotowireLineups(squad, {
      generatedDir: directory,
      fetchSnapshot,
      now: Date.parse("2026-09-05T12:00:00Z"),
    });

    expect(result).toMatchObject({ refreshed: false, reason: "disabled" });
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });
});
