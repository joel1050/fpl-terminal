/** Walk-forward comparison of team-form weighting schedules. */
import { calculateFixtureAdjustment } from "@/lib/projections/fixtureAdjustment";
import type { TeamMatchXG } from "@/lib/historical/inSeasonForm";
import type { TeamStrength } from "@/types/projection";
import { loadSeason } from "./season";

const FIRST_GAMEWEEK = 6;
const DECAY = 0.9;
const PRIOR_MATCHES = 12;
const BOOTSTRAP = 4_000;

interface Schedule {
  name: string;
  share: (n: number, effective: number) => number;
}

const sweepXs = [...Array.from({ length: 501 }, (_, x) => x), 1_000, 10_000, Number.POSITIVE_INFINITY];
const schedules: Schedule[] = [
  { name: "current matches/(matches+12)", share: (n: number) => n / (n + PRIOR_MATCHES) },
  ...sweepXs.map((x) => ({ name: `matches/(matches+${x})`, share: (n: number) => x === 0 ? 1 : n / (n + x) })),
  { name: "linear matches/38", share: (n: number) => Math.min(n / 38, 1) },
];

const reportedIndexes = [0, 1 + PRIOR_MATCHES, 1 + 144, schedules.length - 1];
const strengthTiers = [0.84, 0.92, 1, 1.08, 1.16] as const;

interface Case {
  gameweek: number;
  actualCleanSheet: number;
  actualGoalsAgainst: number;
  predictions: { cleanSheet: number; goalsAgainst: number }[];
}

function productionLikePriors(priors: Record<number, TeamStrength>): Record<number, TeamStrength> {
  const nearest = (value: number) => strengthTiers.reduce((best, tier) =>
    Math.abs(tier - value) < Math.abs(best - value) ? tier : best);
  const entries = Object.entries(priors).map(([key, prior]) => ({
    teamId: Number(key),
    attack: nearest((prior.attackHome + prior.attackAway) / 2),
    defence: nearest((prior.defenceHome + prior.defenceAway) / 2),
  }));
  const attackMean = entries.reduce((sum, item) => sum + item.attack, 0) / entries.length;
  const defenceMean = entries.reduce((sum, item) => sum + item.defence, 0) / entries.length;
  return Object.fromEntries(entries.map((item) => {
    const attack = item.attack / attackMean;
    const defence = item.defence / defenceMean;
    return [item.teamId, { teamId: item.teamId, attackHome: attack, attackAway: attack, defenceHome: defence, defenceAway: defence, overall: (attack + defence) / 2 }];
  }));
}

function strengths(
  priors: Record<number, TeamStrength>,
  history: Record<number, readonly TeamMatchXG[]>,
  schedule: (n: number, effective: number) => number,
): Record<number, TeamStrength> {
  const allXg = Object.values(history).flatMap((matches) => matches.map((match) => match.xgFor));
  const leagueAverage = Math.max(allXg.reduce((sum, xg) => sum + xg, 0) / Math.max(allXg.length, 1), 0.15);
  const result: Record<number, TeamStrength> = {};

  for (const [key, prior] of Object.entries(priors)) {
    const teamId = Number(key);
    const matches = history[teamId] ?? [];
    const priorAttack = (prior.attackHome + prior.attackAway) / 2;
    const priorDefence = (prior.defenceHome + prior.defenceAway) / 2;
    if (matches.length === 0) {
      result[teamId] = { teamId, attackHome: priorAttack, attackAway: priorAttack, defenceHome: priorDefence, defenceAway: priorDefence, overall: (priorAttack + priorDefence) / 2 };
      continue;
    }

    let effective = 0;
    let xgFor = 0;
    let xgAgainst = 0;
    for (let index = 0; index < matches.length; index += 1) {
      const weight = DECAY ** index;
      const match = matches[matches.length - 1 - index];
      effective += weight;
      xgFor += weight * match.xgFor;
      xgAgainst += weight * match.xgAgainst;
    }
    const currentAttack = (xgFor / effective) / leagueAverage;
    const currentDefence = leagueAverage / Math.max(xgAgainst / effective, 0.15);
    const currentShare = schedule(matches.length, effective);
    const attack = priorAttack * (1 - currentShare) + currentAttack * currentShare;
    const defence = priorDefence * (1 - currentShare) + currentDefence * currentShare;
    result[teamId] = { teamId, attackHome: attack, attackAway: attack, defenceHome: defence, defenceAway: defence, overall: (attack + defence) / 2 };
  }
  return result;
}

function auc(cases: readonly Case[], index: number): number {
  const sorted = cases.map((item) => ({ score: item.predictions[index].cleanSheet, actual: item.actualCleanSheet }))
    .sort((a, b) => a.score - b.score);
  let rankSum = 0;
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].score === sorted[start].score) end += 1;
    const averageRank = (start + 1 + end) / 2;
    for (let i = start; i < end; i += 1) if (sorted[i].actual) rankSum += averageRank;
    start = end;
  }
  const positives = sorted.reduce((sum, item) => sum + item.actual, 0);
  const negatives = sorted.length - positives;
  return (rankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function brier(cases: readonly Case[], index: number): number {
  return cases.reduce((sum, item) => sum + (item.predictions[index].cleanSheet - item.actualCleanSheet) ** 2, 0) / cases.length;
}

function report(label: string, cases: readonly Case[]): void {
  const byGameweek = new Map<number, Case[]>();
  for (const item of cases) (byGameweek.get(item.gameweek) ?? byGameweek.set(item.gameweek, []).get(item.gameweek)!).push(item);
  const gameweeks = [...byGameweek.keys()];
  let seed = 20260901;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const samples = Array.from({ length: BOOTSTRAP }, () =>
    Array.from({ length: gameweeks.length }, () => gameweeks[Math.floor(random() * gameweeks.length)]));
  const baseline = brier(cases, 0);

  console.log(`\n${label}: ${cases.length} team-fixtures`);
  console.log("schedule                              share@23  Brier   dBrier [95% CI]          AUC    logloss  GA RMSE");
  reportedIndexes.forEach((index) => {
    const schedule = schedules[index];
    const score = brier(cases, index);
    const logloss = -cases.reduce((sum, item) => {
      const p = item.predictions[index].cleanSheet;
      return sum + (item.actualCleanSheet ? Math.log(p) : Math.log(1 - p));
    }, 0) / cases.length;
    const goalsRmse = Math.sqrt(cases.reduce((sum, item) =>
      sum + (item.predictions[index].goalsAgainst - item.actualGoalsAgainst) ** 2, 0) / cases.length);
    const effective23 = (1 - DECAY ** 23) / (1 - DECAY);
    const share23 = schedule.share(23, effective23);
    const deltas = samples.map((sample) => {
      const rows = sample.flatMap((gameweek) => byGameweek.get(gameweek)!);
      return brier(rows, index) - brier(rows, 0);
    }).sort((a, b) => a - b);
    const lo = deltas[Math.floor(BOOTSTRAP * 0.025)];
    const hi = deltas[Math.floor(BOOTSTRAP * 0.975)];
    console.log(`${schedule.name.padEnd(37)} ${(share23 * 100).toFixed(1).padStart(5)}%   ${score.toFixed(4)}  ${(score - baseline >= 0 ? "+" : "") + (score - baseline).toFixed(4)} [${lo.toFixed(4)}, ${hi.toFixed(4)}]  ${auc(cases, index).toFixed(3)}   ${logloss.toFixed(4)}   ${goalsRmse.toFixed(3)}`);
  });
}

function sweepReport(label: string, cases: readonly Case[]): void {
  const ranked = sweepXs.map((x, offset) => {
    const index = offset + 1;
    return { x, brier: brier(cases, index), auc: auc(cases, index) };
  }).sort((a, b) => a.brier - b.brier || b.auc - a.auc);
  console.log(`\n${label} n/(n+x) sweep, best Brier:`);
  console.log("x     share@23  share@38  Brier    AUC");
  for (const row of ranked.slice(0, 10)) {
    console.log(`${String(row.x).padEnd(5)} ${(23 / (23 + row.x) * 100).toFixed(1).padStart(6)}%   ${(38 / (38 + row.x) * 100).toFixed(1).padStart(6)}%   ${row.brier.toFixed(5)}  ${row.auc.toFixed(3)}`);
  }
}

function crossValidate(cases: readonly Case[]): void {
  let selectedSquaredError = 0;
  let currentSquaredError = 0;
  const selected: number[] = [];
  for (let fold = 0; fold < 5; fold += 1) {
    const test = cases.filter((item) => item.gameweek % 5 === fold);
    const train = cases.filter((item) => item.gameweek % 5 !== fold);
    const best = sweepXs.map((x, offset) => ({ x, index: offset + 1, score: brier(train, offset + 1) }))
      .sort((a, b) => a.score - b.score)[0];
    selected.push(best.x);
    selectedSquaredError += test.reduce((sum, item) =>
      sum + (item.predictions[best.index].cleanSheet - item.actualCleanSheet) ** 2, 0);
    currentSquaredError += test.reduce((sum, item) =>
      sum + (item.predictions[0].cleanSheet - item.actualCleanSheet) ** 2, 0);
  }
  console.log(`\n5-fold gameweek CV selected x: ${selected.join(", ")}`);
  console.log(`held-out Brier: n/(n+x) ${(selectedSquaredError / cases.length).toFixed(5)}; current ${(currentSquaredError / cases.length).toFixed(5)}`);
}

function main(): void {
  const season = loadSeason();
  const priors = productionLikePriors(season.priorStrengths);
  const history: Record<number, TeamMatchXG[]> = {};
  const cases: Case[] = [];
  const push = (teamId: number, xgFor: number, xgAgainst: number) =>
    (history[teamId] ??= []).push({ xgFor, xgAgainst });

  for (let gameweek = 1; gameweek <= 38; gameweek += 1) {
    if (gameweek >= FIRST_GAMEWEEK) {
      const variants = schedules.map((schedule) => strengths(priors, history, schedule.share));
      for (const fixture of season.fixturesByGameweek.get(gameweek) ?? []) {
        for (const side of ["home", "away"] as const) {
          const isHome = side === "home";
          const teamId = isHome ? fixture.homeTeamId : fixture.awayTeamId;
          const opponentId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
          const actualGoalsAgainst = isHome ? fixture.awayGoals : fixture.homeGoals;
          const predictions = variants.map((variant) => {
            const adjustment = calculateFixtureAdjustment(
              { gameweek, opponentTeamId: opponentId, opponentShortName: "OPP", isHome, difficulty: 3 },
              { ownTeam: variant[teamId], opponentTeam: variant[opponentId] },
            );
            return { cleanSheet: adjustment.cleanSheetProbability, goalsAgainst: adjustment.expectedGoalsAgainst };
          });
          cases.push({ gameweek, actualCleanSheet: actualGoalsAgainst === 0 ? 1 : 0, actualGoalsAgainst, predictions });
        }
      }
    }
    for (const fixture of season.fixturesByGameweek.get(gameweek) ?? []) {
      push(fixture.homeTeamId, fixture.homeXg, fixture.awayXg);
      push(fixture.awayTeamId, fixture.awayXg, fixture.homeXg);
    }
  }

  if (process.env.TEAM_FORM_SWEEP_JSON === "1") {
    console.log(JSON.stringify({
      cases: cases.length,
      current: brier(cases, 0),
      sweep: sweepXs.map((x, offset) => ({ x: Number.isFinite(x) ? x : null, brier: brier(cases, offset + 1) })),
    }));
    return;
  }

  report("GW6-38", cases);
  report("GW20-38", cases.filter((item) => item.gameweek >= 20));
  report("GW24-38", cases.filter((item) => item.gameweek >= 24));
  sweepReport("GW6-38", cases);
  sweepReport("GW20-38", cases.filter((item) => item.gameweek >= 20));
  sweepReport("GW24-38", cases.filter((item) => item.gameweek >= 24));
  crossValidate(cases);
}

main();
