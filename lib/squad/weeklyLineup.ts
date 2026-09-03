import type { Player, Position } from "@/types/player";
import type {
  LineupRiskMode,
  OutfieldBenchOrder,
  SquadValidation,
  WeeklyLineupInput,
  WeeklyLineupPlan,
} from "@/types/squad";
import type { Horizon } from "@/types/projection";
import { squadCostTenths, validateSquad } from "./validation";

const positionOrder: Record<Position, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
export const NEAR_EQUAL_XP_WINDOW = 0.25;

interface PlayerWeekMetrics {
  points: number;
  minutes: number;
  pDNP: number;
}

interface LineupCandidate {
  ids: number[];
  projectedXI: number;
  risk: number;
  minutes: number;
}

export type WeeklyLineupValidation = SquadValidation;

function validateOwnedSquad(squad: readonly Player[]): SquadValidation {
  return validateSquad(squad, { budgetTenths: squadCostTenths(squad) });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function orderedPlayers(players: readonly Player[]): Player[] {
  return [...players].sort((a, b) => positionOrder[a.position] - positionOrder[b.position] || a.id - b.id);
}

function compareIds(left: readonly number[], right: readonly number[]): number {
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function fixtureProjections(player: Player, gameweek: number) {
  return player.projection?.fixtures?.filter((fixture) => fixture.gameweek === gameweek) ?? [];
}

function hasFixtureSchedule(player: Player): boolean {
  return Boolean(player.projection?.fixtures.length);
}

function basePoints(player: Player, gameweek: number): number {
  const fixtures = fixtureProjections(player, gameweek);
  if (fixtures.length) return Math.max(0, fixtures.reduce((sum, fixture) => sum + (Number.isFinite(fixture.expectedPoints) ? fixture.expectedPoints : 0), 0));
  // A projection with a fixture schedule is authoritative for blank gameweeks;
  // never reuse its aggregate nextGW value from another gameweek.
  if (hasFixtureSchedule(player)) return 0;
  if (player.projection && Number.isFinite(player.projection.nextGW)) return Math.max(0, player.projection.nextGW);
  const per90 = player.current.pointsPer90 ??
    (player.current.minutes > 0 ? (player.current.totalPoints / player.current.minutes) * 90 : 0);
  return Math.max(0, per90 * (player.projection?.expectedMinutes ?? (player.current.minutes > 0 ? 90 : 0)) / 90);
}

function minutes(player: Player, gameweek: number): number {
  const fixtures = fixtureProjections(player, gameweek);
  if (fixtures.length) return Math.max(0, fixtures.reduce((sum, fixture) => sum + clamp(fixture.expectedMinutes, 0, 90), 0));
  if (hasFixtureSchedule(player)) return 0;
  return clamp(player.projection?.expectedMinutes ?? (player.current.minutes > 0 ? 90 : 0), 0, 90);
}

/** Probability that a player records zero minutes in the selected gameweek. */
export function probabilityDidNotPlay(player: Player, gameweek: number): number {
  const status = player.status.trim().toLowerCase();
  let availabilityRisk = 0;
  const fixtures = fixtureProjections(player, gameweek);
  const fixtureMinutes = fixtures.reduce((sum, fixture) => sum + Math.max(0, fixture.expectedMinutes), 0);
  if (hasFixtureSchedule(player) && fixtures.length === 0) return 1;
  if (fixtures.length > 0 && fixtureMinutes === 0) return 1;
  if (["i", "u", "n", "s"].includes(status) || /injur|suspend|unavail|out|not.?squad/.test(status)) availabilityRisk = 1;
  else if (status === "d" || /doubt|knock|ill/.test(status)) availabilityRisk = 0.5;
  if (typeof player.chanceOfPlaying === "number") availabilityRisk = Math.max(availabilityRisk, 1 - clamp(player.chanceOfPlaying, 0, 100) / 100);
  if (availabilityRisk >= 1) return 1;
  const minutesRisk = clamp((45 - minutes(player, gameweek)) / 45, 0, 1);
  return round(clamp(availabilityRisk * 0.75 + minutesRisk * 0.25, 0, 1));
}

function metrics(player: Player, gameweek: number): PlayerWeekMetrics {
  const pDNP = probabilityDidNotPlay(player, gameweek);
  return {
    points: basePoints(player, gameweek),
    minutes: minutes(player, gameweek),
    pDNP,
  };
}

/** Shared player inputs used by weekly lineup and exact transfer comparisons. */
export function weeklyPlayerMetrics(player: Player, gameweek: number): PlayerWeekMetrics {
  return metrics(player, gameweek);
}

function formationCounts(ids: readonly number[], players: ReadonlyMap<number, Player>): Record<Position, number> {
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const id of ids) {
    const position = players.get(id)?.position;
    if (position) counts[position] += 1;
  }
  return counts;
}

function legalFormation(counts: Record<Position, number>): boolean {
  return counts.GK === 1 && counts.DEF >= 3 && counts.MID >= 2 && counts.FWD >= 1 &&
    counts.DEF + counts.MID + counts.FWD === 10;
}

function formationString(ids: readonly number[], players: ReadonlyMap<number, Player>): string {
  const counts = formationCounts(ids, players);
  return `${counts.DEF}-${counts.MID}-${counts.FWD}`;
}

/** Enumerate legal XIs; malformed squads return no candidates instead of corrupting state. */
/** True when eleven distinct players form a legal starting XI under FPL formation rules. */
export function isLegalStartingXI(players: readonly Player[]): boolean {
  if (players.length !== 11) return false;
  if (new Set(players.map((player) => player.id)).size !== players.length) return false;
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const player of players) counts[player.position] += 1;
  return legalFormation(counts);
}

export function enumerateLegalStartingXIs(players: readonly Player[]): number[][] {
  if (!validateOwnedSquad(players).legal) return [];
  const ordered = orderedPlayers(players);
  const result: number[][] = [];
  const selected: Player[] = [];
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };

  function visit(index: number): void {
    if (selected.length > 11 || selected.length + ordered.length - index < 11) return;
    if (index === ordered.length) {
      if (selected.length === 11 && legalFormation(counts)) result.push(orderedPlayers(selected).map((player) => player.id));
      return;
    }
    const player = ordered[index];
    if (player.position !== "GK" || counts.GK === 0) {
      selected.push(player);
      counts[player.position] += 1;
      visit(index + 1);
      counts[player.position] -= 1;
      selected.pop();
    }
    visit(index + 1);
  }
  visit(0);
  return result.sort(compareIds);
}

export const enumerateLegalXIs = enumerateLegalStartingXIs;

function candidateFor(ids: number[], byId: ReadonlyMap<number, Player>, gameweek: number): LineupCandidate {
  const values = ids.map((id) => metrics(byId.get(id)!, gameweek));
  return {
    ids,
    projectedXI: values.reduce((sum, value) => sum + value.points, 0),
    risk: values.reduce((sum, value) => sum + value.pDNP, 0),
    minutes: values.reduce((sum, value) => sum + value.minutes, 0),
  };
}

function compareCandidates(left: LineupCandidate, right: LineupCandidate, mode: LineupRiskMode): number {
  if (mode === "SAFE" && left.risk !== right.risk) return left.risk - right.risk;
  if (mode === "BALANCED" && left.minutes !== right.minutes) return right.minutes - left.minutes;
  if (left.projectedXI !== right.projectedXI) return right.projectedXI - left.projectedXI;
  if (mode !== "AGGRESSIVE" && left.risk !== right.risk) return left.risk - right.risk;
  if (left.minutes !== right.minutes) return right.minutes - left.minutes;
  return compareIds(left.ids, right.ids);
}

function permutations(values: readonly number[]): OutfieldBenchOrder[] {
  if (values.length !== 3) return [];
  const result: OutfieldBenchOrder[] = [];
  for (const first of values) for (const second of values) {
    if (first === second) continue;
    const third = values.find((id) => id !== first && id !== second);
    if (third !== undefined) result.push([first, second, third]);
  }
  return result;
}

function benchIsValid(players: readonly Player[], starterIds: readonly number[], keeperId: number, order: readonly number[]): boolean {
  const byId = new Map(players.map((player) => [player.id, player]));
  const starters = new Set(starterIds);
  const bench = [keeperId, ...order];
  return new Set(bench).size === 4 && bench.every((id) => byId.has(id) && !starters.has(id)) &&
    byId.get(keeperId)?.position === "GK" && order.every((id) => byId.get(id)?.position !== "GK");
}

function appearanceProbability(ids: readonly number[], mask: number, probabilities: ReadonlyMap<number, number>): number {
  return ids.reduce((value, id, index) => {
    const play = (mask & (1 << index)) !== 0;
    const pPlay = 1 - (probabilities.get(id) ?? 0);
    return value * (play ? pPlay : 1 - pPlay);
  }, 1);
}

function appearanceStates(ids: readonly number[], probabilities: ReadonlyMap<number, number>): Array<{ mask: number; probability: number }> {
  const states: Array<{ mask: number; probability: number }> = [];
  for (let mask = 0; mask < (1 << ids.length); mask += 1) {
    const probability = appearanceProbability(ids, mask, probabilities);
    if (probability > 0) states.push({ mask, probability });
  }
  return states;
}

function outfieldAutosubGain(
  starterIds: readonly number[],
  outfieldStarters: readonly number[],
  benchOrder: readonly number[],
  starterMask: number,
  benchMask: number,
  byId: ReadonlyMap<number, Player>,
  gameweek: number,
): number {
  const starters = [...starterIds];
  let gain = 0;
  const isPlaying = (id: number) => {
    const starterIndex = outfieldStarters.indexOf(id);
    if (starterIndex >= 0) return (starterMask & (1 << starterIndex)) !== 0;
    const benchIndex = benchOrder.indexOf(id);
    return benchIndex < 0 || (benchMask & (1 << benchIndex)) !== 0;
  };
  for (const substituteId of benchOrder) {
    if (!isPlaying(substituteId)) continue;
    const absent = starters
      .filter((id) => byId.get(id)?.position !== "GK" && !isPlaying(id))
      .sort((a, b) => positionOrder[byId.get(a)!.position] - positionOrder[byId.get(b)!.position] || a - b);
    const outgoing = absent.find((id) => legalFormation(formationCounts([...starters.filter((starter) => starter !== id), substituteId], byId)));
    if (outgoing === undefined) continue;
    starters.splice(starters.indexOf(outgoing), 1, substituteId);
    gain += metrics(byId.get(substituteId)!, gameweek).points;
  }
  return gain;
}

/** Expected points recovered by a specific outfield bench order across all appearance masks. */
export function expectedAutosubValue(
  starterIds: readonly number[],
  benchGoalkeeperId: number,
  benchOrder: readonly number[],
  players: readonly Player[],
  gameweek: number,
): number {
  const byId = new Map(players.map((player) => [player.id, player]));
  if (!benchIsValid(players, starterIds, benchGoalkeeperId, benchOrder)) return 0;
  const probabilities = new Map(players.map((player) => [player.id, probabilityDidNotPlay(player, gameweek)]));
  const starterKeeper = starterIds.find((id) => byId.get(id)?.position === "GK");
  const keeperExpected = starterKeeper === undefined ? 0 : (probabilities.get(starterKeeper) ?? 0)
    * (1 - (probabilities.get(benchGoalkeeperId) ?? 0))
    * metrics(byId.get(benchGoalkeeperId)!, gameweek).points;
  const outfieldStarters = starterIds.filter((id) => byId.get(id)?.position !== "GK");
  const starterStates = appearanceStates(outfieldStarters, probabilities);
  const benchStates = appearanceStates(benchOrder, probabilities);
  let outfieldExpected = 0;
  for (const starterState of starterStates) {
    for (const benchState of benchStates) {
      outfieldExpected += starterState.probability * benchState.probability
        * outfieldAutosubGain(starterIds, outfieldStarters, benchOrder, starterState.mask, benchState.mask, byId, gameweek);
    }
  }
  return round(keeperExpected + outfieldExpected);
}

function fingerprint(players: readonly Player[], gameweek: number): string {
  const source = `${gameweek}|${orderedPlayers(players).map((player) => `${player.id}:${basePoints(player, gameweek).toFixed(3)}:${probabilityDidNotPlay(player, gameweek).toFixed(3)}`).join("|")}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function invalidPlan(gameweek: number, warnings: string[]): WeeklyLineupPlan {
  return {
    gameweek,
    starterIds: [],
    formation: "",
    benchGoalkeeperId: 0,
    benchOrder: [0, 0, 0],
    captainId: 0,
    viceCaptainId: 0,
    projectedXI: 0,
    captainBonus: 0,
    projectedTotal: 0,
    autosubValue: 0,
    explanations: [],
    warnings,
    projectionFingerprint: "",
  };
}

function captainPair(ids: readonly number[], byId: ReadonlyMap<number, Player>, gameweek: number): [number, number] {
  const captainCandidates = [...ids].sort((a, b) => {
    const left = metrics(byId.get(a)!, gameweek);
    const right = metrics(byId.get(b)!, gameweek);
    return right.points - left.points || left.pDNP - right.pDNP || a - b;
  });
  const captain = captainCandidates[0];
  const vice = captainCandidates.slice(1).sort((a, b) => {
    const left = metrics(byId.get(a)!, gameweek);
    const right = metrics(byId.get(b)!, gameweek);
    return right.points * (1 - right.pDNP) - left.points * (1 - left.pDNP) || left.pDNP - right.pDNP || a - b;
  })[0];
  return [captain, vice];
}

/** Picks a weekly team from all legal XIs and all legal bench permutations. */
export function pickWeeklyTeam(input: WeeklyLineupInput): WeeklyLineupPlan {
  const { squad, gameweek, riskMode } = input;
  const validation = validateOwnedSquad(squad);
  if (!validation.legal) return invalidPlan(gameweek, validation.errors);
  const byId = new Map(squad.map((player) => [player.id, player]));
  const candidates = enumerateLegalStartingXIs(squad).map((ids) => candidateFor(ids, byId, gameweek));
  if (!candidates.length) return invalidPlan(gameweek, ["The squad cannot produce a legal starting XI."]);
  const bestScore = Math.max(...candidates.map((candidate) => candidate.projectedXI));
  const nearEqual = candidates.filter((candidate) => bestScore - candidate.projectedXI <= NEAR_EQUAL_XP_WINDOW);
  const chosen = [...nearEqual].sort((left, right) => compareCandidates(left, right, riskMode))[0];
  const starterIds = chosen.ids;
  const bench = squad.filter((player) => !starterIds.includes(player.id));
  const benchKeeper = bench.find((player) => player.position === "GK");
  const outfield = bench
    .filter((player) => player.position !== "GK")
    .sort((left, right) => metrics(right, gameweek).points - metrics(left, gameweek).points || left.id - right.id)
    .map((player) => player.id);
  if (!benchKeeper || outfield.length !== 3) return invalidPlan(gameweek, ["The selected XI does not leave one goalkeeper and three outfield substitutes."]);
  const orders = permutations(outfield);
  const bestBench = orders
    .map((order) => ({ order, value: expectedAutosubValue(starterIds, benchKeeper.id, order, squad, gameweek) }))
    .sort((left, right) => right.value - left.value || compareIds(left.order, right.order))[0];
  const benchOrder = bestBench.order;
  const [captainId, viceCaptainId] = captainPair(starterIds, byId, gameweek);
  const captainBonus = metrics(byId.get(captainId)!, gameweek).points;
  const autosubValue = bestBench.value;
  const projectedTotal = round(chosen.projectedXI + captainBonus + autosubValue);
  const formation = formationString(starterIds, byId);
  return {
    gameweek,
    starterIds,
    formation,
    benchGoalkeeperId: benchKeeper.id,
    benchOrder,
    captainId,
    viceCaptainId,
    projectedXI: round(chosen.projectedXI),
    captainBonus: round(captainBonus),
    projectedTotal,
    autosubValue,
    explanations: [
      `${formation} selected from ${candidates.length} legal starting XIs.`,
      `${riskMode} mode used a ${NEAR_EQUAL_XP_WINDOW.toFixed(2)}-point near-equal XI window and pDNP-adjusted tie-breaking.`,
      `Bench order maximizes expected autosub value while preserving FPL formation rules.`,
    ],
    warnings: [],
    projectionFingerprint: fingerprint(squad, gameweek),
  };
}

/** Uses the weekly lineup engine for each distinct gameweek in the displayed horizons. */
export function projectWeeklyLineupHorizons(input: WeeklyLineupInput, appliedPlan?: WeeklyLineupPlan) {
  const plans = Array.from({ length: 10 }, (_, index) => {
    const gameweek = input.gameweek + index;
    return index === 0 && appliedPlan?.gameweek === gameweek
      ? appliedPlan
      : pickWeeklyTeam({ ...input, gameweek });
  });
  const total = (length: number) => round(plans.slice(0, length).reduce((sum, plan) => sum + plan.projectedTotal, 0));
  return { nextGW: total(1), next3: total(3), next5: total(5), next10: total(10) };
}

/** Projects only the requested number of distinct gameweeks. */
export function projectWeeklyLineupTotal(input: WeeklyLineupInput, horizon: Horizon): number {
  return round(Array.from({ length: horizon }, (_, index) => pickWeeklyTeam({
    ...input,
    gameweek: input.gameweek + index,
  })).reduce((sum, plan) => sum + plan.projectedTotal, 0));
}

/** Validates a manually persisted lineup against the current 15-player squad. */
export function validateWeeklyLineup(plan: WeeklyLineupPlan, squad: readonly Player[]): WeeklyLineupValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Number.isInteger(plan.gameweek) || plan.gameweek <= 0) errors.push("Gameweek must be a positive integer.");
  if (typeof plan.projectionFingerprint !== "string" || !plan.projectionFingerprint.trim()) errors.push("Projection fingerprint is required.");
  const squadValidation = validateOwnedSquad(squad);
  if (!squadValidation.legal) errors.push(...squadValidation.errors);
  const byId = new Map(squad.map((player) => [player.id, player]));
  const starterIds = Array.isArray(plan.starterIds) ? plan.starterIds : [];
  const benchOrder = Array.isArray(plan.benchOrder) ? plan.benchOrder : [];
  const starters = new Set(starterIds);
  if (starterIds.length !== 11 || starters.size !== 11) errors.push("A weekly starting XI must contain 11 distinct players.");
  if (starterIds.some((id) => !byId.has(id))) errors.push("The weekly XI contains a player outside the squad.");
  const counts = formationCounts(starterIds, byId);
  if (!legalFormation(counts)) errors.push("The weekly XI does not satisfy 1 GK, 3 DEF, 2 MID, and 1 FWD minimums.");
  if (plan.benchGoalkeeperId === 0 || byId.get(plan.benchGoalkeeperId)?.position !== "GK" || starters.has(plan.benchGoalkeeperId)) errors.push("The backup goalkeeper must be a non-starting squad goalkeeper.");
  const bench = [plan.benchGoalkeeperId, ...benchOrder];
  if (new Set(bench).size !== 4 || bench.some((id) => !byId.has(id) || starters.has(id))) errors.push("Bench players must be four distinct non-starting squad players.");
  if (benchOrder.length !== 3 || benchOrder.some((id) => byId.get(id)?.position === "GK")) errors.push("Bench order must contain exactly three outfield players.");
  if (plan.captainId === plan.viceCaptainId) errors.push("Captain and vice-captain must be different starters.");
  if (!starters.has(plan.captainId) || !starters.has(plan.viceCaptainId)) errors.push("Captain and vice-captain must both be starters.");
  if (plan.formation !== (legalFormation(counts) ? `${counts.DEF}-${counts.MID}-${counts.FWD}` : plan.formation)) errors.push("Formation does not match the starting XI.");
  if (plan.projectionFingerprint && plan.projectionFingerprint !== fingerprint(squad, plan.gameweek)) warnings.push("Projection fingerprint is stale for the current player data.");
  return { legal: errors.length === 0, errors, warnings };
}

export default pickWeeklyTeam;
