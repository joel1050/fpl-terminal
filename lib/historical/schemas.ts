import { z } from "zod";

const nullableNumber = z.number().optional();

export const HistoricalStatsSchema = z.object({
  season: z.string(),
  minutes: z.number(),
  starts: nullableNumber,
  totalPoints: nullableNumber,
  goals: nullableNumber,
  assists: nullableNumber,
  cleanSheets: nullableNumber,
  saves: nullableNumber,
  bonus: nullableNumber,
  bps: nullableNumber,
  influence: nullableNumber,
  creativity: nullableNumber,
  threat: nullableNumber,
  expectedGoals: nullableNumber,
  expectedAssists: nullableNumber,
  xGIPer90: nullableNumber,
  pointsPer90: nullableNumber,
  defensiveContribution: nullableNumber,
});

export const HistoricalPlayerSchema = z.object({
  historicalPlayerId: z.number().int(),
  code: z.number().int().optional(),
  displayName: z.string(),
  teamName: z.string().optional(),
  position: z.enum(["GK", "DEF", "MID", "FWD"]).optional(),
  stats: HistoricalStatsSchema,
});

export const HistoricalMatchStatSchema = z.object({
  historicalPlayerId: z.number().int(),
  gameweek: z.number().int(),
  fixtureId: z.number().int().optional(),
  opponentTeamId: z.number().int().optional(),
  minutes: z.number(),
  totalPoints: z.number(),
  goals: z.number(),
  assists: z.number(),
  expectedGoals: z.number().optional(),
  expectedAssists: z.number().optional(),
  bonus: z.number(),
  bps: z.number(),
  wasHome: z.boolean().optional(),
});

export const HistoricalTeamStrengthSchema = z.object({
  teamId: z.number().int(),
  name: z.string(),
  shortName: z.string(),
  overallHome: z.number().optional(),
  overallAway: z.number().optional(),
  attackHome: z.number().optional(),
  attackAway: z.number().optional(),
  defenceHome: z.number().optional(),
  defenceAway: z.number().optional(),
});

export const PlayerMappingSchema = z.object({
  currentPlayerId: z.number().int(),
  historicalPlayerId: z.number().int().optional(),
  confidence: z.enum(["EXACT", "LIKELY", "UNRESOLVED"]),
});

export const HistoricalBundleSchema = z.object({
  players: z.array(HistoricalPlayerSchema),
  matchStats: z.array(HistoricalMatchStatSchema),
  teamStrength: z.array(HistoricalTeamStrengthSchema),
  playerMappings: z.array(PlayerMappingSchema),
  generatedAt: z.string().optional(),
  sourceSeason: z.string(),
});
