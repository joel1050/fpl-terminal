/**
 * Rechecks the removed 240-minute start-frequency override against the
 * shipped historical-seeded EWMA, using production cameo normalization.
 *
 * Inputs are prepared adjacent-season corpora. Each target prediction uses
 * only earlier gameweeks, includes available zero-minute rows, skips double
 * gameweeks as role-history observations (as loadInSeasonStarts does), and
 * applies no historical injury/news flags.
 *
 *   BACKTEST_MULTI_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008 \
 *     npx tsx scripts/backtest/role-switch.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { HistoricalMatchStat, HistoricalPlayerRecord } from "@/lib/historical/types";
import { buildPlayerSelections } from "@/lib/availability/selection";
import {
  blendCameoRate,
  blendStartRate,
  MINUTES_FOR_START,
  START_RATE_ALPHA,
  type StartObservation,
} from "@/lib/availability/startRate";
import type { Player, Position } from "@/types/player";
import { buildFixturesFromMatchRows } from "./multiSeasonData";

const SEASONS = ["2023-24", "2024-25", "2025-26"] as const;
const BOOTSTRAPS = 2_000;
const DATA_ROOT = process.env.BACKTEST_MULTI_DATA_DIR;
if (!DATA_ROOT) throw new Error("Set BACKTEST_MULTI_DATA_DIR to the prepared multi-season data root.");

interface BacktestRow extends HistoricalMatchStat {
  gameweek: number;
  fixtureId: number;
  opponentTeamId: number;
  wasHome: boolean;
  minutes: number;
}

interface Anchor {
  historicalPlayerId: number;
  sourceHistoricalPlayerId: number;
  stats: HistoricalPlayerRecord["stats"];
}

interface PlayerGameweek {
  playerId: number;
  gameweek: number;
  teamId: number;
  minutes: number;
  fixtureCount: number;
}

interface Loss {
  season: string;
  gameweek: number;
  shipped: number;
  legacyOverride: number;
  gateActive: boolean;
}

interface Cluster {
  key: string;
  n: number;
  shippedSse: number;
  legacyOverrideSse: number;
}

interface SeasonResult {
  season: string;
  losses: Loss[];
  playerGameweeks: PlayerGameweek[];
  fixtureRows: number;
  missingFixtureRows: number;
  playerCount: number;
  anchoredPlayers: number;
  bootstrapClusters: Cluster[];
}

function read<T>(season: string, file: string): T {
  return JSON.parse(readFileSync(path.join(DATA_ROOT!, season, file), "utf8")) as T;
}

function previousSeason(season: string): string {
  const start = Number(season.slice(0, 4));
  return `${start - 1}-${String(start).slice(-2)}`;
}

function key(playerId: number, gameweek: number, teamId: number): string {
  return `${playerId}:${gameweek}:${teamId}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function fallbackStartRate(currentMinutes: number): number {
  if (currentMinutes <= 0) return 0.15;
  return clamp(0.1 + currentMinutes / 1_800, 0.15, 0.8);
}

/** Reconstructs the exact seed expression in selection.ts's historicalSignal. */
function previousRoleRates(
  stats: HistoricalPlayerRecord["stats"] | undefined,
  rows: readonly HistoricalMatchStat[],
): { start: number; cameo: number } | undefined {
  if (!stats && rows.length === 0) return undefined;
  const starts = Number.isFinite(stats?.starts)
    ? Math.max(0, stats!.starts!)
    : rows.filter((row) => row.minutes >= MINUTES_FOR_START).length;
  const sample = Math.max(rows.length, starts, stats?.minutes ? Math.ceil(stats.minutes / 90) : 0);
  if (sample === 0) return undefined;
  const start = clamp(starts / sample, 0, 1);
  const appearances = rows.filter((row) => row.minutes > 0).length;
  const cameo = clamp(Math.max(0, appearances - starts) / sample, 0, 1 - start);
  return { start, cameo };
}

function fallbackCameoRate(currentMinutes: number): number {
  return currentMinutes > 0 ? 0.12 : 0.08;
}

function roundedStartProbability(start: number, cameo: number): number {
  const total = start + cameo;
  const normalized = total <= 1 ? clamp(start, 0, 1) : start / total;
  return Math.round(clamp(normalized, 0, 1) * 1_000) / 1_000;
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function pairedClusterInterval(clusters: readonly Cluster[], seed: number): [number, number] {
  const usable = clusters.filter((cluster) => cluster.n > 0);
  assert.ok(usable.length > 1, "Need at least two gameweek clusters for an interval.");
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const deltas: number[] = [];
  for (let draw = 0; draw < BOOTSTRAPS; draw += 1) {
    let shippedSse = 0;
    let legacyOverrideSse = 0;
    let n = 0;
    for (let i = 0; i < usable.length; i += 1) {
      const cluster = usable[Math.floor(random() * usable.length)];
      shippedSse += cluster.shippedSse;
      legacyOverrideSse += cluster.legacyOverrideSse;
      n += cluster.n;
    }
    deltas.push((legacyOverrideSse - shippedSse) / n);
  }
  deltas.sort((a, b) => a - b);
  return [percentile(deltas, 0.025), percentile(deltas, 0.975)];
}

function summarize(losses: readonly Loss[], seed: number): {
  n: number;
  shipped: number;
  legacyOverride: number;
  delta: number;
  ci: [number, number];
  clusters: Cluster[];
} {
  const byGw = new Map<string, Cluster>();
  for (const loss of losses) {
    const clusterKey = `${loss.season}:${loss.gameweek}`;
    const cluster = byGw.get(clusterKey) ?? {
      key: clusterKey,
      n: 0,
      shippedSse: 0,
      legacyOverrideSse: 0,
    };
    cluster.n += 1;
    cluster.shippedSse += loss.shipped;
    cluster.legacyOverrideSse += loss.legacyOverride;
    byGw.set(clusterKey, cluster);
  }
  const clusters = [...byGw.values()];
  const n = clusters.reduce((sum, cluster) => sum + cluster.n, 0);
  const shippedSse = clusters.reduce((sum, cluster) => sum + cluster.shippedSse, 0);
  const legacyOverrideSse = clusters.reduce((sum, cluster) => sum + cluster.legacyOverrideSse, 0);
  return {
    n,
    shipped: shippedSse / n,
    legacyOverride: legacyOverrideSse / n,
    delta: (legacyOverrideSse - shippedSse) / n,
    ci: pairedClusterInterval(clusters, seed),
    clusters,
  };
}

function buildPlayerGameweeks(
  rows: readonly BacktestRow[],
  fixtureRows: readonly ReturnType<typeof buildFixturesFromMatchRows>[number][],
): { groups: PlayerGameweek[]; missingFixtureRows: number } {
  const fixtureById = new Map(fixtureRows.map((fixture) => [fixture.fixtureId, fixture]));
  const fixturesPerTeamGw = new Map<string, number>();
  for (const fixture of fixtureRows) {
    for (const teamId of [fixture.homeTeamId, fixture.awayTeamId]) {
      const teamGw = `${teamId}:${fixture.gameweek}`;
      fixturesPerTeamGw.set(teamGw, (fixturesPerTeamGw.get(teamGw) ?? 0) + 1);
    }
  }

  const grouped = new Map<string, PlayerGameweek>();
  let missingFixtureRows = 0;
  for (const row of rows) {
    const fixture = fixtureById.get(row.fixtureId);
    if (!fixture) {
      missingFixtureRows += 1;
      continue;
    }
    const teamId = row.wasHome ? fixture.homeTeamId : fixture.awayTeamId;
    const groupKey = key(row.historicalPlayerId, row.gameweek, teamId);
    const group = grouped.get(groupKey) ?? {
      playerId: row.historicalPlayerId,
      gameweek: row.gameweek,
      teamId,
      minutes: 0,
      fixtureCount: 0,
    };
    group.minutes += row.minutes;
    group.fixtureCount += 1;
    grouped.set(groupKey, group);
  }

  return {
    groups: [...grouped.values()].map((group) => ({
      ...group,
      fixtureCount: fixturesPerTeamGw.get(`${group.teamId}:${group.gameweek}`) ?? group.fixtureCount,
    })).sort((a, b) => a.gameweek - b.gameweek || a.playerId - b.playerId || a.teamId - b.teamId),
    missingFixtureRows,
  };
}

function makePlayer(
  meta: HistoricalPlayerRecord,
  teamId: number,
  currentMinutes: number,
): Player {
  return {
    id: meta.historicalPlayerId,
    firstName: meta.displayName,
    lastName: "",
    displayName: meta.displayName,
    teamId,
    teamName: meta.teamName ?? "",
    teamShortName: "",
    position: (meta.position ?? "MID") as Position,
    priceTenths: 50,
    ownership: 0,
    status: "a",
    chanceOfPlaying: null,
    current: {
      totalPoints: 0,
      minutes: currentMinutes,
      goals: 0,
      assists: 0,
      cleanSheets: 0,
      bonus: 0,
    },
    fixtures: [],
  };
}

function runSeason(season: string): SeasonResult {
  const targetRows = read<BacktestRow[]>(season, "historical-match-stats.json");
  const targetPlayers = read<HistoricalPlayerRecord[]>(season, "historical-players.json");
  const anchors = read<Anchor[]>(season, "previous-player-anchors.json");
  const priorRows = read<HistoricalMatchStat[]>(previousSeason(season), "historical-match-stats.json");
  const priorById = new Map<number, HistoricalMatchStat[]>();
  for (const row of priorRows) {
    const list = priorById.get(row.historicalPlayerId) ?? [];
    list.push(row);
    priorById.set(row.historicalPlayerId, list);
  }

  const anchorById = new Map(anchors.map((anchor) => [anchor.historicalPlayerId, anchor]));
  const priorRowsByTargetId = new Map<number, HistoricalMatchStat[]>();
  const priorStatsByTargetId = new Map<number, Map<number, HistoricalPlayerRecord["stats"]>>();
  for (const anchor of anchors) {
    const matches = (priorById.get(anchor.sourceHistoricalPlayerId) ?? []).map((row) => ({
      ...row,
      historicalPlayerId: anchor.historicalPlayerId,
    }));
    priorRowsByTargetId.set(anchor.historicalPlayerId, matches);
    priorStatsByTargetId.set(anchor.historicalPlayerId, new Map([[anchor.historicalPlayerId, anchor.stats]]));
  }

  const fixtureRows = buildFixturesFromMatchRows(targetRows);
  const { groups, missingFixtureRows } = buildPlayerGameweeks(targetRows, fixtureRows);
  const rowsByPlayer = new Map<number, PlayerGameweek[]>();
  const groupsByPlayerTeam = new Map<string, PlayerGameweek[]>();
  for (const group of groups) {
    const byPlayer = rowsByPlayer.get(group.playerId) ?? [];
    byPlayer.push(group);
    rowsByPlayer.set(group.playerId, byPlayer);
    const playerTeamKey = `${group.playerId}:${group.teamId}`;
    const byPlayerTeam = groupsByPlayerTeam.get(playerTeamKey) ?? [];
    byPlayerTeam.push(group);
    groupsByPlayerTeam.set(playerTeamKey, byPlayerTeam);
  }

  const metaById = new Map(targetPlayers.map((player) => [player.historicalPlayerId, player]));
  const losses: Loss[] = [];
  for (const target of groups) {
    const meta = metaById.get(target.playerId);
    if (!meta) continue;
    const sameTeamHistory = groupsByPlayerTeam.get(`${target.playerId}:${target.teamId}`) ?? [];
    const eligibleHistory = sameTeamHistory.filter((row) =>
      row.gameweek < target.gameweek && row.fixtureCount === 1);
    const observations: StartObservation[] = eligibleHistory.map((row) => ({
      started: row.minutes >= MINUTES_FOR_START,
      appeared: row.minutes > 0,
      minutes: row.minutes,
    }));
    const observedMinutes = observations.reduce((sum, observation) => sum + (observation.minutes ?? 0), 0);
    const gateActive = observedMinutes >= 240;

    const currentMinutes = (rowsByPlayer.get(target.playerId) ?? [])
      .filter((row) => row.gameweek < target.gameweek)
      .reduce((sum, row) => sum + row.minutes, 0);
    const player = makePlayer(meta, target.teamId, currentMinutes);
    const anchor = anchorById.get(target.playerId);
    const historicalRows = priorRowsByTargetId.get(target.playerId) ?? [];
    const selection = buildPlayerSelections([player], {
      ...(priorStatsByTargetId.has(target.playerId)
        ? { historicalStats: priorStatsByTargetId.get(target.playerId) }
        : {}),
      historicalMatchStats: historicalRows,
      historical: {
        players: [],
        matchStats: [],
        playerMappings: [{
          currentPlayerId: target.playerId,
          historicalPlayerId: target.playerId,
          confidence: "EXACT",
        }],
      },
      startHistory: { [target.playerId]: observations },
    }).get(target.playerId);
    assert.ok(selection, `Missing production selection for ${target.playerId} GW${target.gameweek}.`);

    const historicalSeed = previousRoleRates(anchor?.stats, historicalRows);
    const seedStart = historicalSeed?.start
      ?? (observations.length > 0 ? 0.15 : fallbackStartRate(currentMinutes));
    const seedCameo = historicalSeed?.cameo
      ?? (observations.length > 0 ? 0.08 : fallbackCameoRate(currentMinutes));
    const recursiveRate = blendStartRate(seedStart, observations);
    const currentStarts = observations.filter((observation) => observation.started).length;
    const currentAppearances = observations.filter((observation) => observation.appeared).length;
    const roleCameo = gateActive
      ? Math.max(0, currentAppearances - currentStarts) / observations.length
      : blendCameoRate(seedStart, seedCameo, observations);
    const fallback = fallbackStartRate(currentMinutes);
    const seedWeight = observations.length > 0 ? 0 : 0.25;
    const candidateStart = recursiveRate * (1 - seedWeight) + fallback * seedWeight;
    const candidateCameo = roleCameo * (1 - seedWeight)
      + fallbackCameoRate(currentMinutes) * seedWeight;
    const expectedCandidate = roundedStartProbability(candidateStart, candidateCameo);
    assert.ok(
      Math.abs(selection.startProbability - expectedCandidate) <= 0.00001,
      `Production candidate parity failed for ${season} ${target.playerId} GW${target.gameweek}: got ${selection.startProbability}, expected ${expectedCandidate} (obs=${observations.length}, priorRows=${historicalRows.length}, anchor=${Boolean(anchor)}, current=${currentMinutes}, seed=${seedStart}, gate=${gateActive}).`,
    );
    const legacyRoleStart = gateActive ? currentStarts / observations.length : recursiveRate;
    const legacyStart = legacyRoleStart * (1 - seedWeight) + fallback * seedWeight;
    const legacyOverride = roundedStartProbability(legacyStart, candidateCameo);

    const actual = target.minutes >= MINUTES_FOR_START ? 1 : 0;
    losses.push({
      season,
      gameweek: target.gameweek,
      shipped: (selection.startProbability - actual) ** 2,
      legacyOverride: (legacyOverride - actual) ** 2,
      gateActive,
    });
  }

  assert.ok(losses.length > 0, `No player-gameweek observations found in ${season}.`);
  return {
    season,
    losses,
    playerGameweeks: groups,
    fixtureRows: targetRows.length,
    missingFixtureRows,
    playerCount: new Set(groups.map((row) => row.playerId)).size,
    anchoredPlayers: anchors.length,
    bootstrapClusters: summarize(losses, 20261008 + Number(season.slice(0, 4))).clusters,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function main(): void {
  const results = SEASONS.map(runSeason);
  const allLosses = results.flatMap((result) => result.losses);
  const heldOut = results.filter((result) => result.season === "2024-25" || result.season === "2025-26");
  const pooled = summarize(allLosses, 20261008);
  const holdout = summarize(heldOut.flatMap((result) => result.losses), 20261009);

  console.log("Removed 240-minute start-frequency override vs shipped EWMA");
  console.log(`Alpha ${START_RATE_ALPHA}; a start is ${MINUTES_FOR_START}+ minutes; ${BOOTSTRAPS.toLocaleString()} gameweek-cluster bootstrap draws.`);
  console.log("Delta is legacy override Brier minus shipped Brier; positive means removing the override improves calibration.");
  console.log("Predictions use only prior gameweeks; every observed player-gameweek row counts, including 0-minute rows.");
  console.log("Double gameweeks are scored once at player-GW level and skipped as history, matching the production loader's eligibility rule.");
  console.log("No historical status, injury, or predicted-lineup evidence is supplied to either arm.");

  for (const result of results) {
    const summary = summarize(result.losses, 20261008 + Number(result.season.slice(0, 4)));
    const dnp = result.playerGameweeks.filter((row) => row.minutes === 0).length;
    const nonStarts = result.playerGameweeks.filter((row) => row.minutes > 0 && row.minutes < MINUTES_FOR_START).length;
    const started = result.playerGameweeks.filter((row) => row.minutes >= MINUTES_FOR_START).length;
    const active = result.losses.filter((row) => row.gateActive).length;
    const gws = new Set(result.losses.map((row) => row.gameweek)).size;
    console.log(`\n${result.season}: ${summary.n.toLocaleString()} player-GWs (${result.playerCount} players, ${gws} GWs, ${result.fixtureRows.toLocaleString()} player-fixture rows, ${result.missingFixtureRows} unlinked)`);
    console.log(`  outcomes: ${started.toLocaleString()} starts (${pct(started / summary.n)}), ${dnp.toLocaleString()} DNP (${pct(dnp / summary.n)}), ${nonStarts.toLocaleString()} cameo/short (${pct(nonStarts / summary.n)})`);
    console.log(`  anchors: ${result.anchoredPlayers} mapped prior-season players; 240-minute gate active for ${active.toLocaleString()} predictions (${pct(active / summary.n)})`);
    console.log(`  shipped Brier ${summary.shipped.toFixed(5)}; legacy override Brier ${summary.legacyOverride.toFixed(5)}; delta ${summary.delta >= 0 ? "+" : ""}${summary.delta.toFixed(5)} [${summary.ci[0] >= 0 ? "+" : ""}${summary.ci[0].toFixed(5)}, ${summary.ci[1] >= 0 ? "+" : ""}${summary.ci[1].toFixed(5)}]`);
    const afterGate = summarize(result.losses.filter((row) => row.gateActive), 20262008 + Number(result.season.slice(0, 4)));
    console.log(`  after gate (${afterGate.n.toLocaleString()} predictions): shipped ${afterGate.shipped.toFixed(5)}; legacy override ${afterGate.legacyOverride.toFixed(5)}; delta ${afterGate.delta >= 0 ? "+" : ""}${afterGate.delta.toFixed(5)} [${afterGate.ci[0] >= 0 ? "+" : ""}${afterGate.ci[0].toFixed(5)}, ${afterGate.ci[1] >= 0 ? "+" : ""}${afterGate.ci[1].toFixed(5)}]`);
  }

  console.log(`\nAll anchored seasons (${pooled.n.toLocaleString()} player-GWs): shipped ${pooled.shipped.toFixed(5)}, legacy override ${pooled.legacyOverride.toFixed(5)}, delta ${pooled.delta >= 0 ? "+" : ""}${pooled.delta.toFixed(5)} [${pooled.ci[0] >= 0 ? "+" : ""}${pooled.ci[0].toFixed(5)}, ${pooled.ci[1] >= 0 ? "+" : ""}${pooled.ci[1].toFixed(5)}]`);
  console.log(`Held-out 2024/25-2025/26 (${holdout.n.toLocaleString()} player-GWs): shipped ${holdout.shipped.toFixed(5)}, legacy override ${holdout.legacyOverride.toFixed(5)}, delta ${holdout.delta >= 0 ? "+" : ""}${holdout.delta.toFixed(5)} [${holdout.ci[0] >= 0 ? "+" : ""}${holdout.ci[0].toFixed(5)}, ${holdout.ci[1] >= 0 ? "+" : ""}${holdout.ci[1].toFixed(5)}]`);
}

main();
