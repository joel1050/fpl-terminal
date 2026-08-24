import type {
  AutomaticSub,
  ClassicLeagueStandings,
  ClassicStandingRow,
  EntryChipUsage,
  EntryHistoryRow,
  EntryPick,
  EntryPicks,
  EntrySeasonRow,
  ManagerHistory,
  ManagerProfile,
} from "@/types/leagues";
import type {
  FplClassicLeagueStandingsPayload,
  FplEntryHistoryPayload,
  FplEntryPicksPayload,
  FplEntryPayload,
} from "./schemas";
import { optionalNumber } from "./normalize";

export function normalizeManagerProfile(payload: FplEntryPayload): ManagerProfile {
  return {
    entryId: payload.id,
    name: payload.name,
    playerFirstName: payload.player_first_name,
    playerLastName: payload.player_last_name,
    playerRegionId: optionalNumber(payload.player_region_id),
    playerRegionName: payload.player_region_name ?? undefined,
    playerRegionIsoCodeShort: payload.player_region_iso_code_short ?? undefined,
    joinedTime: payload.joined_time ?? undefined,
    startedEvent: optionalNumber(payload.started_event),
    yearsActive: optionalNumber(payload.years_active),
    favouriteTeamId: optionalNumber(payload.favourite_team),
    currentEvent: optionalNumber(payload.current_event),
    summaryOverallPoints: optionalNumber(payload.summary_overall_points),
    summaryOverallRank: optionalNumber(payload.summary_overall_rank),
    summaryEventPoints: optionalNumber(payload.summary_event_points),
    summaryEventRank: optionalNumber(payload.summary_event_rank),
    lastDeadlineBank: optionalNumber(payload.last_deadline_bank),
    lastDeadlineValue: optionalNumber(payload.last_deadline_value),
    lastDeadlineTotalTransfers: optionalNumber(payload.last_deadline_total_transfers),
    leagues: {
      classic: (payload.leagues?.classic ?? []).map((league) => ({
        id: league.id,
        name: league.name ?? `League ${league.id}`,
        leagueType: league.league_type,
        rank: optionalNumber(league.entry_rank) ?? optionalNumber(league.rank),
        entryRank: optionalNumber(league.entry_rank),
        entryLastRank: optionalNumber(league.entry_last_rank),
        size: optionalNumber(league.size) ?? optionalNumber(league.entry_count) ?? optionalNumber(league.rank_count),
        entryCount: optionalNumber(league.entry_count) ?? optionalNumber(league.rank_count),
        closed: league.closed,
      })),
      h2h: (payload.leagues?.h2h ?? []).map((league) => ({
        id: league.id,
        name: league.name ?? `League ${league.id}`,
        leagueType: league.league_type,
        rank: optionalNumber(league.entry_rank) ?? optionalNumber(league.rank),
        entryRank: optionalNumber(league.entry_rank),
        entryLastRank: optionalNumber(league.entry_last_rank),
        size: optionalNumber(league.size) ?? optionalNumber(league.entry_count) ?? optionalNumber(league.rank_count),
        entryCount: optionalNumber(league.entry_count) ?? optionalNumber(league.rank_count),
        closed: league.closed,
      })),
      cup: (Array.isArray(payload.leagues?.cup) ? payload.leagues.cup : []).map((cup) => ({
        id: cup.id,
        name: cup.name ?? `Cup ${cup.id}`,
        stage: optionalNumber(cup.stage),
      })),
    },
  };
}

function historyRow(raw: FplEntryHistoryPayload["current"][number]): EntryHistoryRow {
  return {
    event: raw.event,
    points: optionalNumber(raw.points),
    totalPoints: optionalNumber(raw.total_points),
    rank: optionalNumber(raw.rank),
    rankSort: optionalNumber(raw.rank_sort),
    overallRank: optionalNumber(raw.overall_rank),
    percentileRank: raw.percentile_rank ?? undefined,
    bank: optionalNumber(raw.bank),
    value: optionalNumber(raw.value),
    eventTransfers: optionalNumber(raw.event_transfers),
    eventTransfersCost: optionalNumber(raw.event_transfers_cost),
    pointsOnBench: optionalNumber(raw.points_on_bench),
  };
}

export function normalizeManagerHistory(entryId: number, payload: FplEntryHistoryPayload): ManagerHistory {
  const chips: EntryChipUsage[] = (payload.chips ?? []).map((chip) => ({
    name: chip.name ?? "unknown",
    event: optionalNumber(chip.event),
  }));
  const current: EntryHistoryRow[] = payload.current.map(historyRow);
  const past: EntrySeasonRow[] = (payload.past ?? []).map((season) => ({
    seasonName: season.season_name,
    totalPoints: optionalNumber(season.total_points),
    rank: optionalNumber(season.rank),
  }));
  return { entryId, chips, current, past };
}

export function normalizeEntryPicks(
  entryId: number,
  gameweek: number,
  payload: FplEntryPicksPayload,
): EntryPicks {
  const picks: EntryPick[] = [...payload.picks]
    .sort((left, right) => left.position - right.position)
    .map((pick) => ({
      element: pick.element,
      position: pick.position,
      elementType: pick.element_type,
      multiplier: pick.multiplier ?? 0,
      isCaptain: pick.is_captain ?? false,
      isViceCaptain: pick.is_vice_captain ?? false,
    }));
  const automaticSubs: AutomaticSub[] = (payload.automatic_subs ?? []).map((sub) => ({
    elementIn: sub.element_in,
    elementOut: sub.element_out,
    event: sub.event,
  }));
  const history = payload.entry_history;
  return {
    entryId,
    gameweek,
    points: optionalNumber(history?.points),
    activeChip: payload.active_chip ?? null,
    automaticSubs,
    picks,
    entryHistory: history
      ? {
          event: optionalNumber(history.event),
          points: optionalNumber(history.points),
          totalPoints: optionalNumber(history.total_points),
          eventTransfersCost: optionalNumber(history.event_transfers_cost),
          pointsOnBench: optionalNumber(history.points_on_bench),
          bank: optionalNumber(history.bank),
          value: optionalNumber(history.value),
          overallRank: optionalNumber(history.overall_rank),
          rank: optionalNumber(history.rank),
          percentileRank: history.percentile_rank ?? undefined,
        }
      : undefined,
  };
}

export function normalizeClassicLeagueStandings(payload: FplClassicLeagueStandingsPayload): ClassicLeagueStandings {
  const results: ClassicStandingRow[] = payload.standings.results.map((row) => ({
    entryId: row.entry,
    entryName: row.entry_name ?? undefined,
    playerName: row.player_name ?? undefined,
    rank: optionalNumber(row.rank),
    lastRank: optionalNumber(row.last_rank),
    total: optionalNumber(row.total),
    eventTotal: optionalNumber(row.event_total),
  }));
  return {
    league: {
      id: payload.league.id,
      name: payload.league.name ?? undefined,
      shortName: payload.league.short_name ?? undefined,
      leagueType: payload.league.league_type,
      closed: payload.league.closed,
    },
    page: optionalNumber(payload.standings.page) ?? 1,
    hasNext: payload.standings.has_next ?? false,
    results,
  };
}
