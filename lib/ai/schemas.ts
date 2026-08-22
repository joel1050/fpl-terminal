import { z } from "zod";

const idSchema = z.number().int().positive();
const positionSchema = z.enum(["GK", "DEF", "MID", "FWD"]);
const priceSchema = z.number().int().nonnegative().max(2000);

export const CompactFixtureSchema = z.object({
  gameweek: z.number().int().nonnegative(),
  opponentTeamId: idSchema,
  opponentShortName: z.string().max(20),
  isHome: z.boolean(),
  difficulty: z.number().finite().optional(),
});

export const CompactPlayerSchema = z.object({
  id: idSchema,
  displayName: z.string().min(1).max(100),
  position: positionSchema,
  priceTenths: priceSchema,
  teamId: idSchema,
  teamShortName: z.string().max(20),
  status: z.string().max(40).optional(),
  chanceOfPlaying: z.number().min(0).max(100).nullable().optional(),
  fixtures: z.array(CompactFixtureSchema).max(10).optional(),
  projection: z
    .object({
      nextGW: z.number().finite().optional(),
      next3: z.number().finite().optional(),
      next5: z.number().finite().optional(),
      expectedMinutes: z.number().finite().optional(),
      valueNext5: z.number().finite().optional(),
      riskScore: z.number().finite().optional(),
      confidence: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
    })
    .optional(),
});

export const AnalystContextSchema = z
  .object({
    gameweek: z.number().int().nonnegative(),
    squad: z.object({
      playerIds: z.array(idSchema).max(15),
      lockedPlayerIds: z.array(idSchema).max(15),
      excludedPlayerIds: z.array(idSchema).max(100).optional(),
      captainId: idSchema.optional(),
      viceCaptainId: idSchema.optional(),
    }),
    finances: z.object({
      costTenths: priceSchema,
      bankTenths: z.number().int().nonnegative().max(2000),
    }),
    strategy: z.object({
      horizon: z.union([z.literal(1), z.literal(3), z.literal(5)]),
      risk: z.enum(["SAFE", "BALANCED", "AGGRESSIVE"]),
      bench: z.enum(["CHEAP", "BALANCED", "STRONG"]),
    }),
    // The normal request only sends squad state. A compact player list is
    // accepted for local/testing adapters and is never sent to the browser.
    players: z.array(CompactPlayerSchema).max(1000).optional(),
  })
  .strict();

export const AnalystActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("VIEW_PLAYER"), playerId: idSchema }).strict(),
  z
    .object({
      type: z.literal("SIMULATE_TRANSFER"),
      outId: idSchema,
      inId: idSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("APPLY_TRANSFER"),
      outId: idSchema,
      inId: idSchema,
    })
    .strict(),
  z.object({ type: z.literal("LOCK_PLAYER"), playerId: idSchema }).strict(),
  z.object({ type: z.literal("OPTIMIZE" ) }).strict(),
  z
    .object({
      type: z.literal("APPLY_WEEKLY_LINEUP"),
      gameweek: idSchema,
      starterIds: z.array(idSchema).length(11),
      benchGoalkeeperId: idSchema,
      benchOrder: z.array(idSchema).length(3),
      captainId: idSchema,
      viceCaptainId: idSchema,
      projectionFingerprint: z.string().min(1).max(256),
    })
    .strict(),
]);

export const AnalystResponseSchema = z
  .object({
    message: z.string().max(10000),
    actions: z.array(AnalystActionSchema).max(20).optional(),
  })
  .strict();

export const AIResponseSchema = AnalystResponseSchema;
export const AIActionSchema = AnalystActionSchema;

export const AIRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    context: AnalystContextSchema.optional(),
    mode: z.enum(["normal", "thinking"]).optional(),
    // `thinking` is kept as a small compatibility affordance for clients
    // that expose a checkbox instead of a mode selector.
    thinking: z.boolean().optional(),
  })
  .strict();

export const ToolInputSchemas = {
  search_players: z
    .object({
      query: z.string().trim().max(100).optional(),
      position: positionSchema.optional(),
      maxPriceTenths: priceSchema.optional(),
      onlyAffordable: z.boolean().optional(),
      excludeSelected: z.boolean().optional(),
    })
    .strict(),
  get_player: z.object({ playerId: idSchema }).strict(),
  compare_players: z
    .object({ playerIds: z.array(idSchema).min(2).max(5) })
    .strict(),
  get_player_fixtures: z
    .object({ playerId: idSchema, horizon: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional() })
    .strict(),
  get_player_projection: z
    .object({ playerId: idSchema, horizon: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional() })
    .strict(),
  analyze_squad: z.object({}).strict(),
  find_replacements: z
    .object({
      playerId: idSchema,
      limit: z.number().int().positive().max(10).optional(),
    })
    .strict(),
  suggest_for_slot: z
    .object({
      position: positionSchema,
      maxPriceTenths: priceSchema.optional(),
      limit: z.number().int().positive().max(10).optional(),
    })
    .strict(),
  optimize_squad: z.object({}).strict(),
  complete_squad: z.object({}).strict(),
  optimize_around_player: z.object({ playerId: idSchema }).strict(),
  simulate_change: z
    .object({ outId: idSchema, inId: idSchema })
    .strict(),
  choose_captain: z.object({}).strict(),
  pick_weekly_team: z.object({}).strict(),
} as const;

export type AnalystContextInput = z.infer<typeof AnalystContextSchema>;
export type AIRequest = z.infer<typeof AIRequestSchema>;
export type AnalystAction = z.infer<typeof AnalystActionSchema>;
export type AnalystResponse = z.infer<typeof AnalystResponseSchema>;
export type ToolName = keyof typeof ToolInputSchemas;

export const DEFAULT_ANALYST_CONTEXT: AnalystContextInput = {
  gameweek: 1,
  squad: { playerIds: [], lockedPlayerIds: [] },
  finances: { costTenths: 0, bankTenths: 1000 },
  strategy: { horizon: 5, risk: "BALANCED", bench: "BALANCED" },
};

export const DeepSeekToolCallSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1).max(100),
    arguments: z.string().max(10000),
  }),
});

export const DeepSeekMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(DeepSeekToolCallSchema).optional(),
  reasoning_content: z.string().nullable().optional(),
});
