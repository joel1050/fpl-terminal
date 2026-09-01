import { z } from "zod";

import type { ChatToolDefinition } from "./deepseek";
import {
  AnalystContextSchema,
  AnalystContextInput,
  CompactPlayerSchema,
  ToolInputSchemas,
  ToolName,
} from "./schemas";
import type { Player } from "@/types/player";
import type { Horizon } from "@/types/projection";
import { getBootstrap, getFixtures } from "@/lib/fpl/client";
import { normalizeBootstrap } from "@/lib/fpl/normalize";
import { enrichPlayersWithHistory } from "@/lib/historical/enrichPlayers";
import { loadHistoricalBundle } from "@/lib/historical/load";
import { loadInSeasonPlayerRates, loadInSeasonTeamXG } from "@/lib/historical/loadInSeasonForm";
import { analyzeSquad } from "@/lib/analysis/analyzeSquad";
import { suggestForSlot } from "@/lib/analysis/replacements";
import { findBestSingleTransfers } from "@/lib/analysis/singleTransfers";
import { simulateChange } from "@/lib/analysis/simulateChange";
import { projectPlayer } from "@/lib/projections/projectPlayer";
import type { OptimizerResult } from "@/lib/optimizer/optimizer";
import { exactCompletePartialSquad, exactOptimizeFullSquad } from "@/lib/optimizer/exactOptimizer";
import { pickWeeklyTeam as selectWeeklyTeam } from "@/lib/squad/weeklyLineup";

type ToolInput<Name extends ToolName> = z.infer<(typeof ToolInputSchemas)[Name]>;
type ToolHandler = (input: unknown, context: AnalystContextInput) => unknown | Promise<unknown>;

export interface AIDataAdapters {
  searchPlayers?: (input: ToolInput<"search_players">, context: AnalystContextInput) => unknown | Promise<unknown>;
  getPlayer?: (input: ToolInput<"get_player">, context: AnalystContextInput) => unknown | Promise<unknown>;
  comparePlayers?: (input: ToolInput<"compare_players">, context: AnalystContextInput) => unknown | Promise<unknown>;
  getPlayerFixtures?: (input: ToolInput<"get_player_fixtures">, context: AnalystContextInput) => unknown | Promise<unknown>;
  getPlayerProjection?: (input: ToolInput<"get_player_projection">, context: AnalystContextInput) => unknown | Promise<unknown>;
  analyzeSquad?: (input: ToolInput<"analyze_squad">, context: AnalystContextInput) => unknown | Promise<unknown>;
  findReplacements?: (input: ToolInput<"find_replacements">, context: AnalystContextInput) => unknown | Promise<unknown>;
  suggestForSlot?: (input: ToolInput<"suggest_for_slot">, context: AnalystContextInput) => unknown | Promise<unknown>;
  optimizeSquad?: (input: ToolInput<"optimize_squad">, context: AnalystContextInput) => unknown | Promise<unknown>;
  completeSquad?: (input: ToolInput<"complete_squad">, context: AnalystContextInput) => unknown | Promise<unknown>;
  optimizeAroundPlayer?: (input: ToolInput<"optimize_around_player">, context: AnalystContextInput) => unknown | Promise<unknown>;
  simulateChange?: (input: ToolInput<"simulate_change">, context: AnalystContextInput) => unknown | Promise<unknown>;
  chooseCaptain?: (input: ToolInput<"choose_captain">, context: AnalystContextInput) => unknown | Promise<unknown>;
  pickWeeklyTeam?: (input: ToolInput<"pick_weekly_team">, context: AnalystContextInput) => unknown | Promise<unknown>;
}

function compactPlayer(player: Player, currentGameweek = 1) {
  const projection = player.projection ?? projectPlayer(player, { currentGameweek, horizon: 10 });
  return {
    id: player.id,
    displayName: player.displayName,
    position: player.position,
    priceTenths: player.priceTenths,
    teamId: player.teamId,
    teamShortName: player.teamShortName,
    status: player.status,
    chanceOfPlaying: player.chanceOfPlaying,
    fixtures: player.fixtures.slice(0, 10),
    ...(projection
      ? {
        projection: {
            nextGW: projection.nextGW,
            next3: projection.next3,
            next5: projection.next5,
            next10: projection.next10,
            expectedMinutes: projection.expectedMinutes,
            valueNext5: projection.valueNext5,
            riskScore: projection.riskScore,
            confidence: projection.confidence,
          },
        }
      : {}),
  };
}

function compactAnalysis(analysis: ReturnType<typeof analyzeSquad>) {
  return {
    totalCostTenths: analysis.totalCostTenths,
    bankTenths: analysis.bankTenths,
    projectedNextGW: analysis.projectedNextGW,
    projectedNext3: analysis.projectedNext3,
    projectedNext5: analysis.projectedNext5,
    projectedNext10: analysis.projectedNext10,
    startingXI: analysis.startingXI,
    bench: analysis.bench,
    strengths: analysis.strengths,
    weaknesses: analysis.weaknesses.slice(0, 5),
    opportunities: analysis.opportunities.slice(0, 5),
    structuralWarnings: analysis.structuralWarnings,
  };
}

function compactOptimizer(result: OptimizerResult) {
  return {
    legal: result.legal,
    playerIds: result.playerIds,
    errors: result.errors,
    warnings: result.warnings,
    ...(result.analysis ? { analysis: compactAnalysis(result.analysis) } : {}),
  };
}

/**
 * Server adapter for the deterministic FPL engines. Loading is lazy so the
 * offline path never makes a network request, and one chat request shares its
 * cached universe across all tool rounds.
 */
export function createFplToolAdapters(): AIDataAdapters {
  let playersPromise: Promise<readonly Player[]> | undefined;
  const players = async (): Promise<readonly Player[]> => {
    playersPromise ??= Promise.all([getBootstrap(), getFixtures()]).then(async ([bootstrap, fixtures]) => {
      if (!bootstrap.data) throw new Error(bootstrap.error ?? "FPL data is unavailable");
      const normalized = normalizeBootstrap(bootstrap.data, fixtures.data ?? []);
      const [historical, inSeasonForm, playerForm] = await Promise.all([
        loadHistoricalBundle(),
        loadInSeasonTeamXG(normalized.players, normalized.fixtures),
        loadInSeasonPlayerRates(normalized.players, normalized.fixtures),
      ]);
      return enrichPlayersWithHistory(
        normalized.players,
        normalized.teams,
        normalized.events,
        historical,
        inSeasonForm,
        playerForm,
      ).players;
    });
    return playersPromise;
  };

  const options = (context: AnalystContextInput) => ({
    gameweek: context.gameweek,
    horizon: context.strategy.horizon,
    risk: context.strategy.risk,
    bench: context.strategy.bench,
    budgetTenths: context.finances.costTenths + context.finances.bankTenths,
    maxPlayersPerClub: 3,
    lockedPlayerIds: context.squad.lockedPlayerIds,
    excludedPlayerIds: context.squad.excludedPlayerIds,
  });
  const selectedIds = (context: AnalystContextInput) => context.squad.playerIds;

  return {
    searchPlayers: async (input, context) => {
      const universe = await players();
      const query = input.query?.toLowerCase();
      const maxPrice = input.maxPriceTenths ?? (input.onlyAffordable ? context.finances.bankTenths : 2000);
      const result = universe
        .filter((player) => !query || `${player.displayName} ${player.teamShortName}`.toLowerCase().includes(query))
        .filter((player) => !input.position || player.position === input.position)
        .filter((player) => player.priceTenths <= maxPrice)
        .filter((player) => !input.excludeSelected || !selectedIds(context).includes(player.id))
        .filter((player) => !context.squad.excludedPlayerIds?.includes(player.id))
        .slice(0, 20)
        .map((player) => compactPlayer(player, context.gameweek));
      return { count: result.length, players: result };
    },
    getPlayer: async (input, context) => {
      const player = (await players()).find((candidate) => candidate.id === input.playerId);
      return { player: player ? compactPlayer(player, context.gameweek) : null };
    },
    comparePlayers: async (input, context) => {
      const byId = new Map((await players()).map((player) => [player.id, player]));
      return { players: input.playerIds.map((id) => byId.get(id)).filter((player): player is Player => Boolean(player)).map((player) => compactPlayer(player, context.gameweek)) };
    },
    getPlayerFixtures: async (input) => {
      const player = (await players()).find((candidate) => candidate.id === input.playerId);
      return { playerId: input.playerId, fixtures: player?.fixtures.slice(0, input.horizon ?? 5) ?? [] };
    },
    getPlayerProjection: async (input, context) => {
      const player = (await players()).find((candidate) => candidate.id === input.playerId);
      const horizon = input.horizon ?? 5;
      const projection = player ? player.projection ?? projectPlayer(player, { currentGameweek: context.gameweek, horizon }) : undefined;
      return { playerId: input.playerId, horizon, projectedPoints: projection ? (horizon === 1 ? projection.nextGW : horizon === 3 ? projection.next3 : horizon === 5 ? projection.next5 : projection.next10) : null };
    },
    analyzeSquad: async (_, context) => {
      const universe = await players();
      return compactAnalysis(analyzeSquad({ squad: selectedIds(context), players: universe, ...options(context) }));
    },
    findReplacements: async (input, context) => {
      const universe = await players();
      const result = findBestSingleTransfers({ outgoingPlayerId: input.playerId, squad: selectedIds(context), players: universe, ...options(context) });
      return { candidates: result.slice(0, input.limit ?? 5), method: "exact_single_transfer" };
    },
    suggestForSlot: async (input, context) => {
      const universe = await players();
      const result = suggestForSlot({ position: input.position, currentSquad: selectedIds(context), players: universe, ...options(context) });
      return { candidates: result.slice(0, input.limit ?? 5), maxAffordablePriceTenths: result.maxAffordablePriceTenths, minimumRequiredTenths: result.minimumRequiredTenths, message: result.message };
    },
    optimizeSquad: async (_, context) => compactOptimizer(await exactOptimizeFullSquad({ squad: selectedIds(context), players: await players(), ...options(context) })),
    completeSquad: async (_, context) => compactOptimizer(await exactCompletePartialSquad({ squad: selectedIds(context), players: await players(), ...options(context) })),
    optimizeAroundPlayer: async (input, context) => compactOptimizer(await exactOptimizeFullSquad({
      squad: selectedIds(context),
      players: await players(),
      ...options(context),
      lockedPlayerIds: [...new Set([...(context.squad.lockedPlayerIds ?? []), input.playerId])],
    })),
    simulateChange: async (input, context) => {
      const result = simulateChange({ squad: selectedIds(context), players: await players(), outId: input.outId, inId: input.inId, ...options(context) });
      return {
        legal: result.legal,
        horizon: result.horizon,
        optimizedBeforeXp: result.optimizedBeforeXp,
        optimizedAfterXp: result.optimizedAfterXp,
        projectedDelta: result.projectedDelta,
        priceDeltaTenths: result.priceDeltaTenths,
        projectedDeltaGW: result.projectedDeltaGW,
        projectedDelta3: result.projectedDelta3,
        projectedDelta5: result.projectedDelta5,
        projectedDelta10: result.projectedDelta10,
        requiredSecondaryMoves: result.requiredSecondaryMoves,
        explanationFactors: result.explanationFactors,
      };
    },
    pickWeeklyTeam: async (_input, context) => {
      const universe = await players();
      const squad = universe.filter((player) => selectedIds(context).includes(player.id));
      return selectWeeklyTeam({ squad, gameweek: context.gameweek, riskMode: context.strategy.risk });
    },
  };
}

export const createDefaultToolAdapters = createFplToolAdapters;

export interface ToolDefinition {
  schema: z.ZodType;
  description: string;
  handler: ToolHandler;
}

export type ToolRegistry = Record<ToolName, ToolDefinition>;

const toolParameters: Record<ToolName, Record<string, unknown>> = {
  search_players: {
    type: "object",
    properties: {
      query: { type: "string", description: "Name or team text to search for." },
      position: { type: "string", enum: ["GK", "DEF", "MID", "FWD"] },
      maxPriceTenths: { type: "integer", minimum: 0, maximum: 2000 },
      onlyAffordable: { type: "boolean" },
      excludeSelected: { type: "boolean" },
    },
    additionalProperties: false,
  },
  get_player: {
    type: "object",
    properties: { playerId: { type: "integer", minimum: 1 } },
    required: ["playerId"],
    additionalProperties: false,
  },
  compare_players: {
    type: "object",
    properties: { playerIds: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 2, maxItems: 5 } },
    required: ["playerIds"],
    additionalProperties: false,
  },
  get_player_fixtures: {
    type: "object",
    properties: { playerId: { type: "integer", minimum: 1 }, horizon: { type: "integer", enum: [1, 3, 5, 10] } },
    required: ["playerId"],
    additionalProperties: false,
  },
  get_player_projection: {
    type: "object",
    properties: { playerId: { type: "integer", minimum: 1 }, horizon: { type: "integer", enum: [1, 3, 5, 10] } },
    required: ["playerId"],
    additionalProperties: false,
  },
  analyze_squad: { type: "object", properties: {}, additionalProperties: false },
  find_replacements: {
    type: "object",
    properties: { playerId: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 10 } },
    required: ["playerId"],
    additionalProperties: false,
  },
  suggest_for_slot: {
    type: "object",
    properties: {
      position: { type: "string", enum: ["GK", "DEF", "MID", "FWD"] },
      maxPriceTenths: { type: "integer", minimum: 0, maximum: 2000 },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["position"],
    additionalProperties: false,
  },
  optimize_squad: { type: "object", properties: {}, additionalProperties: false },
  complete_squad: { type: "object", properties: {}, additionalProperties: false },
  optimize_around_player: {
    type: "object",
    properties: { playerId: { type: "integer", minimum: 1 } },
    required: ["playerId"],
    additionalProperties: false,
  },
  simulate_change: {
    type: "object",
    properties: { outId: { type: "integer", minimum: 1 }, inId: { type: "integer", minimum: 1 } },
    required: ["outId", "inId"],
    additionalProperties: false,
  },
  choose_captain: { type: "object", properties: {}, additionalProperties: false },
  pick_weekly_team: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const descriptions: Record<ToolName, string> = {
  search_players: "Search the available player universe with compact factual fields.",
  get_player: "Get one player's compact current data, fixtures, and projection.",
  compare_players: "Compare two to five players using application data.",
  get_player_fixtures: "Get a player's upcoming fixtures.",
  get_player_projection: "Get a player's model projection for the requested horizon.",
  analyze_squad: "Analyze the current squad with the deterministic application engine.",
  find_replacements: "Find legal same-position replacements for a player.",
  suggest_for_slot: "Suggest players for an empty position and price slot.",
  optimize_squad: "Find an improved legal squad while respecting locked players.",
  complete_squad: "Complete the current partial squad with a legal optimized team.",
  optimize_around_player: "Find a legal structure around a required player.",
  simulate_change: "Simulate replacing one squad player with another.",
  choose_captain: "Choose a captain from the current squad using projections.",
  pick_weekly_team: "Pick the legal weekly starting XI, bench, captain, and vice-captain from the current squad.",
};

export const TOOL_NAMES = Object.keys(ToolInputSchemas) as ToolName[];

export const TOOL_DEFINITIONS: ChatToolDefinition[] = TOOL_NAMES.map((name) => ({
  type: "function",
  function: { name, description: descriptions[name], parameters: toolParameters[name] },
}));

export const AI_TOOLS = TOOL_DEFINITIONS;

function playersFrom(context: AnalystContextInput) {
  return (context.players ?? []).filter((player) => CompactPlayerSchema.safeParse(player).success);
}

function findPlayer(context: AnalystContextInput, playerId: number) {
  return playersFrom(context).find((player) => player.id === playerId);
}

function projectionFor(player: ReturnType<typeof findPlayer>, horizon: Horizon): number | undefined {
  if (!player?.projection) return undefined;
  return horizon === 1 ? player.projection.nextGW : horizon === 3 ? player.projection.next3 : horizon === 5 ? player.projection.next5 : player.projection.next10;
}

function withAdapter<Name extends ToolName>(
  adapter: ((input: ToolInput<Name>, context: AnalystContextInput) => unknown | Promise<unknown>) | undefined,
  fallback: () => unknown,
  input: ToolInput<Name>,
  context: AnalystContextInput,
) {
  return adapter ? Promise.resolve(adapter(input, context)).then((result) => result ?? fallback()) : fallback();
}

function defaultHandlers(adapters: AIDataAdapters): Record<ToolName, ToolHandler> {
  return {
    search_players: (raw, context) => {
      const input = raw as ToolInput<"search_players">;
      return withAdapter<"search_players">(adapters.searchPlayers, () => {
        const query = input.query?.toLowerCase();
        const maxPrice = input.maxPriceTenths ?? (input.onlyAffordable ? context.finances.bankTenths : 2000);
        const players = playersFrom(context)
          .filter((player) => !query || `${player.displayName} ${player.teamShortName}`.toLowerCase().includes(query))
          .filter((player) => !input.position || player.position === input.position)
          .filter((player) => player.priceTenths <= maxPrice)
          .filter((player) => !input.excludeSelected || !context.squad.playerIds.includes(player.id))
          .slice(0, 20);
        return { count: players.length, players };
      }, input, context);
    },
    get_player: (raw, context) => {
      const input = raw as ToolInput<"get_player">;
      return withAdapter<"get_player">(adapters.getPlayer, () => ({ player: findPlayer(context, input.playerId) ?? null }), input, context);
    },
    compare_players: (raw, context) => {
      const input = raw as ToolInput<"compare_players">;
      return withAdapter<"compare_players">(adapters.comparePlayers, () => ({ players: input.playerIds.map((id) => findPlayer(context, id) ?? { id }) }), input, context);
    },
    get_player_fixtures: (raw, context) => {
      const input = raw as ToolInput<"get_player_fixtures">;
      const horizon = input.horizon ?? context.strategy.horizon;
      return withAdapter<"get_player_fixtures">(adapters.getPlayerFixtures, () => ({ playerId: input.playerId, fixtures: findPlayer(context, input.playerId)?.fixtures?.slice(0, horizon) ?? [] }), input, context);
    },
    get_player_projection: (raw, context) => {
      const input = raw as ToolInput<"get_player_projection">;
      const horizon = input.horizon ?? context.strategy.horizon;
      return withAdapter<"get_player_projection">(adapters.getPlayerProjection, () => ({ playerId: input.playerId, horizon, projectedPoints: projectionFor(findPlayer(context, input.playerId), horizon) ?? null }), input, context);
    },
    analyze_squad: (raw, context) => withAdapter<"analyze_squad">(adapters.analyzeSquad, () => ({ playerIds: context.squad.playerIds, lockedPlayerIds: context.squad.lockedPlayerIds, costTenths: context.finances.costTenths, bankTenths: context.finances.bankTenths, horizon: context.strategy.horizon }), raw as ToolInput<"analyze_squad">, context),
    find_replacements: (raw, context) => {
      const input = raw as ToolInput<"find_replacements">;
      return withAdapter<"find_replacements">(adapters.findReplacements, () => {
        const outgoing = findPlayer(context, input.playerId);
        if (!outgoing) return { playerId: input.playerId, candidates: [] };
        const candidates = playersFrom(context)
          .filter((player) => player.position === outgoing.position && player.id !== outgoing.id && !context.squad.playerIds.includes(player.id))
          .filter((player) => !context.squad.excludedPlayerIds?.includes(player.id))
          .map((player) => ({ player, projectedDelta: (projectionFor(player, context.strategy.horizon) ?? 0) - (projectionFor(outgoing, context.strategy.horizon) ?? 0) }))
          .sort((a, b) => b.projectedDelta - a.projectedDelta)
          .slice(0, input.limit ?? 5);
        return { outgoing, candidates };
      }, input, context);
    },
    suggest_for_slot: (raw, context) => {
      const input = raw as ToolInput<"suggest_for_slot">;
      return withAdapter<"suggest_for_slot">(adapters.suggestForSlot, () => ({
        position: input.position,
        players: playersFrom(context)
          .filter((player) => player.position === input.position && player.priceTenths <= (input.maxPriceTenths ?? context.finances.bankTenths))
          .filter((player) => !context.squad.playerIds.includes(player.id))
          .filter((player) => !context.squad.excludedPlayerIds?.includes(player.id))
          .sort((a, b) => (projectionFor(b, context.strategy.horizon) ?? 0) - (projectionFor(a, context.strategy.horizon) ?? 0))
          .slice(0, input.limit ?? 5),
      }), input, context);
    },
    optimize_squad: (raw, context) => withAdapter<"optimize_squad">(adapters.optimizeSquad, () => ({ status: "unavailable", message: "The squad optimizer is not available in this context." }), raw as ToolInput<"optimize_squad">, context),
    complete_squad: (raw, context) => withAdapter<"complete_squad">(adapters.completeSquad, () => ({ status: "unavailable", message: "The squad optimizer is not available in this context." }), raw as ToolInput<"complete_squad">, context),
    optimize_around_player: (raw, context) => {
      const input = raw as ToolInput<"optimize_around_player">;
      return withAdapter<"optimize_around_player">(adapters.optimizeAroundPlayer, () => ({ status: "unavailable", requiredPlayerId: input.playerId, message: "The squad optimizer is not available in this context." }), input, context);
    },
    simulate_change: (raw, context) => withAdapter<"simulate_change">(adapters.simulateChange, () => ({ status: "unavailable", message: "The simulation engine is not available in this context." }), raw as ToolInput<"simulate_change">, context),
    choose_captain: (raw, context) => withAdapter<"choose_captain">(adapters.chooseCaptain, async () => {
      if (adapters.pickWeeklyTeam) {
        const weekly = await adapters.pickWeeklyTeam({}, context);
        if (weekly && typeof weekly === "object") {
          const plan = weekly as Record<string, unknown>;
          if (typeof plan.captainId === "number" && plan.captainId > 0 && typeof plan.viceCaptainId === "number" && plan.viceCaptainId > 0) {
            return { captainId: plan.captainId, viceCaptainId: plan.viceCaptainId };
          }
        }
      }
      const candidates = context.squad.playerIds.map((id) => findPlayer(context, id)).filter((player): player is NonNullable<typeof player> => Boolean(player));
      const captain = candidates.sort((a, b) => (projectionFor(b, context.strategy.horizon) ?? 0) - (projectionFor(a, context.strategy.horizon) ?? 0))[0];
      return { captainId: captain?.id ?? null, projectedPoints: captain ? projectionFor(captain, context.strategy.horizon) ?? null : null };
    }, raw as ToolInput<"choose_captain">, context),
    pick_weekly_team: (raw, context) => withAdapter<"pick_weekly_team">(adapters.pickWeeklyTeam, () => ({
      status: "unavailable",
      message: "The weekly lineup engine is not available in this context.",
    }), raw as ToolInput<"pick_weekly_team">, context),
  };
}

export function createToolRegistry(adapters: AIDataAdapters = {}): ToolRegistry {
  const handlers = defaultHandlers(adapters);
  return Object.fromEntries(TOOL_NAMES.map((name) => [name, { schema: ToolInputSchemas[name], description: descriptions[name], handler: handlers[name] }])) as unknown as ToolRegistry;
}

const JSON_TOOL_OUTPUT = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string(), z.number(), z.boolean(), z.null()]);

export interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export async function executeTool(
  registry: ToolRegistry,
  name: string,
  rawArguments: string,
  context: AnalystContextInput,
): Promise<ToolExecutionResult> {
  if (!Object.prototype.hasOwnProperty.call(registry, name)) return { ok: false, error: `Unknown tool: ${name}` };
  const tool = registry[name as ToolName];
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  if (rawArguments.length > 10000) return { ok: false, error: "Tool arguments are too large" };

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(rawArguments || "{}");
  } catch {
    return { ok: false, error: "Tool arguments must be valid JSON" };
  }
  const input = tool.schema.safeParse(parsedArguments);
  if (!input.success) return { ok: false, error: "Invalid tool arguments" };
  const safeContext = AnalystContextSchema.safeParse(context);
  if (!safeContext.success) return { ok: false, error: "Invalid analyst context" };

  try {
    const output = await tool.handler(input.data, safeContext.data);
    const safeOutput = JSON_TOOL_OUTPUT.safeParse(output);
    if (!safeOutput.success) return { ok: false, error: "Tool returned an invalid result" };
    return { ok: true, data: safeOutput.data };
  } catch {
    return { ok: false, error: "Tool execution failed" };
  }
}
