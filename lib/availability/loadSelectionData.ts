import { readFileSync } from "node:fs";
import path from "node:path";
import type { RotowireLineupSnapshot } from "./rotowire";
import type { RotowireMappedRecord } from "./rotowireMapping";
import type { RotowireSelectionSource } from "./selection";

export interface LoadedRotowireSelectionData extends RotowireSelectionSource {
  snapshot: RotowireLineupSnapshot | null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mappedRecord(value: unknown): value is RotowireMappedRecord {
  return record(value) &&
    typeof value.playerId === "number" &&
    (value.source === "STARTER" || value.source === "UNAVAILABLE") &&
    (value.lineupStatus === "PREDICTED" || value.lineupStatus === "CONFIRMED") &&
    typeof value.rotowireId === "number";
}

function snapshot(value: unknown): RotowireLineupSnapshot | null {
  if (!record(value) || typeof value.fetchedAt !== "string" || !Array.isArray(value.fixtures)) return null;
  return value as unknown as RotowireLineupSnapshot;
}

/** Loads the last generated weekly files without making network requests. */
export function loadRotowireSelectionData(
  generatedDir = path.join(process.cwd(), "data", "generated"),
): LoadedRotowireSelectionData | null {
  const snapshotData = snapshot(readJson(path.join(generatedDir, "rotowire-lineups.json")));
  const mappingsData = readJson(path.join(generatedDir, "rotowire-player-mappings.json"));
  const mappings = record(mappingsData) && Array.isArray(mappingsData.mappings)
    ? mappingsData.mappings.filter(mappedRecord)
    : [];
  if (!snapshotData && !mappings.length) return null;
  return { snapshot: snapshotData, mappings };
}

export const loadRotowireData = loadRotowireSelectionData;
