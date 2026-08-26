import { z } from "zod";

const numberLike = z.union([z.number(), z.string()]);
const nullableNumberLike = numberLike.nullable().optional();

export const FplTeamSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    short_name: z.string(),
    code: z.number().int().optional(),
    strength_overall_home: z.number().optional(),
    strength_overall_away: z.number().optional(),
    strength_attack_home: z.number().optional(),
    strength_attack_away: z.number().optional(),
    strength_defence_home: z.number().optional(),
    strength_defence_away: z.number().optional(),
  })
  .passthrough();

export const FplEventSchema = z
  .object({
    id: z.number().int(),
    name: z.string().optional(),
    deadline_time: z.string().nullable().optional(),
    finished: z.boolean().optional(),
    data_checked: z.boolean().optional(),
    is_previous: z.boolean().optional(),
    is_current: z.boolean().optional(),
    is_next: z.boolean().optional(),
    average_entry_score: z.number().optional(),
  })
  .passthrough();

export const FplElementTypeSchema = z
  .object({
    id: z.number().int(),
    plural_name: z.string().optional(),
    plural_name_short: z.string().optional(),
    singular_name: z.string().optional(),
    singular_name_short: z.string().optional(),
    squad_select: z.number().int().optional(),
    squad_min_play: z.number().int().optional(),
    squad_max_play: z.number().int().optional(),
  })
  .passthrough();

export const FplElementSchema = z
  .object({
    id: z.number().int(),
    code: z.number().int().optional(),
    opta_code: z.string().nullable().optional(),
    first_name: z.string().optional(),
    second_name: z.string().optional(),
    web_name: z.string().optional(),
    team: z.number().int(),
    element_type: z.number().int(),
    now_cost: z.number(),
    selected_by_percent: numberLike.optional(),
    status: z.string().optional(),
    news: z.string().optional(),
    chance_of_playing_next_round: nullableNumberLike,
    chance_of_playing_this_round: nullableNumberLike,
    total_points: z.number().optional(),
    points_per_game: numberLike.optional(),
    form: numberLike.optional(),
    minutes: z.number().optional(),
    starts: z.number().optional(),
    goals_scored: z.number().optional(),
    assists: z.number().optional(),
    clean_sheets: z.number().optional(),
    bonus: z.number().optional(),
    bps: z.number().optional(),
    saves: z.number().optional(),
    expected_goals: numberLike.optional(),
    expected_assists: numberLike.optional(),
    defensive_contribution: z.number().optional(),
    yellow_cards: z.number().optional(),
    red_cards: z.number().optional(),
  })
  .passthrough();

export const FplBootstrapSchema = z
  .object({
    events: z.array(FplEventSchema),
    teams: z.array(FplTeamSchema),
    element_types: z.array(FplElementTypeSchema),
    elements: z.array(FplElementSchema),
    total_players: z.number().optional(),
  })
  .passthrough();

export const FplFixtureSchema = z
  .object({
    id: z.number().int(),
    code: z.number().int().optional(),
    event: z.number().int().nullable().optional(),
    finished: z.boolean().optional(),
    finished_provisional: z.boolean().optional(),
    kickoff_time: z.string().nullable().optional(),
    minutes: z.number().optional(),
    provisional_start_time: z.boolean().optional(),
    started: z.boolean().optional(),
    team_a: z.number().int(),
    team_a_score: z.number().nullable().optional(),
    team_h: z.number().int(),
    team_h_score: z.number().nullable().optional(),
    stats: z.array(z.unknown()).optional(),
    team_h_difficulty: z.number().optional(),
    team_a_difficulty: z.number().optional(),
  })
  .passthrough();

export const FplFixturesSchema = z.array(FplFixtureSchema);

export const FplPlayerFixtureSchema = z
  .object({
    id: z.number().int(),
    code: z.number().int().optional(),
    team_h: z.number().int(),
    team_a: z.number().int(),
    event: z.number().int().nullable().optional(),
    finished: z.boolean().optional(),
    minutes: z.number().optional(),
    kickoff_time: z.string().nullable().optional(),
    event_name: z.string().optional(),
    is_home: z.boolean(),
    difficulty: z.number().optional(),
  })
  .passthrough();

export const FplHistoryRowSchema = z
  .object({
    element: z.number().int().optional(),
    fixture: z.number().int().optional(),
    opponent_team: z.number().int().optional(),
    total_points: z.number().optional(),
    minutes: z.number().optional(),
    kickoff_time: z.string().nullable().optional(),
    round: z.number().int().optional(),
  })
  .passthrough();

export const FplPastSeasonRowSchema = z
  .object({
    season_name: z.string(),
    element_code: z.number().int().optional(),
    total_points: z.number().optional(),
    minutes: z.number().optional(),
  })
  .passthrough();

export const FplPlayerSummarySchema = z
  .object({
    fixtures: z.array(FplPlayerFixtureSchema),
    history: z.array(FplHistoryRowSchema),
    history_past: z.array(FplPastSeasonRowSchema),
  })
  .passthrough();

export const FplLiveElementSchema = z
  .object({
    id: z.number().int(),
    stats: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
    explain: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const FplLiveResponseSchema = z.object({
  elements: z.array(FplLiveElementSchema),
});

export const FplLeagueRefSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().optional(),
  short_name: z.string().nullable().optional(),
  league_type: z.union([z.number(), z.string()]).optional(),
  rank: nullableNumberLike,
  entry_rank: nullableNumberLike,
  entry_last_rank: nullableNumberLike,
  size: nullableNumberLike,
  entry_count: nullableNumberLike,
  rank_count: nullableNumberLike,
  closed: z.boolean().optional(),
}).passthrough();

export const FplCupLeagueRefSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().optional(),
  stage: numberLike.nullable().optional(),
}).passthrough();

/** FPL sends the cup as one object with matches and a qualification status. */
export const FplEntryCupSchema = z.object({
  matches: z.array(z.unknown()).optional(),
  status: z.unknown().optional(),
  cup_league: nullableNumberLike,
}).passthrough();

export const FplEntrySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().optional(),
  player_first_name: z.string().optional(),
  player_last_name: z.string().optional(),
  player_region_id: nullableNumberLike,
  player_region_name: z.string().nullable().optional(),
  player_region_iso_code_short: z.string().nullable().optional(),
  joined_time: z.string().nullable().optional(),
  started_event: nullableNumberLike,
  years_active: nullableNumberLike,
  favourite_team: nullableNumberLike,
  current_event: nullableNumberLike,
  summary_overall_points: nullableNumberLike,
  summary_overall_rank: nullableNumberLike,
  summary_event_points: nullableNumberLike,
  summary_event_rank: nullableNumberLike,
  last_deadline_bank: nullableNumberLike,
  last_deadline_value: nullableNumberLike,
  last_deadline_total_transfers: nullableNumberLike,
  leagues: z.object({
    classic: z.array(FplLeagueRefSchema.passthrough()).optional(),
    h2h: z.array(FplLeagueRefSchema.passthrough()).optional(),
    cup: z.union([z.array(FplCupLeagueRefSchema), FplEntryCupSchema]).optional(),
  }).passthrough().optional(),
}).passthrough();

export const FplEntryHistoryRowSchema = z.object({
  event: z.number().int().positive(),
  points: nullableNumberLike,
  total_points: nullableNumberLike,
  rank: nullableNumberLike,
  rank_sort: nullableNumberLike,
  overall_rank: nullableNumberLike,
  percentile_rank: nullableNumberLike,
  bank: nullableNumberLike,
  value: nullableNumberLike,
  event_transfers: nullableNumberLike,
  event_transfers_cost: nullableNumberLike,
  points_on_bench: nullableNumberLike,
}).passthrough();

export const FplEntryHistorySchema = z.object({
  chips: z.array(z.object({ name: z.string().optional(), event: nullableNumberLike }).passthrough()).optional(),
  current: z.array(FplEntryHistoryRowSchema),
  past: z.array(z.object({
    season_name: z.string(),
    total_points: nullableNumberLike,
    rank: nullableNumberLike,
  }).passthrough()).optional(),
}).passthrough();

export const FplEntryPicksSchema = z.object({
  entry_history: z.object({
    event: nullableNumberLike,
    points: nullableNumberLike,
    total_points: nullableNumberLike,
    rank: nullableNumberLike,
    rank_sort: nullableNumberLike,
    overall_rank: nullableNumberLike,
    percentile_rank: nullableNumberLike,
    bank: nullableNumberLike,
    value: nullableNumberLike,
    event_transfers: nullableNumberLike,
    event_transfers_cost: nullableNumberLike,
    points_on_bench: nullableNumberLike,
  }).passthrough().optional(),
  active_chip: z.string().nullable().optional(),
  automatic_subs: z.array(z.object({
    element_in: z.number().int().positive(),
    element_out: z.number().int().positive(),
    event: z.number().int().positive().optional(),
  }).passthrough()).optional(),
  picks: z.array(z.object({
    element: z.number().int().positive(),
    position: z.number().int().min(1).max(15),
    element_type: z.number().int().min(1).max(4),
    multiplier: z.number().int().optional(),
    is_captain: z.boolean().optional(),
    is_vice_captain: z.boolean().optional(),
  }).passthrough()),
}).passthrough();

export const FplClassicStandingRowSchema = z.object({
  entry: z.number().int().positive(),
  entry_name: z.string().nullable().optional(),
  player_name: z.string().nullable().optional(),
  rank: nullableNumberLike,
  last_rank: nullableNumberLike,
  total: nullableNumberLike,
  event_total: nullableNumberLike,
}).passthrough();

export const FplClassicLeagueStandingsSchema = z.object({
  league: z.object({
    id: z.number().int().positive(),
    name: z.string().nullable().optional(),
    short_name: z.string().nullable().optional(),
    league_type: z.union([z.number(), z.string()]).optional(),
    closed: z.boolean().optional(),
  }).passthrough(),
  standings: z.object({
    page: nullableNumberLike,
    has_next: z.boolean().nullable().optional(),
    results: z.array(FplClassicStandingRowSchema),
  }).passthrough(),
}).passthrough();

export const BootstrapStaticSchema = FplBootstrapSchema;
export const FixturesSchema = FplFixturesSchema;
export const PlayerSummarySchema = FplPlayerSummarySchema;
export const LiveGameweekSchema = FplLiveResponseSchema;

export type FplBootstrapPayload = z.infer<typeof FplBootstrapSchema>;
export type FplFixturePayload = z.infer<typeof FplFixturesSchema>;
export type FplPlayerSummaryPayload = z.infer<typeof FplPlayerSummarySchema>;
export type FplLiveResponsePayload = z.infer<typeof FplLiveResponseSchema>;
export type FplEntryPayload = z.infer<typeof FplEntrySchema>;
export type FplEntryHistoryPayload = z.infer<typeof FplEntryHistorySchema>;
export type FplEntryPicksPayload = z.infer<typeof FplEntryPicksSchema>;
export type FplClassicLeagueStandingsPayload = z.infer<typeof FplClassicLeagueStandingsSchema>;

export function parseExternal<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  source: string,
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = `${source} response did not match the expected shape${issue ? ` at ${issue.path.join(".")}: ${issue.message}` : ""}`;
    if (process.env.NODE_ENV !== "production") console.warn(message);
    throw new Error(message);
  }
  return parsed.data;
}
