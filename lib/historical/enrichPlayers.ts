import type { Player, PlayerProjection } from "@/types/player";
import type { TeamStrength } from "@/types/projection";
import { projectPlayers } from "@/lib/projections/projectPlayer";
import { loadRotowireSelectionData } from "@/lib/availability/loadSelectionData";
import { buildPlayerSelections } from "@/lib/availability/selection";
import type { HistoricalBundle } from "./types";

export interface EnrichmentTeam {
  id: number;
  strength?: {
    rating?: number;
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

/** Converts live FPL ratings to ratios centred on 1.0 for fixture adjustment. */
export function deriveTeamStrengths(
  teams: readonly EnrichmentTeam[],
): { strengths: Record<number, TeamStrength>; fallbackCount: number } {
  const raw = teams.map((team) => {
    const strength = team.strength;
    const consensus = strength?.rating && strength.rating >= 1 && strength.rating <= 5
      ? 0.76 + strength.rating * 0.08
      : undefined;
    const overallHome = consensus ?? finiteOr(strength?.overallHome, 1);
    const overallAway = consensus ?? finiteOr(strength?.overallAway, overallHome);
    const attackHome = consensus ?? finiteOr(strength?.attackHome, overallHome);
    const attackAway = consensus ?? finiteOr(strength?.attackAway, overallAway);
    const defenceHome = consensus ?? finiteOr(strength?.defenceHome, overallHome);
    const defenceAway = consensus ?? finiteOr(strength?.defenceAway, overallAway);
    const fallbackCount = consensus === undefined ? [
      strength?.attackHome,
      strength?.attackAway,
      strength?.defenceHome,
      strength?.defenceAway,
    ].filter((value) => value === undefined || value <= 0).length : 0;
    return {
      team,
      overallHome,
      overallAway,
      attackHome,
      attackAway,
      defenceHome,
      defenceAway,
      fallbackCount,
    };
  });
  const averages = {
    overallHome: mean(raw.map((item) => item.overallHome)),
    overallAway: mean(raw.map((item) => item.overallAway)),
    attackHome: mean(raw.map((item) => item.attackHome)),
    attackAway: mean(raw.map((item) => item.attackAway)),
    defenceHome: mean(raw.map((item) => item.defenceHome)),
    defenceAway: mean(raw.map((item) => item.defenceAway)),
  };
  const strengths: Record<number, TeamStrength> = {};
  for (const item of raw) {
    strengths[item.team.id] = {
      teamId: item.team.id,
      attackHome: item.attackHome / averages.attackHome,
      attackAway: item.attackAway / averages.attackAway,
      defenceHome: item.defenceHome / averages.defenceHome,
      defenceAway: item.defenceAway / averages.defenceAway,
      overall: ((item.overallHome / averages.overallHome) + (item.overallAway / averages.overallAway)) / 2,
    };
  }
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
  const { strengths, fallbackCount } = deriveTeamStrengths(teams);
  const gw = currentGameweek(events);
  const selections = buildPlayerSelections(enrichedPlayers, {
    rotowire: loadRotowireSelectionData(),
    historical,
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
