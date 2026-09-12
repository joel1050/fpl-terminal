import type { CurrentStats, HistoricalStats, Player, Position } from "@/types/player";
import { DEFENSIVE_CONTRIBUTION_THRESHOLD } from "./projectPlayer";
import type { ProjectionComponents } from "@/types/projection";

/**
 * The scoring fields of `ProjectionComponents`, in the order the packed wire
 * format uses. `total` is left out because it is the sum of the rest, and
 * `penalties` because nothing in `fixtureComponents` ever writes to it.
 *
 * The order is the format: changing it silently re-labels every shipped
 * breakdown, so append rather than reorder.
 */
export const BREAKDOWN_COMPONENT_KEYS = [
  "appearance",
  "goals",
  "assists",
  "cleanSheets",
  "goalsConceded",
  "saves",
  "defensiveContribution",
  "bonus",
  "cards",
] as const;

export type BreakdownKey = (typeof BREAKDOWN_COMPONENT_KEYS)[number];

/** One rounded number per key of `BREAKDOWN_COMPONENT_KEYS`, in that order. */
export type PackedComponents = number[];

const DECIMALS = 100;

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * DECIMALS) / DECIMALS : 0;
}

/**
 * Squeezes a breakdown down for the wire. Named keys and full-precision floats
 * cost about 380 bytes a fixture; nine rounded numbers cost about 40.
 */
export function packComponents(components: ProjectionComponents): PackedComponents {
  return BREAKDOWN_COMPONENT_KEYS.map((key) => round(components[key]));
}

/** Rebuilds a full components object, recomputing the total from the parts. */
export function unpackComponents(packed: readonly number[]): ProjectionComponents {
  const components: ProjectionComponents = {
    appearance: 0,
    goals: 0,
    assists: 0,
    cleanSheets: 0,
    goalsConceded: 0,
    saves: 0,
    defensiveContribution: 0,
    bonus: 0,
    cards: 0,
    penalties: 0,
    total: 0,
  };
  BREAKDOWN_COMPONENT_KEYS.forEach((key, index) => {
    components[key] = round(packed[index] ?? 0);
  });
  components.total = round(
    BREAKDOWN_COMPONENT_KEYS.reduce((sum, key) => sum + components[key], 0),
  );
  return components;
}

/** Positions that can score each way, so a row never shows a player a rule they cannot meet. */
const SCORES_FOR: Record<BreakdownKey, readonly Position[]> = {
  appearance: ["GK", "DEF", "MID", "FWD"],
  goals: ["DEF", "MID", "FWD"],
  assists: ["GK", "DEF", "MID", "FWD"],
  cleanSheets: ["GK", "DEF", "MID"],
  goalsConceded: ["GK", "DEF"],
  saves: ["GK"],
  defensiveContribution: ["DEF", "MID", "FWD"],
  bonus: ["GK", "DEF", "MID", "FWD"],
  cards: ["GK", "DEF", "MID", "FWD"],
};

/** Plain wording for a reader who does not know the model, in reading order. */
const ROW_TEXT: Record<BreakdownKey, { label: string; note: string }> = {
  appearance: { label: "Playing", note: "1 point for getting on, 2 for an hour" },
  goals: { label: "Goals", note: "" },
  assists: { label: "Assists", note: "" },
  cleanSheets: { label: "Clean sheet", note: "Chance of conceding nothing" },
  saves: { label: "Saves", note: "1 point for every 3" },
  defensiveContribution: { label: "Defensive actions", note: "2 points for enough tackles, blocks and recoveries" },
  bonus: { label: "Bonus", note: "" },
  goalsConceded: { label: "Goals let in", note: "1 point off for every 2 conceded" },
  cards: { label: "Bookings", note: "1 point off a yellow, 3 a red" },
};

/** Earnings first, deductions last, so the section reads as a sum. */
const ROW_ORDER: readonly BreakdownKey[] = [
  "appearance",
  "goals",
  "assists",
  "cleanSheets",
  "saves",
  "defensiveContribution",
  "bonus",
  "goalsConceded",
  "cards",
];

/** A clean sheet pays a defender four points and a midfielder one, so say which. */
const CLEAN_SHEET_WORTH: Partial<Record<Position, string>> = { GK: "4 points", DEF: "4 points", MID: "1 point" };

function noteFor(key: BreakdownKey, position: Position): string {
  if (key !== "cleanSheets") return ROW_TEXT[key].note;
  const worth = CLEAN_SHEET_WORTH[position];
  return worth ? `${ROW_TEXT.cleanSheets.note}, worth ${worth}` : ROW_TEXT.cleanSheets.note;
}

const MINIMUM_MINUTES = 90;
const THIN_SAMPLE = "not enough minutes yet";

/**
 * The recorded figure behind a row, per 90 minutes played.
 *
 * A rate off a substitute appearance or two is noise dressed as a fact, so
 * anything under a full match of minutes says so instead of quoting a number.
 */
function per90(total: number | undefined, minutes: number | undefined, decimals = 2): string | undefined {
  if (total === undefined || minutes === undefined) return undefined;
  if (minutes < MINIMUM_MINUTES) return THIN_SAMPLE;
  return ((total / minutes) * 90).toFixed(decimals);
}

function seasons(
  player: Player,
  read: (stats: CurrentStats | HistoricalStats) => number | undefined,
  decimals = 2,
): BreakdownEvidence[] {
  const evidence: BreakdownEvidence[] = [];
  const thisSeason = per90(read(player.current), player.current.minutes, decimals);
  if (thisSeason !== undefined) evidence.push({ label: "This season", value: thisSeason });
  const previous = player.historical;
  if (previous) {
    const lastSeason = per90(read(previous), previous.minutes, decimals);
    if (lastSeason !== undefined) evidence.push({ label: "Previous season", value: lastSeason });
  }
  return evidence;
}

/** What the selection model expects of this player, in words rather than a probability. */
function selectionWording(startProbability: number, cameoProbability: number): string {
  if (startProbability >= 0.65) return "Expected to start this game";
  if (startProbability >= 0.35) return "Might start this game";
  if (startProbability + cameoProbability >= 0.35) return "More likely off the bench";
  return "Unlikely to feature";
}

function appearanceEvidence(player: Player): BreakdownEvidence[] {
  const selection = player.selection;
  const minutes = selection?.expectedMinutes;
  const evidence: BreakdownEvidence[] = [];
  if (selection) {
    evidence.push({ label: "Selection", value: selectionWording(selection.startProbability, selection.cameoProbability) });
  }
  if (minutes !== undefined) evidence.push({ label: "Minutes", value: `${Math.round(minutes)} expected` });
  return evidence.length ? evidence : [{ label: "Selection", value: "No lineup evidence yet" }];
}

/** What each row measures, and the recorded figures a reader can check it against. */
function evidenceFor(key: BreakdownKey, player: Player): { metric?: string; evidence: BreakdownEvidence[] } {
  switch (key) {
    case "appearance":
      return { evidence: appearanceEvidence(player) };
    case "goals":
      return { metric: "xG per 90", evidence: seasons(player, (stats) => stats.expectedGoals) };
    case "assists":
      return { metric: "xA per 90", evidence: seasons(player, (stats) => stats.expectedAssists) };
    case "cleanSheets":
      return { metric: "Expected goals against per 90", evidence: seasons(player, (stats) => stats.expectedGoalsConceded) };
    case "goalsConceded":
      return { metric: "Goals conceded per 90", evidence: seasons(player, (stats) => stats.goalsConceded) };
    case "saves":
      return { metric: "Saves per 90", evidence: seasons(player, (stats) => stats.saves, 1) };
    case "defensiveContribution":
      return {
        metric: "Defensive actions per 90",
        evidence: [
          ...seasons(player, (stats) => stats.defensiveContribution, 1),
          { label: "Needed", value: `${DEFENSIVE_CONTRIBUTION_THRESHOLD[player.position]} a match` },
        ],
      };
    case "bonus":
      return { metric: "Bonus per 90", evidence: seasons(player, (stats) => stats.bonus) };
    case "cards":
      return { metric: "Yellows per 90", evidence: seasons(player, (stats) => stats.yellowCards) };
  }
}

export interface BreakdownEvidence {
  label: string;
  value: string;
}

export interface BreakdownRow {
  key: BreakdownKey;
  label: string;
  note: string;
  /** What the evidence figures measure, e.g. "xG per 90". Absent where the rows speak for themselves. */
  metric?: string;
  /** The recorded figures behind the row. Never a recipe: see `gameweekBreakdown`. */
  evidence: BreakdownEvidence[];
  /** Signed: a deduction is negative, as it is in `ProjectionComponents`. */
  points: number;
  deduction: boolean;
}

export interface GameweekBreakdown {
  rows: BreakdownRow[];
  /** Sum of the rows, so what is displayed always adds up to what is displayed. */
  total: number;
  /** 2 in a double gameweek. */
  matches: number;
}

function componentsOf(fixture: {
  components?: ProjectionComponents;
  packedComponents?: readonly number[];
}): ProjectionComponents | undefined {
  if (fixture.components) return fixture.components;
  if (fixture.packedComponents) return unpackComponents(fixture.packedComponents);
  return undefined;
}

/**
 * Breaks a single gameweek's expected points into the ways they are earned.
 *
 * Returns null when the player has no match that week or the breakdown was not
 * shipped, so a caller shows an explanation rather than a table of zeroes.
 */
export function gameweekBreakdown(player: Player, gameweek: number): GameweekBreakdown | null {
  const fixtures = (player.projection?.fixtures ?? []).filter((fixture) => fixture.gameweek === gameweek);
  if (!fixtures.length) return null;

  const totals = new Map<BreakdownKey, number>();
  let matches = 0;
  for (const fixture of fixtures) {
    const components = componentsOf(fixture);
    if (!components) continue;
    matches += 1;
    for (const key of BREAKDOWN_COMPONENT_KEYS) {
      totals.set(key, (totals.get(key) ?? 0) + components[key]);
    }
  }
  if (!matches) return null;

  // A row is dropped only when the position cannot score it *and* it came back
  // at zero. Dropping a non-zero row would leave the visible rows short of the
  // total, which is exactly the confusion this section exists to remove.
  const rows = ROW_ORDER
    .map((key) => ({
      key,
      label: ROW_TEXT[key].label,
      note: noteFor(key, player.position),
      points: round(totals.get(key) ?? 0),
      deduction: key === "goalsConceded" || key === "cards",
      ...evidenceFor(key, player),
    }))
    .filter((row) => row.points !== 0 || SCORES_FOR[row.key].includes(player.position));

  return {
    rows,
    total: round(rows.reduce((sum, row) => sum + row.points, 0)),
    matches,
  };
}
