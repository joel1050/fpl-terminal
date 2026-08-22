import type { Player, Position } from "@/types/player";
import type { StartingXIPlan } from "@/types/squad";

export interface StartingXIOptions {
  expectedPoints?: Readonly<Record<number, number>>;
  expectedMinutes?: Readonly<Record<number, number>>;
}

const positionOrder: Record<Position, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

function playerScore(player: Player, options: StartingXIOptions): number {
  const projection = options.expectedPoints?.[player.id] ?? player.projection?.nextGW;
  if (projection !== undefined) return projection;
  const minutes = options.expectedMinutes?.[player.id] ?? player.projection?.expectedMinutes;
  if (minutes !== undefined && minutes > 0) {
    return ((player.current.pointsPer90 ?? 0) * minutes) / 90;
  }
  if (player.current.pointsPer90 !== undefined) return player.current.pointsPer90;
  if (player.current.minutes > 0) {
    return (player.current.totalPoints / player.current.minutes) * 90;
  }
  return 0;
}

function compareIds(left: readonly Player[], right: readonly Player[]): number {
  const a = [...left].sort((x, y) => x.id - y.id).map((player) => player.id);
  const b = [...right].sort((x, y) => x.id - y.id).map((player) => player.id);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function scoreSquad(players: readonly Player[], options: StartingXIOptions): number {
  return players.reduce((sum, player) => sum + playerScore(player, options), 0);
}

function displayOrder(players: readonly Player[]): Player[] {
  return [...players].sort(
    (a, b) => positionOrder[a.position] - positionOrder[b.position] || a.id - b.id,
  );
}

/**
 * Selects the highest-scoring legal XI. There are only 15 players, so checking
 * all 11-player subsets is simpler and safer than embedding formation rules in
 * a greedy algorithm.
 */
export function selectStartingXI(
  players: readonly Player[],
  options: StartingXIOptions = {},
): StartingXIPlan {
  if (players.length < 11) throw new Error("A starting XI needs at least 11 players.");
  const best: Player[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  const selected: Player[] = [];

  function visit(index: number, goalkeepers: number, defenders: number, midfielders: number, forwards: number): void {
    if (selected.length > 11) return;
    if (selected.length + (players.length - index) < 11) return;
    if (index === players.length) {
      if (
        selected.length !== 11 ||
        goalkeepers !== 1 ||
        defenders < 3 ||
        midfielders < 2 ||
        forwards < 1
      ) return;
      const score = scoreSquad(selected, options);
      const epsilon = 1e-9;
      if (score > bestScore + epsilon || (Math.abs(score - bestScore) <= epsilon && compareIds(selected, best) < 0)) {
        bestScore = score;
        best.splice(0, best.length, ...selected);
      }
      return;
    }

    const player = players[index];
    const canTake = player.position === "GK" ? goalkeepers < 1 : true;
    if (canTake) {
      selected.push(player);
      visit(
        index + 1,
        goalkeepers + (player.position === "GK" ? 1 : 0),
        defenders + (player.position === "DEF" ? 1 : 0),
        midfielders + (player.position === "MID" ? 1 : 0),
        forwards + (player.position === "FWD" ? 1 : 0),
      );
      selected.pop();
    }
    visit(index + 1, goalkeepers, defenders, midfielders, forwards);
  }
  visit(0, 0, 0, 0, 0);

  if (best.length !== 11) {
    throw new Error("The squad cannot produce a legal starting XI.");
  }
  const starters = displayOrder(best);
  const starterIds = new Set(starters.map((player) => player.id));
  const benchPlayers = players.filter((player) => !starterIds.has(player.id));
  const goalkeeper = benchPlayers.find((player) => player.position === "GK");
  const outfield = benchPlayers
    .filter((player) => player.position !== "GK")
    .sort((a, b) => playerScore(b, options) - playerScore(a, options) || a.id - b.id);

  if (!goalkeeper || outfield.length !== 3) {
    throw new Error("A complete squad needs one goalkeeper and three outfield substitutes.");
  }
  return {
    playerIds: starters.map((player) => player.id),
    bench: { goalkeeperId: goalkeeper.id, outfieldIds: outfield.map((player) => player.id) },
  };
}

export const deterministicStartingXI = selectStartingXI;
export const getStartingXI = selectStartingXI;
