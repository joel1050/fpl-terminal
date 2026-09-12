/**
 * Frozen-input GW4 sensitivity experiment for the continuous ClubElo FDR.
 *
 * This file deliberately keeps the experiment beside its outputs rather than
 * adding switches to production projection code. The baseline is evaluated by
 * the real `projectPlayer` and by the small parameterized evaluator below; the
 * latter must match every scoring component before any variant is reported.
 * Raw inputs come from the saved snapshot, generated, and manual files listed
 * in the output; rerunning this script never calls an upstream endpoint or
 * changes production source.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Player, PlayerFixture, Position } from "@/types/player";
import type {
  PlayerMatchRate,
  ProjectionComponents,
  TeamStrength,
} from "@/types/projection";
import type { HistoricalBundle } from "@/lib/historical/types";
import type { StartObservation } from "@/lib/availability/startRate";
import type { CleanSheetStrength } from "@/lib/projections/cleanSheetStrength";
import { normalizeBootstrap, type NormalizedBootstrap } from "@/lib/fpl/normalize";
import {
  clubEloForFplShortName,
  CLUB_ELO_SNAPSHOT,
} from "@/lib/clubElo";
import {
  applyInSeasonForm,
  DEFAULT_DECAY,
  DEFAULT_PRIOR_WEIGHT,
  type TeamMatchXG,
} from "@/lib/historical/inSeasonForm";
import { loadHistoricalBundle } from "@/lib/historical/load";
import {
  ELO_LEVEL_SLOPE,
  CLEAN_SHEET_SKEW_WEIGHT,
} from "@/lib/projections/cleanSheetStrength";
import {
  AWAY_ATTACK_MULTIPLIER,
  calculateFixtureAdjustment,
  CLEAN_SHEET_BASE_RATE,
  CLEAN_SHEET_RETAINED_WEIGHT,
  continuousDifficultyMultiplier,
  HOME_ATTACK_MULTIPLIER,
  LEAGUE_AVERAGE_GOALS_AGAINST,
  LEAGUE_MEAN_XG,
  cleanSheetFromRates,
  interpolatedCleanSheet,
} from "@/lib/projections/fixtureAdjustment";
import {
  expectedFloorDivision,
  thresholdProbability,
} from "@/lib/projections/distributions";
import {
  blendPlayerRateByMinutes,
  PLAYER_FORM_DECAY,
  PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
  PLAYER_FORM_PRIOR_WEIGHT_RARE_EVENTS,
  PLAYER_FORM_WINSOR_RATIO,
} from "@/lib/projections/playerForm";
import { priceTieredAttackingPrior, projectPlayer } from "@/lib/projections/projectPlayer";
import { regressPer90 } from "@/lib/projections/regression";
import {
  deriveTeamStrengths,
  enrichPlayersWithHistory,
} from "@/lib/historical/enrichPlayers";

const ROOT = process.cwd();
const SNAPSHOT_DIR = path.join(ROOT, "data", "snapshots");
const OUTPUT_DIR = path.join(ROOT, "scripts", "experiments");
const GAMEWEEK = 4;
const CURRENT_GAMEWEEK = 4;
const BASELINE_FDR_DIVISOR = 150;
const TARGET_IDS = [426, 427, 68, 40, 154] as const;
const TARGET_LABELS: Record<number, string> = {
  426: "Bruno Fernandes",
  427: "Bryan Mbeumo",
  68: "Marcus Tavernier",
  40: "Morgan Rogers",
  154: "Cole Palmer",
};

type TargetId = (typeof TARGET_IDS)[number];
type CleanSheetMode = "ELO_RATES" | "TABLE" | "POISSON";
type BonusMode = "ATTACK" | "FLAT";

interface ModelConfig {
  fdrDivisor: number;
  formDecay: number;
  formPriorWeight: number;
  winsorRatio: number;
  regressionPriorWeightMinutes: number;
  pricePriorScale: number;
  teamFormDecay: number;
  teamPriorWeight: number;
  cleanSheetMode: CleanSheetMode;
  cleanSheetEloSlope: number;
  cleanSheetSkewWeight: number;
  bonusMode: BonusMode;
  attackRatioClamp: readonly [number, number];
  selectionCertainty: number;
  minutesShift: number;
}

interface VariantSpec {
  id: string;
  label: string;
  changedParameter: string;
  note: string;
  config: ModelConfig;
}

interface SnapshotEnvelope<T> {
  fetchedAt?: string;
  data: T;
}

interface InputRecord {
  path: string;
  sha256: string;
  bytes: number;
  mtime: string;
  fetchedAt?: string;
}

interface FixtureAdjustment {
  attackMultiplier: number;
  cleanSheetProbability: number;
  expectedGoalsAgainst: number;
}

interface Rates {
  xg: number;
  xa: number;
  saves: number;
  defensiveContribution: number;
  bonus: number;
  yellowCards: number;
  redCards: number;
}

interface Scenario {
  probability: number;
  minutes: number;
}

interface EvaluatedTarget {
  id: TargetId;
  label: string;
  baseline: number;
  value: number;
  rawBaseline: number;
  rawValue: number;
  delta: number;
  displayDelta: number;
  components: ProjectionComponents;
}

interface EvaluatedVariant {
  id: string;
  label: string;
  changedParameter: string;
  note: string;
  config: ModelConfig;
  desiredSignCount: number;
  netDirectionalSum: number;
  targets: EvaluatedTarget[];
}

const BASELINE_CONFIG: ModelConfig = {
  fdrDivisor: BASELINE_FDR_DIVISOR,
  formDecay: PLAYER_FORM_DECAY,
  formPriorWeight: PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
  winsorRatio: PLAYER_FORM_WINSOR_RATIO,
  regressionPriorWeightMinutes: 900,
  pricePriorScale: 1,
  teamFormDecay: DEFAULT_DECAY,
  teamPriorWeight: DEFAULT_PRIOR_WEIGHT,
  cleanSheetMode: "ELO_RATES",
  cleanSheetEloSlope: ELO_LEVEL_SLOPE,
  cleanSheetSkewWeight: CLEAN_SHEET_SKEW_WEIGHT,
  bonusMode: "ATTACK",
  attackRatioClamp: [0.7, 1.35],
  selectionCertainty: 1,
  minutesShift: 0,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sumComponents(components: ProjectionComponents): number {
  return (
    components.appearance +
    components.goals +
    components.assists +
    components.cleanSheets +
    components.goalsConceded +
    components.saves +
    components.defensiveContribution +
    components.bonus +
    components.cards +
    components.penalties
  );
}

function zeroComponents(): ProjectionComponents {
  return {
    appearance: 0,
    goals: 0,
    assists: 0,
    cleanSheets: 0,
    goalsConceded: 0,
    saves: 0,
    defensiveContribution: 0,
    bonus: 0,
    cards: 0,
    penalties: 0,
    total: 0,
  };
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readEnvelope<T>(file: string): SnapshotEnvelope<T> {
  const value = readJson<SnapshotEnvelope<T>>(file);
  if (!value || !("data" in value)) throw new Error(`Snapshot has no data: ${file}`);
  return value;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function inputRecord(relativePath: string): InputRecord {
  const file = path.join(ROOT, relativePath);
  const stats = statSync(file);
  const envelope = readJson<Record<string, unknown>>(file);
  return {
    path: relativePath,
    sha256: sha256(file),
    bytes: stats.size,
    mtime: new Date(stats.mtimeMs).toISOString(),
    fetchedAt: typeof envelope.fetchedAt === "string" ? envelope.fetchedAt : undefined,
  };
}

const INPUT_PATHS = [
  "data/snapshots/bootstrap.json",
  "data/snapshots/fixtures.json",
  "data/snapshots/in-season-xg-gw-1.json",
  "data/snapshots/in-season-xg-gw-2.json",
  "data/snapshots/in-season-xg-gw-3.json",
  "data/snapshots/in-season-player-rates-gw-1.json",
  "data/snapshots/in-season-player-rates-gw-2.json",
  "data/snapshots/in-season-player-rates-gw-3.json",
  "data/snapshots/in-season-starts-gw-1.json",
  "data/snapshots/in-season-starts-gw-2.json",
  "data/snapshots/in-season-starts-gw-3.json",
  "data/generated/historical-players.json",
  "data/generated/historical-match-stats.json",
  "data/generated/team-strength.json",
  "data/generated/player-mappings.json",
  "data/generated/rotowire-lineups.json",
  "data/generated/rotowire-player-mappings.json",
  "data/generated/club-elo.json",
  "data/manual/team-strengths.json",
] as const;

function fixtureByTeam(normalized: NormalizedBootstrap): Map<string, PlayerFixture> {
  const result = new Map<string, PlayerFixture>();
  for (const fixture of normalized.fixtures) {
    if (fixture.gameweek === undefined) continue;
    const home: PlayerFixture = {
      gameweek: fixture.gameweek,
      opponentTeamId: fixture.teamAwayId,
      opponentShortName: normalized.teams.find((team) => team.id === fixture.teamAwayId)?.shortName ?? "UNK",
      isHome: true,
      difficulty: fixture.homeDifficulty,
      exactDifficulty: fixture.homeExactDifficulty,
    };
    const away: PlayerFixture = {
      gameweek: fixture.gameweek,
      opponentTeamId: fixture.teamHomeId,
      opponentShortName: normalized.teams.find((team) => team.id === fixture.teamHomeId)?.shortName ?? "UNK",
      isHome: false,
      difficulty: fixture.awayDifficulty,
      exactDifficulty: fixture.awayExactDifficulty,
    };
    result.set(`${fixture.gameweek}:${fixture.teamHomeId}`, home);
    result.set(`${fixture.gameweek}:${fixture.teamAwayId}`, away);
  }
  return result;
}

function frozenHistories(normalized: NormalizedBootstrap): {
  teamXG: Record<number, TeamMatchXG[]>;
  playerForm: Record<number, PlayerMatchRate[]>;
  starts: Record<number, StartObservation[]>;
} {
  const fixtureMap = fixtureByTeam(normalized);
  const playerTeams = new Map(normalized.players.map((player) => [player.id, player.teamId]));
  const teamXG: Record<number, TeamMatchXG[]> = {};
  const playerForm: Record<number, PlayerMatchRate[]> = {};
  const starts: Record<number, StartObservation[]> = {};

  for (let gameweek = 1; gameweek < GAMEWEEK; gameweek += 1) {
    const teamRows = readEnvelope<Array<{
      teamId: number;
      xgFor: number;
      xgAgainst: number;
      opponentTeamId?: number;
      wasHome?: boolean;
    }>>(path.join(SNAPSHOT_DIR, `in-season-xg-gw-${gameweek}.json`)).data;
    for (const row of teamRows) {
      (teamXG[row.teamId] ??= []).push({
        xgFor: row.xgFor,
        xgAgainst: row.xgAgainst,
        // Preserve the cached loader shape exactly. GW1/GW2 snapshots were
        // written before opponent/venue fields were added, so those rows stay
        // context-free. Only GW3 carries the newer fields, so the production
        // joint fit sees one contextual gameweek (ten fixtures) on this input.
        ...(row.opponentTeamId !== undefined ? { opponentTeamId: row.opponentTeamId } : {}),
        ...(row.wasHome !== undefined ? { wasHome: row.wasHome } : {}),
        gameweek,
      });
    }

    const playerRows = readEnvelope<Array<{
      playerId: number;
      xg: number;
      xa: number;
      minutes: number;
    }>>(path.join(SNAPSHOT_DIR, `in-season-player-rates-gw-${gameweek}.json`)).data;
    for (const row of playerRows) {
      if (row.minutes <= 0) continue;
      const teamId = playerTeams.get(row.playerId);
      if (teamId === undefined) continue;
      const fixture = fixtureMap.get(`${gameweek}:${teamId}`);
      (playerForm[row.playerId] ??= []).push({
        xg: row.xg,
        xa: row.xa,
        minutes: row.minutes,
        ...(fixture
          ? { opponentTeamId: fixture.opponentTeamId, wasHome: fixture.isHome }
          : {}),
      });
    }

    const startRows = readEnvelope<Array<{
      playerId: number;
      started: boolean;
      appeared: boolean;
      minutes: number;
    }>>(path.join(SNAPSHOT_DIR, `in-season-starts-gw-${gameweek}.json`)).data;
    for (const row of startRows) {
      if (!playerTeams.has(row.playerId)) continue;
      (starts[row.playerId] ??= []).push({
        started: row.started,
        appeared: row.appeared,
        minutes: row.minutes,
      });
    }
  }
  return { teamXG, playerForm, starts };
}

function normalizeTeamName(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Copy of the production historical-source mapping, kept local for auditability. */
function historicalSourceStrengths(
  historical: HistoricalBundle,
): Record<number, TeamStrength> {
  const { strengths } = deriveTeamStrengths(historical.teamStrength.map((team) => ({
    id: team.teamId,
    name: team.name,
    shortName: team.shortName,
    strength: {
      overallHome: team.overallHome,
      overallAway: team.overallAway,
      attackHome: team.attackHome,
      attackAway: team.attackAway,
      defenceHome: team.defenceHome,
      defenceAway: team.defenceAway,
    },
  })));
  const byName = new Map<string, TeamStrength>();
  historical.teamStrength.forEach((team) => {
    const strength = strengths[team.teamId];
    if (!strength) return;
    byName.set(normalizeTeamName(team.name), strength);
    byName.set(normalizeTeamName(team.shortName), strength);
  });
  const historicalById = new Map(
    historical.players.map((player) => [player.historicalPlayerId, player]),
  );
  const result: Record<number, TeamStrength> = {};
  historical.playerMappings.forEach((mapping) => {
    if (mapping.historicalPlayerId === undefined) return;
    const historicalPlayer = historicalById.get(mapping.historicalPlayerId);
    const sourceName = historicalPlayer?.teamName;
    if (!sourceName) return;
    const strength = byName.get(normalizeTeamName(sourceName));
    if (strength) result[mapping.currentPlayerId] = strength;
  });
  return result;
}

function customCleanSheetStrengths(
  strengths: Record<number, TeamStrength>,
  shortNameByTeamId: ReadonlyMap<number, string>,
  slope: number,
  skewWeight: number,
): Record<number, CleanSheetStrength> {
  const rated: { teamId: number; elo: number; skew: number }[] = [];
  for (const [key, strength] of Object.entries(strengths)) {
    const teamId = Number(key);
    const attack = (strength.attackHome + strength.attackAway) / 2;
    const defence = (strength.defenceHome + strength.defenceAway) / 2;
    const elo = clubEloForFplShortName(shortNameByTeamId.get(teamId), CLUB_ELO_SNAPSHOT)?.elo;
    if (!(attack > 0) || !(defence > 0) || elo === undefined) continue;
    rated.push({ teamId, elo, skew: Math.log(attack) - Math.log(defence) });
  }
  if (rated.length === 0) return {};
  const meanElo = rated.reduce((sum, item) => sum + item.elo, 0) / rated.length;
  return Object.fromEntries(rated.map((team) => {
    const level = slope * (team.elo - meanElo);
    const skew = skewWeight * team.skew;
    return [team.teamId, {
      attack: Math.exp((level + skew) / 2),
      defence: Math.exp((level - skew) / 2),
    }];
  }));
}

function historicalRate(
  player: Player,
  field: string,
): { rate: number; minutes: number } | undefined {
  const history = player.historical as (Player["historical"] & Record<string, number | undefined>) | undefined;
  if (!history || history.minutes <= 0) return undefined;
  const value = history[field];
  if (value === undefined) return undefined;
  return { rate: (value / history.minutes) * 90, minutes: history.minutes };
}

function currentRate(
  player: Player,
  field: string,
): { rate: number; minutes: number } | undefined {
  const current = player.current as Player["current"] & Record<string, number | undefined>;
  const value = current[field];
  if (value === undefined || player.current.minutes <= 0) return undefined;
  return { rate: (value / player.current.minutes) * 90, minutes: player.current.minutes };
}

function currentSeasonWeight(
  form: readonly PlayerMatchRate[] | undefined,
  priorWeightMatches: number,
): number {
  if (!form || form.length === 0) return clamp(CURRENT_GAMEWEEK / 10, 0, 0.6);
  return form.length / (form.length + priorWeightMatches);
}

function regressedPlayerRate(
  player: Player,
  primary: string,
  fallback: string | undefined,
  prior: number,
  ceiling: number,
  form: readonly PlayerMatchRate[] | undefined,
  config: ModelConfig,
  rare = false,
): number {
  const historical = historicalRate(player, primary) ?? (fallback ? historicalRate(player, fallback) : undefined);
  const current = currentRate(player, primary) ?? (fallback ? currentRate(player, fallback) : undefined);
  let rate = historical?.rate ?? prior;
  let sample = historical?.minutes ?? 0;
  if (current) {
    const currentWeight = currentSeasonWeight(form, rare ? PLAYER_FORM_PRIOR_WEIGHT_RARE_EVENTS : config.formPriorWeight);
    const baselineAnchor = rate > 0 ? rate : prior;
    const cap = baselineAnchor > 0 && config.winsorRatio > 0
      ? baselineAnchor * config.winsorRatio
      : undefined;
    const winsorizedCurrentRate = cap === undefined
      ? current.rate
      : Math.min(current.rate, cap);
    rate = rate * (1 - currentWeight) + winsorizedCurrentRate * currentWeight;
    sample += current.minutes * currentWeight;
  }
  return clamp(
    regressPer90(rate, sample, prior, config.regressionPriorWeightMinutes),
    0,
    ceiling,
  );
}

function pastFixtureMultiplier(
  match: PlayerMatchRate,
  ownTeam: TeamStrength,
  strengths: Record<number, TeamStrength>,
  config: ModelConfig,
): number | undefined {
  if (match.opponentTeamId === undefined || match.wasHome === undefined) return undefined;
  const opponent = strengths[match.opponentTeamId];
  if (!opponent) return undefined;
  return localFixtureAdjustment(
    {
      gameweek: 0,
      opponentTeamId: match.opponentTeamId,
      opponentShortName: "",
      isHome: match.wasHome,
      difficulty: 3,
    },
    ownTeam,
    opponent,
    undefined,
    config,
  ).attackMultiplier;
}

function regressedFormRate(
  player: Player,
  primary: "expectedGoals" | "expectedAssists",
  fallback: "goals" | "assists",
  prior: number,
  form: readonly PlayerMatchRate[] | undefined,
  ownTeam: TeamStrength | undefined,
  strengths: Record<number, TeamStrength> | undefined,
  historicalTeam: TeamStrength | undefined,
  config: ModelConfig,
): number {
  const historical = historicalRate(player, primary) ?? historicalRate(player, fallback);
  const normalizedOwnTeam = ownTeam && strengths?.[ownTeam.teamId] ? ownTeam : undefined;
  const ownAttack = normalizedOwnTeam
    ? (normalizedOwnTeam.attackHome + normalizedOwnTeam.attackAway) / 2
    : 1;
  const sourceTeam = historicalTeam ?? normalizedOwnTeam;
  const sourceAttack = sourceTeam
    ? (sourceTeam.attackHome + sourceTeam.attackAway) / 2
    : 1;
  const historicalAnchor = historical
    ? regressPer90(historical.rate, historical.minutes, prior, config.regressionPriorWeightMinutes)
    : prior;
  const basePrior = historical && sourceAttack > 0 ? historicalAnchor / sourceAttack : historicalAnchor;

  if (form && form.length > 0) {
    const field = primary === "expectedGoals" ? "xg" : "xa";
    const samples = form.map((match) => {
      let value = match[field];
      if (player.position === "DEF" && primary === "expectedGoals" && match.minutes > 0) {
        const per90 = (value / match.minutes) * 90;
        if (per90 > 0.35) value = (0.35 / 90) * match.minutes;
      }
      return { value, minutes: match.minutes };
    });
    const multipliers = ownTeam && strengths
      ? form.map((match) => pastFixtureMultiplier(match, ownTeam, strengths, config))
      : [];
    if (
      multipliers.length === form.length &&
      multipliers.every((value) => value !== undefined && value > 0) &&
      ownAttack > 0
    ) {
      return clamp(
        blendPlayerRateByMinutes(
          samples.map((sample, index) => ({
            value: sample.value / (multipliers[index] as number),
            minutes: sample.minutes,
          })),
          basePrior,
          config.formDecay,
          config.formPriorWeight,
          config.winsorRatio,
        ),
        0,
        3,
      );
    }
    return clamp(
      blendPlayerRateByMinutes(
        samples,
        historicalAnchor,
        config.formDecay,
        config.formPriorWeight,
        config.winsorRatio,
      ),
      0,
      3,
    );
  }

  const current = currentRate(player, primary) ?? currentRate(player, fallback);
  let rate = historical && sourceAttack > 0 ? historical.rate / sourceAttack : prior;
  let sample = historical?.minutes ?? 0;
  if (current) {
    const currentWeight = clamp(CURRENT_GAMEWEEK / 10, 0, 0.6);
    const normalizedCurrent = ownAttack > 0 ? current.rate / ownAttack : current.rate;
    rate = rate * (1 - currentWeight) + normalizedCurrent * currentWeight;
    sample += current.minutes * currentWeight;
  }
  return clamp(
    regressPer90(rate, sample, prior, config.regressionPriorWeightMinutes),
    0,
    3,
  );
}

function attackingPrior(
  player: Player,
  field: "xg" | "xa",
  config: ModelConfig,
): number {
  const prior = priceTieredAttackingPrior(player.position, player.priceTenths);
  return (field === "xg" ? prior.xg : prior.xa) * config.pricePriorScale;
}

function localCleanSheet(
  fixture: PlayerFixture,
  ownDefence: number,
  opponentAttack: number,
  ownRates: CleanSheetStrength | undefined,
  opponentRates: CleanSheetStrength | undefined,
  config: ModelConfig,
): { probability: number; goalsAgainst: number; fromRates: boolean } {
  if (config.cleanSheetMode === "ELO_RATES" && ownRates && opponentRates) {
    const rated = cleanSheetFromRates(fixture.isHome, ownRates.defence, opponentRates.attack);
    return {
      probability: rated.cleanSheetProbability,
      goalsAgainst: rated.goalsAgainst,
      fromRates: true,
    };
  }
  const venue = fixture.isHome ? AWAY_ATTACK_MULTIPLIER : HOME_ATTACK_MULTIPLIER;
  const goalsAgainst = LEAGUE_MEAN_XG * (opponentAttack / Math.max(ownDefence, 0.2)) * venue;
  const probability = config.cleanSheetMode === "TABLE"
    ? interpolatedCleanSheet(fixture.isHome, ownDefence, opponentAttack)
    : clamp(Math.exp(-goalsAgainst), 0.03, 0.65);
  const compressed = probability - (1 - CLEAN_SHEET_RETAINED_WEIGHT)
    * Math.max(0, probability - CLEAN_SHEET_BASE_RATE);
  return {
    probability: compressed,
    goalsAgainst: -Math.log(clamp(compressed, 0.03, 0.9)),
    fromRates: false,
  };
}

function localFixtureAdjustment(
  fixture: PlayerFixture,
  own: TeamStrength | undefined,
  opponent: TeamStrength | undefined,
  cleanSheetStrengths: {
    own?: CleanSheetStrength;
    opponent?: CleanSheetStrength;
  } | undefined,
  config: ModelConfig,
): FixtureAdjustment {
  const difficulty = fixture.exactDifficulty ?? fixture.difficulty ?? 3;
  const base = continuousDifficultyMultiplier(difficulty);
  const venue = fixture.isHome ? HOME_ATTACK_MULTIPLIER : AWAY_ATTACK_MULTIPLIER;
  let expectedGoalsAgainst = LEAGUE_AVERAGE_GOALS_AGAINST * (fixture.isHome ? 0.9 : 1.1);
  let attackMultiplier = base * venue;
  let cleanSheetProbability: number | undefined;
  let ratedGoalsAgainst: number | undefined;
  let fromRates = false;

  if (own && opponent) {
    const ownAttack = fixture.isHome ? own.attackHome : own.attackAway;
    const ownDefence = fixture.isHome ? own.defenceHome : own.defenceAway;
    const opponentAttack = fixture.isHome ? opponent.attackAway : opponent.attackHome;
    const opponentDefence = fixture.isHome ? opponent.defenceAway : opponent.defenceHome;
    if (ownAttack > 0 && opponentDefence > 0) {
      attackMultiplier *= clamp(
        ownAttack / opponentDefence,
        config.attackRatioClamp[0],
        config.attackRatioClamp[1],
      );
    }
    const clean = localCleanSheet(
      fixture,
      ownDefence,
      opponentAttack,
      cleanSheetStrengths?.own,
      cleanSheetStrengths?.opponent,
      config,
    );
    cleanSheetProbability = clean.probability;
    ratedGoalsAgainst = clean.fromRates ? clean.goalsAgainst : undefined;
    fromRates = clean.fromRates;
    expectedGoalsAgainst = clean.goalsAgainst;
  } else {
    expectedGoalsAgainst /= Math.pow(base, 2);
  }

  attackMultiplier = clamp(attackMultiplier, 0.55, 1.6);
  cleanSheetProbability ??= clamp(Math.exp(-expectedGoalsAgainst), 0.03, 0.65);
  if (!fromRates && own && opponent) {
    // localCleanSheet already applies the same one-sided table compression.
    cleanSheetProbability = clamp(cleanSheetProbability, 0.03, 0.9);
  } else if (!fromRates) {
    cleanSheetProbability -= (1 - CLEAN_SHEET_RETAINED_WEIGHT)
      * Math.max(0, cleanSheetProbability - CLEAN_SHEET_BASE_RATE);
  }
  expectedGoalsAgainst = ratedGoalsAgainst ?? -Math.log(clamp(cleanSheetProbability, 0.03, 0.9));
  return {
    attackMultiplier,
    cleanSheetProbability,
    expectedGoalsAgainst,
  };
}

function localFixtureAdjustmentForPlayer(
  player: Player,
  fixture: PlayerFixture,
  strengths: Record<number, TeamStrength>,
  cleanSheetStrengths: Record<number, CleanSheetStrength>,
  config: ModelConfig,
): FixtureAdjustment {
  const own = strengths[player.teamId];
  const opponent = strengths[fixture.opponentTeamId];
  const ownElo = clubEloForFplShortName(player.teamShortName, CLUB_ELO_SNAPSHOT)?.elo;
  const opponentElo = clubEloForFplShortName(fixture.opponentShortName, CLUB_ELO_SNAPSHOT)?.elo;
  const difficulty = ownElo !== undefined && opponentElo !== undefined
    ? clamp(3 + (opponentElo - ownElo) / config.fdrDivisor, 1, 5)
    : fixture.exactDifficulty ?? fixture.difficulty ?? 3;
  const withDifficulty = { ...fixture, exactDifficulty: difficulty };
  return localFixtureAdjustment(
    withDifficulty,
    own,
    opponent,
    {
      own: cleanSheetStrengths[player.teamId],
      opponent: cleanSheetStrengths[fixture.opponentTeamId],
    },
    config,
  );
}

function ratesFor(
  player: Player,
  form: readonly PlayerMatchRate[] | undefined,
  strengths: Record<number, TeamStrength>,
  historicalTeam: TeamStrength | undefined,
  config: ModelConfig,
): Rates {
  const ownTeam = strengths[player.teamId];
  return {
    xg: regressedFormRate(
      player,
      "expectedGoals",
      "goals",
      attackingPrior(player, "xg", config),
      form,
      ownTeam,
      strengths,
      historicalTeam,
      config,
    ),
    xa: regressedFormRate(
      player,
      "expectedAssists",
      "assists",
      attackingPrior(player, "xa", config),
      form,
      ownTeam,
      strengths,
      historicalTeam,
      config,
    ),
    saves: regressedPlayerRate(player, "saves", undefined, 0, 10, form, config),
    defensiveContribution: regressedPlayerRate(player, "defensiveContribution", undefined, 8.6, 30, form, config),
    bonus: regressedPlayerRate(player, "bonus", undefined, 0.32, 3, form, config),
    yellowCards: regressedPlayerRate(player, "yellowCards", undefined, 0.188, 0.8, form, config, true),
    redCards: regressedPlayerRate(player, "redCards", undefined, 0.005, 0.1, form, config, true),
  };
}

function scenariosFor(player: Player, config: ModelConfig): Scenario[] {
  const selection = player.selection;
  if (!selection) return [{ probability: 1, minutes: 0 }];
  let start = clamp(selection.startProbability, 0, 1);
  let cameo = clamp(selection.cameoProbability, 0, 1);
  if (config.selectionCertainty !== 1) {
    start = 0.5 + (start - 0.5) * config.selectionCertainty;
    cameo *= config.selectionCertainty;
  }
  const total = start + cameo;
  if (total > 1) {
    start /= total;
    cameo /= total;
  }
  return [
    {
      probability: start,
      minutes: clamp((selection.expectedStartMinutes ?? 80) + config.minutesShift, 60, 90),
    },
    {
      probability: cameo,
      minutes: clamp((selection.expectedCameoMinutes ?? 20) + config.minutesShift, 1, 45),
    },
  ];
}

function localComponents(
  player: Player,
  fixture: PlayerFixture,
  strengths: Record<number, TeamStrength>,
  cleanSheetStrengths: Record<number, CleanSheetStrength>,
  historicalTeam: TeamStrength | undefined,
  playerForm: Record<number, readonly PlayerMatchRate[]>,
  config: ModelConfig,
): ProjectionComponents {
  const rates = ratesFor(player, playerForm[player.id], strengths, historicalTeam, config);
  const adjustment = localFixtureAdjustmentForPlayer(player, fixture, strengths, cleanSheetStrengths, config);
  const components = zeroComponents();
  const goalPoints: Record<Position, number> = { GK: 10, DEF: 6, MID: 5, FWD: 4 };
  const cleanSheetPoints: Record<Position, number> = { GK: 4, DEF: 4, MID: 1, FWD: 0 };
  const goalConversion: Record<Position, number> = { GK: 1, DEF: 0.7, MID: 0.981, FWD: 0.988 };
  const assistConversion: Record<Position, number> = { GK: 1, DEF: 1.272, MID: 1.207, FWD: 2.114 };
  const dcThreshold: Record<Position, number> = { GK: 0, DEF: 10, MID: 12, FWD: 12 };
  for (const scenario of scenariosFor(player, config)) {
    const minutesShare = clamp(scenario.minutes, 0, 90) / 90;
    if (scenario.probability <= 0 || minutesShare <= 0) continue;
    const weight = scenario.probability;
    const playedSixty = scenario.minutes >= 60;
    components.appearance += weight * (playedSixty ? 2 : 1);
    components.goals += weight * rates.xg * goalConversion[player.position]
      * minutesShare * adjustment.attackMultiplier * goalPoints[player.position];
    components.assists += weight * rates.xa * assistConversion[player.position]
      * minutesShare * adjustment.attackMultiplier * 3;
    if (playedSixty) {
      components.cleanSheets += weight * adjustment.cleanSheetProbability * cleanSheetPoints[player.position];
    }
    if (player.position === "GK" || player.position === "DEF") {
      components.goalsConceded -= weight * expectedFloorDivision(
        adjustment.expectedGoalsAgainst * minutesShare,
        2,
      );
    }
    if (player.position === "GK") {
      components.saves += weight * expectedFloorDivision(
        rates.saves * minutesShare * clamp(adjustment.expectedGoalsAgainst / LEAGUE_AVERAGE_GOALS_AGAINST, 0.7, 1.4),
        3,
      );
    }
    const threshold = dcThreshold[player.position];
    if (threshold > 0) {
      components.defensiveContribution += weight * 2
        * thresholdProbability(rates.defensiveContribution * minutesShare, threshold);
    }
    const bonusMultiplier = config.bonusMode === "FLAT" ? 1 : adjustment.attackMultiplier;
    components.bonus += weight * rates.bonus * minutesShare * bonusMultiplier;
    const yellowChance = 1 - Math.exp(-rates.yellowCards * minutesShare);
    const redChance = 1 - Math.exp(-rates.redCards * minutesShare);
    components.cards -= weight * (yellowChance + 3 * redChance);
  }
  components.total = sumComponents(components);
  return components;
}

function desiredSign(delta: number, id: TargetId): boolean {
  return id === 40 || id === 154 ? delta >= 0.001 : delta <= -0.001;
}

function netDirectionalSum(targets: readonly EvaluatedTarget[]): number {
  return targets.reduce(
    (sum, target) => sum + ((target.id === 40 || target.id === 154) ? target.delta : -target.delta),
    0,
  );
}

function variant(
  id: string,
  label: string,
  changedParameter: string,
  note: string,
  patch: Partial<ModelConfig>,
): VariantSpec {
  return {
    id,
    label,
    changedParameter,
    note,
    config: { ...BASELINE_CONFIG, ...patch },
  };
}

/** 24 one-parameter arms plus the continuous-150 baseline. */
function variantSpecs(): VariantSpec[] {
  return [
    variant("fdr_divisor_130", "FDR divisor 130", "fdrDivisor", "Narrower Elo gap; included as a bounded fixture sensitivity.", { fdrDivisor: 130 }),
    variant("fdr_divisor_200", "FDR divisor 200", "fdrDivisor", "Previous continuous divisor used before the 150 change.", { fdrDivisor: 200 }),
    variant("fdr_divisor_300", "FDR divisor 300", "fdrDivisor", "Wider Elo gap; included as a bounded fixture sensitivity.", { fdrDivisor: 300 }),
    variant("form_decay_090", "Player form decay 0.90", "formDecay", "Faster recency fade.", { formDecay: 0.9 }),
    variant("form_decay_100", "Player form decay 1.00", "formDecay", "Flat recency weights across the three current matches.", { formDecay: 1 }),
    variant("form_prior_3", "Player form prior weight 3", "formPriorWeight", "Half the current six-match prior weight.", { formPriorWeight: 3 }),
    variant("form_prior_12", "Player form prior weight 12", "formPriorWeight", "Double the current six-match prior weight.", { formPriorWeight: 12 }),
    variant("winsor_ratio_2", "Player winsor ratio 2.0", "winsorRatio", "Tighter short-run rate cap.", { winsorRatio: 2 }),
    variant("winsor_ratio_5", "Player winsor ratio 5.0", "winsorRatio", "Looser short-run rate cap.", { winsorRatio: 5 }),
    variant("regression_prior_450", "Regression prior 450 minutes", "regressionPriorWeightMinutes", "Half the per-90 regression prior.", { regressionPriorWeightMinutes: 450 }),
    variant("regression_prior_1800", "Regression prior 1800 minutes", "regressionPriorWeightMinutes", "Double the per-90 regression prior.", { regressionPriorWeightMinutes: 1800 }),
    variant("price_prior_scale_075", "Price prior scale 0.75", "pricePriorScale", "Lower global MID xG/xA price-tier priors.", { pricePriorScale: 0.75 }),
    variant("price_prior_scale_125", "Price prior scale 1.25", "pricePriorScale", "Higher global MID xG/xA price-tier priors.", { pricePriorScale: 1.25 }),
    variant("team_form_decay_080", "Team form decay 0.80", "teamFormDecay", "Faster recency fade for joint team xG form.", { teamFormDecay: 0.8 }),
    variant("team_form_decay_100", "Team form decay 1.00", "teamFormDecay", "Flat weights for completed team fixtures.", { teamFormDecay: 1 }),
    variant("team_prior_weight_6", "Team prior weight 6", "teamPriorWeight", "Half the current team prior weight.", { teamPriorWeight: 6 }),
    variant("team_prior_weight_24", "Team prior weight 24", "teamPriorWeight", "Double the current team prior weight.", { teamPriorWeight: 24 }),
    variant("clean_sheet_table", "Clean sheet table path", "cleanSheetMode", "Uses the interpolated market table instead of Elo-levelled rates.", { cleanSheetMode: "TABLE" }),
    variant("clean_sheet_elo_slope_002", "Clean sheet Elo slope 0.002", "cleanSheetEloSlope", "Lower Elo level slope in the global clean-sheet rates.", { cleanSheetEloSlope: 0.002 }),
    variant("clean_sheet_elo_slope_005", "Clean sheet Elo slope 0.005", "cleanSheetEloSlope", "Higher Elo level slope in the global clean-sheet rates.", { cleanSheetEloSlope: 0.005 }),
    variant("bonus_flat", "Bonus rate flat", "bonusMode", "Removes the fixture attack multiplier from bonus expectation.", { bonusMode: "FLAT" }),
    variant("attack_ratio_wide", "Attack ratio clamp [0.55, 1.75]", "attackRatioClamp", "Allows more of the global attack-versus-defence ratio through.", { attackRatioClamp: [0.55, 1.75] }),
    variant("selection_shrink_075", "Selection certainty 0.75", "selectionCertainty", "Shrinks every target's start/cameo probabilities toward uncertainty.", { selectionCertainty: 0.75 }),
    variant("minutes_shift_plus5", "Expected role minutes +5", "minutesShift", "Adds five minutes to every start and cameo role duration, within model bounds.", { minutesShift: 5 }),
  ];
}

function evaluateVariant(
  spec: VariantSpec,
  playersById: ReadonlyMap<number, Player>,
  priorStrengths: Record<number, TeamStrength>,
  teamXG: Record<number, readonly TeamMatchXG[]>,
  playerForm: Record<number, readonly PlayerMatchRate[]>,
  historicalTeams: Record<number, TeamStrength>,
  cleanSheetNames: ReadonlyMap<number, string>,
  baselineTargets: ReadonlyMap<TargetId, EvaluatedTarget>,
): EvaluatedVariant {
  const strengths = applyInSeasonForm(
    priorStrengths,
    teamXG,
    spec.config.teamFormDecay,
    spec.config.teamPriorWeight,
  );
  const cleanSheets = spec.config.cleanSheetMode === "TABLE"
    ? {}
    : customCleanSheetStrengths(
      strengths,
      cleanSheetNames,
      spec.config.cleanSheetEloSlope,
      spec.config.cleanSheetSkewWeight,
    );
  const targets = TARGET_IDS.map((id) => {
    const player = playersById.get(id);
    if (!player) throw new Error(`Target player missing: ${id}`);
    const fixture = player.fixtures.find((item) => item.gameweek === GAMEWEEK);
    if (!fixture) throw new Error(`Target fixture missing: ${id} GW${GAMEWEEK}`);
    const components = localComponents(
      player,
      fixture,
      strengths,
      cleanSheets,
      historicalTeams[id],
      playerForm,
      spec.config,
    );
    const baseline = baselineTargets.get(id);
    if (!baseline) throw new Error(`Baseline target missing: ${id}`);
    const rawValue = components.total;
    return {
      id,
      label: TARGET_LABELS[id],
      baseline: baseline.value,
      value: round3(rawValue),
      rawBaseline: baseline.rawValue,
      rawValue,
      delta: rawValue - baseline.rawValue,
      displayDelta: round3(rawValue - baseline.rawValue),
      components,
    };
  });
  return {
    id: spec.id,
    label: spec.label,
    changedParameter: spec.changedParameter,
    note: spec.note,
    config: spec.config,
    desiredSignCount: targets.filter((target) => desiredSign(target.delta, target.id)).length,
    netDirectionalSum: netDirectionalSum(targets),
    targets,
  };
}

function componentDiff(
  expected: ProjectionComponents,
  actual: ProjectionComponents,
): { max: number; field?: keyof ProjectionComponents } {
  let max = 0;
  let field: keyof ProjectionComponents | undefined;
  for (const key of Object.keys(expected) as (keyof ProjectionComponents)[]) {
    const difference = Math.abs(expected[key] - actual[key]);
    if (difference > max) {
      max = difference;
      field = key;
    }
  }
  return { max, field };
}

function reportTable(rows: readonly EvaluatedVariant[]): string {
  const cells = (target: EvaluatedTarget) => `${target.value.toFixed(3)} (${target.displayDelta >= 0 ? "+" : ""}${target.displayDelta.toFixed(3)})`;
  const lines = [
    "| Rank | Arm | Desired signs | Net directional sum | Bruno | Mbeumo | Tavernier | Rogers | Palmer |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  rows.forEach((row, index) => {
    const byId = new Map(row.targets.map((target) => [target.id, target]));
    lines.push(`| ${index + 1} | ${row.label} | ${row.desiredSignCount}/5 | ${row.netDirectionalSum.toFixed(6)} | ${cells(byId.get(426)!)} | ${cells(byId.get(427)!)} | ${cells(byId.get(68)!)} | ${cells(byId.get(40)!)} | ${cells(byId.get(154)!)} |`);
  });
  return lines.join("\n");
}

function buildReport(result: Record<string, unknown>, ranked: readonly EvaluatedVariant[]): string {
  const baseline = result.baseline as {
    targets: Array<{ label: string; value: number; components: ProjectionComponents }>;
    parity: { maxComponentGap: number; maxAdjustmentGap: number };
  };
  const inputRecords = result.inputs as InputRecord[];
  const fetched = inputRecords
    .filter((item) => item.fetchedAt)
    .map((item) => `${item.path}=${item.fetchedAt}`)
    .join(", ");
  const history = result.frozenHistory as {
    teamXGJointFixtures: number;
    teamXGJointGameweeks: number[];
  };
  const topArm = ranked.find((row) => row.id === "team_prior_weight_24");
  const baselineById = new Map(baseline.targets.map((target) => [target.label, target]));
  const topDeltaText = topArm
    ? topArm.targets.map((target) => {
      const base = baselineById.get(target.label);
      const attackDelta = base
        ? target.components.goals + target.components.assists - base.components.goals - base.components.assists
        : 0;
      const bonusDelta = base ? target.components.bonus - base.components.bonus : 0;
      return `${target.label} attack returns ${attackDelta >= 0 ? "+" : ""}${attackDelta.toFixed(3)}, bonus ${bonusDelta >= 0 ? "+" : ""}${bonusDelta.toFixed(3)}`;
    }).join("; ")
    : "";
  const baselineRows = baseline.targets
    .map((target) => `| ${target.label} | ${target.value.toFixed(3)} | ${target.components.appearance.toFixed(6)} | ${target.components.goals.toFixed(6)} | ${target.components.assists.toFixed(6)} | ${target.components.cleanSheets.toFixed(6)} | ${target.components.defensiveContribution.toFixed(6)} | ${target.components.bonus.toFixed(6)} | ${target.components.cards.toFixed(6)} |`)
    .join("\n");
  return `# GW4 continuous-150 FDR sensitivity\n\nTask ID: \`fdr150_experiments\`. The run reads the saved snapshot, generated, and manual inputs listed below and evaluates the five requested MID players on their GW4 fixture. It freezes those file contents at read time and records hashes and fetch times; a later rerun can differ if any saved input is refreshed. The baseline is the current production \`projectPlayer\` path with continuous ClubElo divisor 150; each arm changes one global parameter or assumption.\n\n## Baseline\n\n| Player | xP | Appearance | Goals | Assists | Clean sheets | Defensive contribution | Bonus | Cards |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${baselineRows}\n\nThe custom component evaluator matched production with a maximum component gap of ${baseline.parity.maxComponentGap.toExponential(3)} and a maximum fixture-adjustment gap of ${baseline.parity.maxAdjustmentGap.toExponential(3)} across all five players, including the historical source-team strength passed into the xG/xA rate path. The baseline absolute xP values are production rounded values; arm values below are rounded to three decimals. Delta arithmetic and ranking use unrounded component totals, so a displayed value and displayed delta can differ by one last decimal.\n\n## Ranked arms\n\nRanking first counts desired-sign raw deltas at least 0.001 xP (lower Bruno, Mbeumo, Tavernier; higher Rogers, Palmer), then uses the raw net directional sum \`-ΔBruno -ΔMbeumo -ΔTavernier +ΔRogers +ΔPalmer\`. Ties are ordered by arm id. Every arm is retained, including unfavorable and zero-direction arms.\n\n${reportTable(ranked)}\n\nThe top arm changes only \`applyInSeasonForm\`'s team prior weight from 12 to 24. Because the cached GW1/GW2 team-xG rows have no opponent/venue fields, the joint team fit has ${history.teamXGJointFixtures} contextual fixtures across GW${history.teamXGJointGameweeks.join(", ")} here, so this arm is a one-gameweek shrinkage sensitivity and the team-decay arms are correctly zero on this input. Pulling those observations harder toward the saved preseason strengths changes the teams' fixture attack ratios and clean-sheet inputs in opposite directions: ${topDeltaText}.\n\nThe current selection model's alpha 0.60 arm is omitted because all five targets have at least 240 observed current-season minutes, which activates the role-established path that bypasses \`START_RATE_ALPHA\`; changing alpha therefore produces no target selection or xP delta on this frozen input.\n\n## Interpretation\n\nThese rows show scenario sensitivity and directional tuning on one frozen snapshot. The ClubElo values here are the saved snapshot used by the production path; the synthetic-input limitation applies to earlier historical backtests, not this run. This one-gameweek comparison is not accuracy evidence, and changing a global assumption can move the five players in the requested directions by construction. Accuracy claims require a separate walk-forward evaluation on held-out fixtures.\n\n## Reproduction\n\n\`npx tsx scripts/experiments/fdr-sensitivity-gw4.ts\`\n\nSaved input fetch times recorded in the JSON: ${fetched}.\n`;
}

async function main(): Promise<void> {
  const bootstrap = readEnvelope<Record<string, unknown>>(path.join(SNAPSHOT_DIR, "bootstrap.json")).data as never;
  const fixtures = readEnvelope<unknown[]>(path.join(SNAPSHOT_DIR, "fixtures.json")).data as never;
  const normalized = normalizeBootstrap(bootstrap, fixtures);
  const historical = await loadHistoricalBundle();
  if (!historical) throw new Error("Historical bundle is unavailable");
  const histories = frozenHistories(normalized);
  const enriched = enrichPlayersWithHistory(
    normalized.players,
    normalized.teams,
    normalized.events,
    historical,
    histories.teamXG,
    histories.playerForm,
    histories.starts,
    normalized.liveGameweek,
  );
  const playersById = new Map(enriched.players.map((player) => [player.id, player]));
  const priorStrengths = deriveTeamStrengths(normalized.teams).strengths;
  const historicalTeams = historicalSourceStrengths(historical);
  const cleanSheetNames = new Map(normalized.teams.map((team) => [team.id, team.shortName]));
  const baselineTargets: EvaluatedTarget[] = [];
  let maxComponentGap = 0;
  let maxAdjustmentGap = 0;
  for (const id of TARGET_IDS) {
    const player = playersById.get(id);
    if (!player) throw new Error(`Target player missing: ${id}`);
    const fixture = player.fixtures.find((item) => item.gameweek === GAMEWEEK);
    if (!fixture) throw new Error(`Target fixture missing: ${id}`);
    const production = projectPlayer(player, {
      horizon: 5,
      fixtureHorizon: 39 - GAMEWEEK,
      currentGameweek: CURRENT_GAMEWEEK,
      startGameweek: GAMEWEEK,
      teamStrengths: enriched.teamStrengths,
      cleanSheetStrengths: enriched.cleanSheetStrengths,
      historicalTeamStrengths: historicalTeams,
      playerForm: histories.playerForm,
    });
    const productionFixture = production.fixtures.find((item) => item.gameweek === GAMEWEEK);
    if (!productionFixture?.components) throw new Error(`Production fixture components missing: ${id}`);
    const local = localComponents(
      player,
      fixture,
      enriched.teamStrengths,
      enriched.cleanSheetStrengths,
      historicalTeams[id],
      histories.playerForm,
      BASELINE_CONFIG,
    );
    const difference = componentDiff(productionFixture.components, local);
    maxComponentGap = Math.max(maxComponentGap, difference.max);
    const productionAdjustment = calculateFixtureAdjustment(fixture, {
      ownTeam: enriched.teamStrengths[player.teamId],
      opponentTeam: enriched.teamStrengths[fixture.opponentTeamId],
      ownCleanSheet: enriched.cleanSheetStrengths[player.teamId],
      opponentCleanSheet: enriched.cleanSheetStrengths[fixture.opponentTeamId],
    });
    const localAdjustment = localFixtureAdjustmentForPlayer(
      player,
      fixture,
      enriched.teamStrengths,
      enriched.cleanSheetStrengths,
      BASELINE_CONFIG,
    );
    maxAdjustmentGap = Math.max(
      maxAdjustmentGap,
      Math.abs(productionAdjustment.attackMultiplier - localAdjustment.attackMultiplier),
      Math.abs(productionAdjustment.cleanSheetProbability - localAdjustment.cleanSheetProbability),
      Math.abs(productionAdjustment.expectedGoalsAgainst - localAdjustment.expectedGoalsAgainst),
    );
    baselineTargets.push({
      id,
      label: TARGET_LABELS[id],
      baseline: round3(productionFixture.components.total),
      value: round3(productionFixture.components.total),
      rawBaseline: productionFixture.components.total,
      rawValue: productionFixture.components.total,
      delta: 0,
      displayDelta: 0,
      components: productionFixture.components,
    });
  }
  const parityTolerance = 1e-9;
  if (maxComponentGap > parityTolerance || maxAdjustmentGap > parityTolerance) {
    throw new Error(`Baseline parity failed: component=${maxComponentGap} adjustment=${maxAdjustmentGap}`);
  }

  const baselineMap = new Map(baselineTargets.map((target) => [target.id, target]));
  const baselineSpec: VariantSpec = {
    id: "baseline_continuous_150",
    label: "Baseline continuous FDR 150",
    changedParameter: "none",
    note: "Production baseline; no parameter change.",
    config: BASELINE_CONFIG,
  };
  const baselineRow: EvaluatedVariant = {
    id: baselineSpec.id,
    label: baselineSpec.label,
    changedParameter: baselineSpec.changedParameter,
    note: baselineSpec.note,
    config: baselineSpec.config,
    desiredSignCount: 0,
    netDirectionalSum: 0,
    targets: baselineTargets,
  };
  const armRows = variantSpecs().map((spec) => evaluateVariant(
    spec,
    playersById,
    priorStrengths,
    histories.teamXG,
    histories.playerForm,
    historicalTeams,
    cleanSheetNames,
    baselineMap,
  ));
  const ranked = [baselineRow, ...armRows].sort((left, right) =>
    right.desiredSignCount - left.desiredSignCount ||
    right.netDirectionalSum - left.netDirectionalSum ||
    left.id.localeCompare(right.id));

  const inputRecords = INPUT_PATHS.map(inputRecord);
  const baselineOutput = {
    fdrDivisor: BASELINE_FDR_DIVISOR,
    currentGameweek: CURRENT_GAMEWEEK,
    targetGameweek: GAMEWEEK,
    strengthInputs: baselineTargets.map((target) => {
      const player = playersById.get(target.id);
      const fixture = player?.fixtures.find((item) => item.gameweek === GAMEWEEK);
      return {
        id: target.id,
        currentTeam: player ? enriched.teamStrengths[player.teamId] : undefined,
        opponentTeam: fixture ? enriched.teamStrengths[fixture.opponentTeamId] : undefined,
        historicalSourceTeam: historicalTeams[target.id],
      };
    }),
    targets: baselineTargets.map((target) => ({
      id: target.id,
      label: target.label,
      value: target.value,
      rawValue: round6(target.rawValue),
      fixture: playersById.get(target.id)?.fixtures.find((fixture) => fixture.gameweek === GAMEWEEK),
      selection: playersById.get(target.id)?.selection,
      components: target.components,
    })),
    parity: {
      tolerance: parityTolerance,
      maxComponentGap,
      maxAdjustmentGap,
    },
  };
  const result: Record<string, unknown> = {
    taskId: "fdr150_experiments",
    generatedAt: new Date().toISOString(),
    frozenInputSet: "Sept 10 2026 GW4 snapshots",
    source: {
      script: "scripts/experiments/fdr-sensitivity-gw4.ts",
      productionProjection: "lib/projections/projectPlayer.ts",
      productionFdr: "lib/clubElo.ts calculateContinuousClubEloFdr",
    },
    inputs: inputRecords,
    model: {
      baseline: BASELINE_CONFIG,
      variantsTested: variantSpecs().length,
      totalArmsIncludingBaseline: ranked.length,
      desiredSignThresholdRawXPoints: 0.001,
      ranking: ["desiredSignCountDescending", "netDirectionalSumDescending", "variantIdAscending"],
      desiredSigns: {
        lower: ["Bruno Fernandes", "Bryan Mbeumo", "Marcus Tavernier"],
        higher: ["Morgan Rogers", "Cole Palmer"],
      },
      omittedNoOpArm: {
        label: "START_RATE_ALPHA 0.60",
        reason: "All five targets have >=240 observed current-season minutes, so production selection uses the role-established path and bypasses START_RATE_ALPHA.",
      },
    },
    baseline: baselineOutput,
    frozenHistory: {
      teamXGRows: Object.values(histories.teamXG).reduce((sum, rows) => sum + rows.length, 0),
      teamXGRowsWithFixtureContext: Object.values(histories.teamXG)
        .flat()
        .filter((row) => row.opponentTeamId !== undefined && row.wasHome !== undefined).length,
      teamXGJointFixtures: Object.values(histories.teamXG)
        .flat()
        .filter((row) => row.wasHome === true && row.opponentTeamId !== undefined).length,
      teamXGJointGameweeks: [...new Set(Object.values(histories.teamXG)
        .flat()
        .filter((row) => row.wasHome === true && row.opponentTeamId !== undefined)
        .map((row) => row.gameweek)
        .filter((gameweek): gameweek is number => gameweek !== undefined))],
      playerFormRows: Object.values(histories.playerForm).reduce((sum, rows) => sum + rows.length, 0),
      startRows: Object.values(histories.starts).reduce((sum, rows) => sum + rows.length, 0),
      note: "Team-xG rows retain the cached GW1/GW2 context-free shape; player-rate rows derive fixture context from the normalized frozen fixtures, matching the production loaders. applyInSeasonForm therefore fits only the ten contextual GW3 fixtures.",
    },
    rankedArms: ranked.map((row, index) => ({
      rank: index + 1,
      id: row.id,
      label: row.label,
      changedParameter: row.changedParameter,
      note: row.note,
      config: row.config,
      desiredSignCount: row.desiredSignCount,
      netDirectionalSum: round6(row.netDirectionalSum),
      targets: row.targets.map((target) => ({
        id: target.id,
        label: target.label,
        baseline: target.baseline,
        value: target.value,
        rawBaseline: round6(target.rawBaseline),
        rawValue: round6(target.rawValue),
        delta: round6(target.delta),
        displayDelta: target.displayDelta,
        components: target.components,
      })),
    })),
  };
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(
    path.join(OUTPUT_DIR, "fdr-sensitivity-gw4.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(OUTPUT_DIR, "fdr-sensitivity-gw4.md"),
    buildReport(result, ranked),
    "utf8",
  );
  console.log(`wrote ${ranked.length} arms to scripts/experiments/fdr-sensitivity-gw4.json`);
  console.log(`baseline parity component=${maxComponentGap.toExponential(3)} adjustment=${maxAdjustmentGap.toExponential(3)}`);
  ranked.slice(0, 5).forEach((row, index) => {
    console.log(`${index + 1}. ${row.label}: ${row.desiredSignCount}/5, net=${row.netDirectionalSum.toFixed(6)}`);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
