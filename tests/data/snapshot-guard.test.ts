import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { isEmptyPayload, readSnapshot, writeSnapshot } from "@/lib/fpl/cache";

const LiveShape = z.object({ elements: z.array(z.object({ id: z.number() })) });

describe("snapshot guards", () => {
  let directory: string;
  let previous: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "fpl-snapshot-"));
    await mkdir(directory, { recursive: true });
    previous = process.env.FPL_SNAPSHOT_DIR;
    process.env.FPL_SNAPSHOT_DIR = directory;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.FPL_SNAPSHOT_DIR;
    else process.env.FPL_SNAPSHOT_DIR = previous;
  });

  it("recognises payloads with nothing in them", () => {
    expect(isEmptyPayload({ elements: [] })).toBe(true);
    expect(isEmptyPayload({ standings: { results: [] } })).toBe(true);
    expect(isEmptyPayload([])).toBe(true);
    expect(isEmptyPayload({ elements: [{ id: 1 }] })).toBe(false);
  });

  it("never writes an empty snapshot over an existing one", async () => {
    await writeSnapshot("live-1", { elements: [{ id: 1 }] }, 1_700_000_000_000);
    await writeSnapshot("live-1", { elements: [] }, 1_700_000_100_000);
    const stored = JSON.parse(await readFile(path.join(directory, "live-1.json"), "utf8"));
    expect(stored.data.elements).toHaveLength(1);
  });

  it("refuses to serve an empty snapshot that is already on disk", async () => {
    await writeFile(
      path.join(directory, "live-2.json"),
      JSON.stringify({ fetchedAt: new Date(1_700_000_000_000).toISOString(), data: { elements: [] } }),
      "utf8",
    );
    expect(await readSnapshot("live-2", LiveShape)).toBeNull();
  });

  it("still serves a snapshot that holds data", async () => {
    await writeSnapshot("live-3", { elements: [{ id: 7 }] }, 1_700_000_000_000);
    const snapshot = await readSnapshot("live-3", LiveShape);
    expect(snapshot?.data.elements[0].id).toBe(7);
  });
});
