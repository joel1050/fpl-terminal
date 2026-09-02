import type { Player, PlayerProjection } from "@/types/player";
import type { PlayerMatchRate, TeamStrength } from "@/types/projection";
import { projectPlayers } from "@/lib/projections/projectPlayer";
import { loadRotowireSelectionData } from "@/lib/availability/loadSelectionData";
import { buildPlayerSelections } from "@/lib/availability/selection";
import type { StartObservation } from "@/lib/availability/startRate";
import { applyInSeasonForm, type TeamMatchXG } from "./inSeasonForm";
import type { HistoricalBundle } from "./types";

export interface EnrichmentTeam {
  id: number;
  strength?: {
    rating?: number;
    attackRating?: number;
    defenceRating?: number;
    overallHome?: number;
    overallAway?: number;
    attackHome?: number;
    attackAway?: number;
    defenceHome?: number;
    defenceAway?: number;
  };
}

export interface EnrichmentEvent {
  id: number;
  finished: boolean;
  isCurrent: boolean;
  isNext: boolean;
}

export interface PlayerEnrichmentMetadata {
  currentGameweek: number;
  historical: {
    available: boolean;
    sourceSeason?: string;
    mappedPlayers: number;
    unresolvedPlayers: number;
  };
  projectionsAttached: number;
  teamStrengths: number;
  teamStrengthFallbacks: number;
}

export interface EnrichedPlayers {
  players: Player[];
  projections: PlayerProjection[];
  teamStrengths: Record<number, TeamStrength>;
  metadata: PlayerEnrichmentMetadata;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function mean(values: number[]): number {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 1;
}

function consensusRatio(rating: number | undefined): number | undefined {
  return rating !== undefined && rating >= 1 && rating <= 5 ? 0.76 + rating * 0.08 : undefined;
}

/**
 * Normalizes each team's value against the mean of only its own source
 * (manual consensus vs. raw FPL fallback fields). Consensus ratios
 * (~0.84-1.16) and raw FPL fields (which can run in the hundreds) live on
 * different scales, so averaging them together would crush whichever group
 * is a minority into the other group's scale. Normalizing within-source
 * first keeps both groups centred on 1.0 independently before they are
 * merged into one Record.
 */
function normalizeBySource(items: { value: number; isFallback: boolean }[]): number[] {
  const consensusMean = mean(items.filter((item) => !item.isFallback).map((item) => item.value));
  const fallbackMean = mean(items.filter((item) => item.isFallback).map((item) => item.value));
  return items.map((item) => item.value / (item.isFallback ? fallbackMean : consensusMean));
}

/** Converts live FPL ratings to ratios centred on 1.0 for fixture adjustment. */
export function deriveTeamStrengths(
  teams: readonly EnrichmentTeam[],
): { strengths: Record<number, TeamStrength>; fallbackCount: number } {
  const raw = teams.map((team) => {
    const strength = team.strength;
    const overallConsensus = consensusRatio(strength?.rating);
    // Attack/defence consensus falls back to the overall rating when a team
    // has a manual overall tier but no separate attack/defence split yet.
    const attackConsensus = consensusRatio(strength?.attackRating) ?? overallConsensus;
    const defenceConsensus = consensusRatio(strength?.defenceRating) ?? overallConsensus;

    const overallHome = overallConsensus ?? finiteOr(strength?.overallHome, 1);
    const overallAway = overallConsensus ?? finiteOr(strength?.overallAway, overallHome);
    const attackHome = attackConsensus ?? finiteOr(strength?.attackHome, overallHome);
    const attackAway = attackConsensus ?? finiteOr(strength?.attackAway, overallAway);
    const defenceHome = defenceConsensus ?? finiteOr(strength?.defenceHome, overallHome);
    const defenceAway = defenceConsensus ?? finiteOr(strength?.defenceAway, overallAway);

    const missingRawField = (value: number | undefined) => value === undefined || value <= 0;
    const fallbackCount = [
      overallConsensus === undefined && missingRawField(strength?.overallHome),
      overallConsensus === undefined && missingRawField(strength?.overallAway),
      attackConsensus === undefined && missingRawField(strength?.attackHome),
      attackConsensus === undefined && missingRawField(strength?.attackAway),
      defenceConsensus === undefined && missingRawField(strength?.defenceHome),
      defenceConsensus === undefined && missingRawField(strength?.defenceAway),
    ].filter(Boolean).length;

    return {
      team,
      overallHome,
      overallAway,
      attackHome,
      attackAway,
      defenceHome,
      defenceAway,
      overallIsFallback: overallConsensus === undefined,
      attackIsFallback: attackConsensus === undefined,
      defenceIsFallback: defenceConsensus === undefined,
      fallbackCount,
    };
  });

  const overallHome = normalizeBySource(raw.map((item) => ({ value: item.overallHome, isFallback: item.overallIsFallback })));
  const overallAway = normalizeBySource(raw.map((item) => ({ value: item.overallAway, isFallback: item.overallIsFallback })));
  const attackHome = normalizeBySource(raw.map((item) => ({ value: item.attackHome, isFallback: item.attackIsFallback })));
  const attackAway = normalizeBySource(raw.map((item) => ({ value: item.attackAway, isFallback: item.attackIsFallback })));
  const defenceHome = normalizeBySource(raw.map((item) => ({ value: item.defenceHome, isFallback: item.defenceIsFallback })));
  const defenceAway = normalizeBySource(raw.map((item) => ({ value: item.defenceAway, isFallback: item.defenceIsFallback })));

  const strengths: Record<number, TeamStrength> = {};
  raw.forEach((item, index) => {
    strengths[item.team.id] = {
      teamId: item.team.id,
      attackHome: attackHome[index],
      attackAway: attackAway[index],
      defenceHome: defenceHome[index],
      defenceAway: defenceAway[index],
      overall: (overallHome[index] + overallAway[index]) / 2,
    };
  });
  return {
    strengths,
    fallbackCount: raw.reduce((sum, item) => sum + item.fallbackCount, 0),
  };
}

function currentGameweek(events: readonly EnrichmentEvent[]): number {
  return (
    events.find((event) => event.isCurrent)?.id ??
    events.find((event) => event.isNext)?.id ??
    events.find((event) => !event.finished)?.id ??
    1
  );
}

export function enrichPlayersWithHistory(
  players: readonly Player[],
  teams: readonly EnrichmentTeam[],
  events: readonly EnrichmentEvent[],
  historical: HistoricalBundle | null,
  inSeasonForm?: Record<number, readonly TeamMatchXG[]>,
  playerForm?: Record<number, readonly PlayerMatchRate[]>,
  startHistory?: Record<number, readonly StartObservation[]>,
): EnrichedPlayers {
  const historicalById = new Map(
    (historical?.players ?? []).map((player) => [player.historicalPlayerId, player]),
  );
  const mappingByCurrentId = new Map(
    (historical?.playerMappings ?? []).map((mapping) => [mapping.currentPlayerId, mapping]),
  );
  let mappedPlayers = 0;
  let unresolvedPlayers = 0;
  const enrichedPlayers = players.map((player) => {
    const mapping = mappingByCurrentId.get(player.id);
    const historicalPlayer = mapping?.historicalPlayerId
      ? historicalById.get(mapping.historicalPlayerId)
      : undefined;
    if (historicalPlayer) mappedPlayers += 1;
    else unresolvedPlayers += 1;
    return historicalPlayer
      ? { ...player, historical: historicalPlayer.stats }
      : { ...player, historical: undefined };
  });
  const { strengths: priorStrengths, fallbackCount } = deriveTeamStrengths(teams);
  const strengths = inSeasonForm ? applyInSeasonForm(priorStrengths, inSeasonForm) : priorStrengths;
  const gw = currentGameweek(events);
  const selections = buildPlayerSelections(enrichedPlayers, {
    rotowire: loadRotowireSelectionData(),
    historical,
    startHistory,
  });
  const selectedPlayers = enrichedPlayers.map((player) => ({
    ...player,
    selection: selections.get(player.id),
  }));
  const projections = projectPlayers(selectedPlayers, {
    horizon: 5,
    fixtureHorizon: 39 - gw,
    currentGameweek: gw,
    teamStrengths: strengths,
    playerForm,
  });
  return {
    players: selectedPlayers.map((player, index) => ({
      ...player,
      projection: projections[index],
    })),
    projections,
    teamStrengths: strengths,
    metadata: {
      currentGameweek: gw,
      historical: {
        available: historical !== null,
        sourceSeason: historical?.sourceSeason,
        mappedPlayers,
        unresolvedPlayers,
      },
      projectionsAttached: projections.filter(Boolean).length,
      teamStrengths: Object.keys(strengths).length,
      teamStrengthFallbacks: fallbackCount,
    },
  };
}
