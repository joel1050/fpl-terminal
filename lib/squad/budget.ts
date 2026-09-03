import type { Player, Position } from "@/types/player";
import type { BudgetFeasibility, SquadConstraints } from "@/types/squad";
import {
  formatPrice,
  mergeConstraints,
  squadClubCounts,
  squadCostTenths,
  squadPositionCounts,
  validatePartialSquad,
  type SquadPlayers,
} from "./validation";

const positions: readonly Position[] = ["GK", "DEF", "MID", "FWD"];

export interface BudgetOptions {
  constraints?: Partial<SquadConstraints>;
  excludedPlayerIds?: readonly number[];
}

export interface BudgetRequest extends BudgetOptions {
  squad: SquadPlayers;
  playerPool: SquadPlayers;
}

/**
 * Why a selection was refused. `BUDGET` means money alone; callers use it to
 * offer a way out, since a squad the manager already owns can cost more than a
 * new entry's budget.
 */
export type IllegalSelectionReason = "OK" | "BUDGET" | "SHAPE" | "EXCLUDED";

export interface IllegalSelectionExplanation {
  legal: boolean;
  message: string;
  errors: string[];
  reason: IllegalSelectionReason;
  shortfallTenths: number;
  bankTenths: number;
  minimumRequiredTenths: number;
}

type ParsedBudgetInput = {
  squad: SquadPlayers;
  playerPool: SquadPlayers;
  options: BudgetOptions;
};

function parseInput(
  squadOrRequest: SquadPlayers | BudgetRequest,
  playerPool?: SquadPlayers,
  options?: BudgetOptions,
): ParsedBudgetInput {
  if (typeof squadOrRequest === "object" && "squad" in squadOrRequest) {
    const { squad, playerPool: pool, ...requestOptions } = squadOrRequest;
    return { squad, playerPool: pool, options: requestOptions };
  }
  return { squad: squadOrRequest, playerPool: playerPool ?? [], options: options ?? {} };
}

function availableCandidates(
  position: Position,
  squad: SquadPlayers,
  playerPool: SquadPlayers,
  options: BudgetOptions,
): Player[] {
  const selected = new Set(squad.map((player) => player.id));
  const excluded = new Set(options.excludedPlayerIds ?? []);
  const need = Math.max(0, mergeConstraints(options.constraints).positionCounts[position] -
    squadPositionCounts(squad)[position]);
  if (need === 0) return [];

  // Only the cheapest `need` players per club can contribute to a minimum-cost
  // completion. Keeping this small also makes the completion check predictable.
  const byClub = new Map<number, Player[]>();
  const seen = new Set<number>();
  for (const player of playerPool) {
    if (
      player.position !== position ||
      selected.has(player.id) ||
      excluded.has(player.id)
    ) continue;
    if (seen.has(player.id)) continue;
    seen.add(player.id);
    const club = byClub.get(player.teamId) ?? [];
    club.push(player);
    byClub.set(player.teamId, club);
  }
  return [...byClub.values()]
    .flatMap((players) =>
      players
        .sort((a, b) => a.priceTenths - b.priceTenths || a.id - b.id)
        .slice(0, Math.max(need, 3)),
    )
    .sort((a, b) => a.priceTenths - b.priceTenths || a.id - b.id);
}

/**
 * Finds the cheapest legal completion of the remaining positions. This is a
 * small min-cost flow over the cheapest few players at each club, which is
 * exact because no club can contribute more than three players.
 */
export function minimumRemainingSpend(
  squadOrRequest: SquadPlayers | BudgetRequest,
  playerPool?: SquadPlayers,
  options?: BudgetOptions,
): number {
  const input = parseInput(squadOrRequest, playerPool, options);
  const rules = mergeConstraints(input.options.constraints);
  if (!validatePartialSquad(input.squad, rules).legal) return Number.POSITIVE_INFINITY;

  const counts = squadPositionCounts(input.squad);
  const clubCounts = squadClubCounts(input.squad);
  const slots = positions.flatMap((position) =>
    Array.from(
      { length: Math.max(0, rules.positionCounts[position] - counts[position]) },
      () => position,
    ),
  );
  if (slots.length === 0) return 0;

  const candidates = new Map<Position, Player[]>();
  for (const position of positions) {
    const list = availableCandidates(position, input.squad, input.playerPool, input.options);
    if (slots.includes(position) && list.length < slots.filter((slot) => slot === position).length) {
      return Number.POSITIVE_INFINITY;
    }
    candidates.set(position, list);
  }

  // This is a small min-cost flow: each position sends its missing slots to
  // distinct players, then each club caps the total flow at three players.
  // It stays fast on the full FPL universe while remaining exact.
  type Edge = { to: number; reverse: number; capacity: number; cost: number };
  const graph: Edge[][] = [];
  const addNode = (): number => {
    graph.push([]);
    return graph.length - 1;
  };
  const addEdge = (from: number, to: number, capacity: number, cost: number): void => {
    const forward: Edge = { to, reverse: graph[to].length, capacity, cost };
    const reverse: Edge = { to: from, reverse: graph[from].length, capacity: 0, cost: -cost };
    graph[from].push(forward);
    graph[to].push(reverse);
  };

  const source = addNode();
  const positionNodes = new Map<Position, number>();
  for (const position of positions) positionNodes.set(position, addNode());
  const flatCandidates = positions.flatMap((position) =>
    (candidates.get(position) ?? []).map((candidate) => ({ position, candidate })),
  );
  const candidateNodes = flatCandidates.map(() => addNode());
  const clubs = [...new Set(flatCandidates.map(({ candidate }) => candidate.teamId))].sort((a, b) => a - b);
  const clubNodes = new Map<number, number>();
  for (const club of clubs) clubNodes.set(club, addNode());
  const sink = addNode();

  for (const position of positions) {
    const need = Math.max(0, rules.positionCounts[position] - counts[position]);
    addEdge(source, positionNodes.get(position)!, need, 0);
  }
  for (const [index, { position, candidate }] of flatCandidates.entries()) {
    addEdge(positionNodes.get(position)!, candidateNodes[index], 1, candidate.priceTenths);
    addEdge(candidateNodes[index], clubNodes.get(candidate.teamId)!, 1, 0);
  }
  for (const club of clubs) {
    addEdge(clubNodes.get(club)!, sink, Math.max(0, rules.maxPlayersPerClub - (clubCounts.get(club) ?? 0)), 0);
  }

  const requiredFlow = slots.length;
  let flow = 0;
  let cost = 0;
  while (flow < requiredFlow) {
    const distances = new Array(graph.length).fill(Number.POSITIVE_INFINITY) as number[];
    const previous = new Array(graph.length).fill(null) as Array<{ node: number; edge: number } | null>;
    const queued = new Array(graph.length).fill(false) as boolean[];
    const queue: number[] = [source];
    distances[source] = 0;
    queued[source] = true;
    while (queue.length) {
      const node = queue.shift()!;
      queued[node] = false;
      for (const [edgeIndex, edge] of graph[node].entries()) {
        if (edge.capacity <= 0 || distances[edge.to] <= distances[node] + edge.cost) continue;
        distances[edge.to] = distances[node] + edge.cost;
        previous[edge.to] = { node, edge: edgeIndex };
        if (!queued[edge.to]) {
          queue.push(edge.to);
          queued[edge.to] = true;
        }
      }
    }
    if (!Number.isFinite(distances[sink])) return Number.POSITIVE_INFINITY;
    let amount = requiredFlow - flow;
    for (let node = sink; node !== source;) {
      const step = previous[node]!;
      amount = Math.min(amount, graph[step.node][step.edge].capacity);
      node = step.node;
    }
    for (let node = sink; node !== source;) {
      const step = previous[node]!;
      const edge = graph[step.node][step.edge];
      edge.capacity -= amount;
      graph[node][edge.reverse].capacity += amount;
      node = step.node;
    }
    flow += amount;
    cost += amount * distances[sink];
  }
  return cost;
}

/**
 * The budget to hand the selection guards when the real bank is known.
 *
 * They derive their own bank as `budget − Σ market price`, so adding what the
 * squad costs at market makes that come out as the bank itself. A team's bank
 * is not `teamValue − Σ market price`: selling returns the purchase price plus
 * half the rise, so that subtraction understates the bank by the unbanked
 * profit on every player who has risen.
 */
export function effectiveBudgetTenths(bankTenths: number, squad: SquadPlayers): number {
  return Math.trunc(bankTenths) + squadCostTenths(squad);
}

export function calculateBudgetFeasibility(
  squadOrRequest: SquadPlayers | BudgetRequest,
  playerPool?: SquadPlayers,
  options?: BudgetOptions,
): BudgetFeasibility {
  const input = parseInput(squadOrRequest, playerPool, options);
  const rules = mergeConstraints(input.options.constraints);
  const spentTenths = squadCostTenths(input.squad);
  const bankTenths = rules.budgetTenths - spentTenths;
  const minimumRequiredTenths = minimumRemainingSpend({
    squad: input.squad,
    playerPool: input.playerPool,
    ...input.options,
  });
  const feasible =
    validatePartialSquad(input.squad, rules).legal &&
    minimumRequiredTenths <= bankTenths;
  return {
    spentTenths,
    bankTenths,
    minimumRequiredTenths,
    flexibleTenths: Number.isFinite(minimumRequiredTenths)
      ? bankTenths - minimumRequiredTenths
      : Number.NEGATIVE_INFINITY,
    feasible,
  };
}

export const budgetFeasibility = calculateBudgetFeasibility;
export const minimumRequiredSpend = minimumRemainingSpend;
export const calculateMinimumRemainingSpend = minimumRemainingSpend;

export function maxSafePriceForPosition(
  position: Position,
  squadOrRequest: SquadPlayers | BudgetRequest,
  playerPool?: SquadPlayers,
  options?: BudgetOptions,
): number {
  const input = parseInput(squadOrRequest, playerPool, options);
  const rules = mergeConstraints(input.options.constraints);
  if (!validatePartialSquad(input.squad, rules).legal) return 0;
  const currentCount = squadPositionCounts(input.squad)[position];
  if (currentCount >= rules.positionCounts[position]) return 0;
  const selected = new Set(input.squad.map((player) => player.id));
  const excluded = new Set(input.options.excludedPlayerIds ?? []);
  const clubs = squadClubCounts(input.squad);
  const bankTenths = rules.budgetTenths - squadCostTenths(input.squad);
  const eligible = input.playerPool
    .filter((candidate) =>
      candidate.position === position &&
      !selected.has(candidate.id) &&
      !excluded.has(candidate.id) &&
      candidate.priceTenths <= bankTenths &&
      (clubs.get(candidate.teamId) ?? 0) < rules.maxPlayersPerClub,
    )
    .sort((a, b) => b.priceTenths - a.priceTenths || a.id - b.id);

  for (const candidate of eligible) {
    const withCandidate = [...input.squad, candidate];
    const remainder = minimumRemainingSpend({
      squad: withCandidate,
      playerPool: input.playerPool,
      ...input.options,
    });
    const bank = bankTenths - candidate.priceTenths;
    if (remainder <= bank) return candidate.priceTenths;
  }
  return 0;
}

export const maximumSafePrice = maxSafePriceForPosition;
export const maxAffordablePrice = maxSafePriceForPosition;
export const calculateMaxSafePrice = maxSafePriceForPosition;

export function explainIllegalSelection(
  player: Player,
  squadOrRequest: SquadPlayers | BudgetRequest,
  playerPool?: SquadPlayers,
  options?: BudgetOptions,
): IllegalSelectionExplanation {
  const input = parseInput(squadOrRequest, playerPool, options);
  const rules = mergeConstraints(input.options.constraints);
  const bankTenths = rules.budgetTenths - squadCostTenths(input.squad);
  const withPlayer = [...input.squad, player];
  const direct = validatePartialSquad(withPlayer, rules);
  const minimumRequiredTenths = minimumRemainingSpend({
    squad: withPlayer,
    playerPool: input.playerPool,
    ...input.options,
  });
  const remainingBank = rules.budgetTenths - squadCostTenths(withPlayer);
  const shortfallTenths = Number.isFinite(minimumRequiredTenths)
    ? Math.max(0, minimumRequiredTenths - remainingBank)
    : Math.max(0, bankTenths - player.priceTenths);

  if ((input.options.excludedPlayerIds ?? []).includes(player.id)) {
    const message = `${player.displayName} is excluded from selection.`;
    return {
      legal: false,
      message,
      errors: [message],
      reason: "EXCLUDED",
      shortfallTenths,
      bankTenths: remainingBank,
      minimumRequiredTenths,
    };
  }

  if (!direct.legal) {
    // Money alone, rather than shape or club limits. Re-checking with the
    // budget lifted is what proves it: if the squad is legal then, cost was
    // the only thing wrong and more money would fix it.
    const overBudget = squadCostTenths(withPlayer) > rules.budgetTenths
      && validatePartialSquad(withPlayer, { ...rules, budgetTenths: Number.POSITIVE_INFINITY }).legal;
    return {
      legal: false,
      message: direct.errors.join(" "),
      errors: direct.errors,
      reason: overBudget ? "BUDGET" : "SHAPE",
      shortfallTenths,
      bankTenths: remainingBank,
      minimumRequiredTenths,
    };
  }
  if (minimumRequiredTenths > remainingBank) {
    const message =
      `This selection makes the squad impossible. Adding ${player.displayName} leaves ${formatPrice(remainingBank)}, ` +
      `but at least ${formatPrice(minimumRequiredTenths)} is required to fill the remaining slots. ` +
      `Shortfall: ${formatPrice(shortfallTenths)}.`;
    return {
      legal: false,
      message,
      errors: [message],
      reason: "BUDGET",
      shortfallTenths,
      bankTenths: remainingBank,
      minimumRequiredTenths,
    };
  }
  return {
    legal: true,
    message: `Adding ${player.displayName} keeps the partial squad completable.`,
    errors: [],
    reason: "OK",
    shortfallTenths: 0,
    bankTenths: remainingBank,
    minimumRequiredTenths,
  };
}

export const explainIllegalAdd = explainIllegalSelection;
