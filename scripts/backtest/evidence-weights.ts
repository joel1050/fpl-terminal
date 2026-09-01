/**
 * Tests reliability-derived current-season weights against the shipped model.
 *
 * Gameweeks 1-12 stand in for the previous-season anchor. Gameweeks 13-38 are
 * walked forward, so every prediction sees only earlier rows. Total FPL points
 * are targets only; they never choose a weight or enter a predictor.
 *
 *   npx tsx scripts/backtest/evidence-weights.ts
 */
import { estimateExpectedMinutes } from "@/lib/projections/expectedMinutes";
import type { PlayerMatchRate } from "@/types/projection";
import type { Player } from "@/types/player";
import { expectedPoints, playerRates, type RateOverrides } from "./xp";
import { formBefore, loadSeason, playerAt, strengthsBefore, type MatchRow } from "./season";
import { BASELINE } from "./variants";

const ANCHOR_THROUGH = Number(process.argv[2] ?? 12);
const MINUTES_K = 0.7;
const START_K = 1.2;
const XG_K = 2;
const XA_K = 4.5;
const WINSOR_RATIO = 2.5;
const BOOTSTRAPS = Number(process.env.BACKTEST_BOOTSTRAPS ?? 2_000);
const RATE_SPLITS = [
  { name: "10 / 24 legacy", current: 10, previous: 24 },
  { name: "previous only", current: 0, previous: 24 },
  { name: "10 / 0", current: 10, previous: 0 },
  { name: "38 / 0", current: 38, previous: 0 },
  { name: "10 / 10", current: 10, previous: 10 },
  { name: "17 / 24", current: 17, previous: 24 },
  { name: "17 / 17", current: 17, previous: 17 },
  { name: "24 / 24", current: 24, previous: 24 },
  { name: "24 / 10", current: 24, previous: 10 },
  { name: "38 / 38", current: 38, previous: 38 },
  { name: "38 / 10", current: 38, previous: 10 },
] as const;
const CURRENT_CAP_SWEEP = Array.from({ length: 19 }, (_, index) => index + 20);
const PREVIOUS_WEIGHT_SWEEP = Array.from({ length: 20 }, (_, index) => index + 1);
const DECAY_SWEEP = Array.from({ length: 21 }, (_, index) => (80 + index) / 100);

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mean = (xs: readonly number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const rmse = (errors: readonly number[]) => Math.sqrt(mean(errors.map((x) => x * x)));

function anchorRows(rows: readonly MatchRow[]) {
  return rows.filter((row) => row.gameweek <= ANCHOR_THROUGH);
}

function currentRows(rows: readonly MatchRow[], gameweek: number) {
  return rows.filter((row) => row.gameweek > ANCHOR_THROUGH && row.gameweek < gameweek);
}

function starts(rows: readonly MatchRow[]) {
  return rows.filter((row) => row.minutes >= 60).length;
}

function rolePrediction(player: Player, anchor: readonly MatchRow[], current: readonly MatchRow[]) {
  const priorStartRate = starts(anchor) / anchor.length;
  const priorAverageMinutes = mean(anchor.map((row) => row.minutes));
  if (current.length === 0) {
    const minutes = 22 + 60 * priorStartRate;
    return { minutes, startProbability: priorStartRate };
  }

  const n = current.length;
  const currentStartRate = starts(current) / n;
  const currentAverageMinutes = mean(current.map((row) => row.minutes));
  const startWeight = n / (n + START_K);
  const minutesWeight = n / (n + MINUTES_K);
  const startProbability = priorStartRate * (1 - startWeight) + currentStartRate * startWeight;
  const averageMinutes = priorAverageMinutes * (1 - minutesWeight) + currentAverageMinutes * minutesWeight;
  return {
    minutes: clamp(0.65 * (22 + 60 * startProbability) + 0.35 * averageMinutes, 0, 90),
    startProbability,
  };
}

function baselineMinutes(player: Player, anchor: readonly MatchRow[], current: readonly MatchRow[]) {
  const historical = {
    ...player.historical!,
    minutes: anchor.reduce((sum, row) => sum + row.minutes, 0),
    starts: starts(anchor),
  };
  const currentMinutes = current.reduce((sum, row) => sum + row.minutes, 0);
  return estimateExpectedMinutes({
    ...player,
    historical,
    current: { ...player.current, minutes: currentMinutes },
  }, {
    currentGameweek: Math.max(current.length, 1),
    recentMatches: Math.max(current.length, 1),
  });
}

function anchorRate(player: Player, field: "expectedGoals" | "expectedAssists") {
  const historical = player.historical;
  return historical && historical.minutes > 0
    ? ((historical[field] ?? 0) / historical.minutes) * 90
    : 0;
}

function winsoriseForm(player: Player, form: readonly PlayerMatchRate[]): PlayerMatchRate[] {
  const prior = anchorRate(player, "expectedGoals") + anchorRate(player, "expectedAssists");
  const minutes = form.reduce((sum, row) => sum + row.minutes, 0);
  if (prior <= 0 || minutes <= 0) return [...form];
  const observed = form.reduce((sum, row) => sum + row.xg + row.xa, 0) / minutes * 90;
  if (observed <= 0) return [...form];
  const capped = clamp(observed, prior / WINSOR_RATIO, prior * WINSOR_RATIO);
  const scale = capped / observed;
  return form.map((row) => ({ ...row, xg: row.xg * scale, xa: row.xa * scale }));
}

function ratesAt(player: Player, form: readonly PlayerMatchRate[], gameweek: number) {
  const anchorMatches = Math.max((player.historical?.minutes ?? 0) / 90, 1);
  const shared: RateOverrides = { formDecay: 1, formPriorWeight: anchorMatches };
  const equal = playerRates(player, form, gameweek, shared);
  const slowXa = playerRates(player, form, gameweek, {
    formDecay: 1,
    formPriorWeight: anchorMatches * (XA_K / XG_K),
  });
  const winsor = winsoriseForm(player, form);
  const equalWinsor = playerRates(player, winsor, gameweek, shared);
  const slowXaWinsor = playerRates(player, winsor, gameweek, {
    formDecay: 1,
    formPriorWeight: anchorMatches * (XA_K / XG_K),
  });
  const rates: Record<string, ReturnType<typeof playerRates>> = {
    shipped: playerRates(player, form, gameweek),
    equal,
    metric: { ...equal, xa: slowXa.xa },
    equalWinsor,
    metricWinsor: { ...equalWinsor, xa: slowXaWinsor.xa },
  };
  for (const split of RATE_SPLITS) {
    rates[`split:${split.name}`] = playerRates(player, form, gameweek, {
      formDecay: split.current === 0 ? 0.9 : 1 - 1 / split.current,
      formPriorWeight: split.current === 0 ? 1e9 : split.previous,
    });
  }
  for (const current of CURRENT_CAP_SWEEP) {
    rates[`sweep:${current}`] = playerRates(player, form, gameweek, {
      formDecay: 1 - 1 / current,
      formPriorWeight: 10,
    });
  }
  for (const previous of PREVIOUS_WEIGHT_SWEEP) {
    rates[`previous-sweep:${previous}`] = playerRates(player, form, gameweek, {
      formDecay: 0.95,
      formPriorWeight: previous,
    });
  }
  for (const decay of DECAY_SWEEP) {
    rates[`decay-sweep:${decay}`] = playerRates(player, form, gameweek, {
      formDecay: decay,
      formPriorWeight: 10,
    });
  }
  return rates;
}

interface Case {
  gameweek: number;
  actualMinutes: number;
  actualStart: number;
  actualPoints: number;
  baselineMinutes: number;
  proposedMinutes: number;
  baselineStartProbability: number;
  proposedStartProbability: number;
  xp: Record<string, number>;
  rate?: Record<string, { xg: number; xa: number }>;
}

function collect(): Case[] {
  const season = loadSeason();
  const cases: Case[] = [];
  for (let gameweek = ANCHOR_THROUGH + 1; gameweek <= 38; gameweek += 1) {
    const strengths = strengthsBefore(season, gameweek);
    const fixtures = new Map((season.fixturesByGameweek.get(gameweek) ?? []).map((fixture) => [fixture.fixtureId, fixture]));
    for (const row of season.rowsByGameweek.get(gameweek) ?? []) {
      const fixture = fixtures.get(row.fixtureId);
      if (!fixture) continue;
      const all = season.rowsByPlayer.get(row.historicalPlayerId) ?? [];
      const anchor = anchorRows(all);
      if (anchor.length < 4) continue;
      const player = playerAt(season, row.historicalPlayerId, gameweek, fixture, row.wasHome, ANCHOR_THROUGH);
      if (!player?.historical?.minutes) continue;
      const current = currentRows(all, gameweek);
      const baseMinutes = baselineMinutes(player, anchor, current);
      const role = rolePrediction(player, anchor, current);
      const form = formBefore(season, row.historicalPlayerId, gameweek)
        .slice(anchor.filter((item) => item.minutes > 0).length);
      const rates = ratesAt(player, form, gameweek);
      const fixtureInput = player.fixtures[0];
      const xp: Record<string, number> = {
        shipped: expectedPoints(player, fixtureInput, baseMinutes, rates.shipped, strengths, BASELINE).total,
        minutesOnly: expectedPoints(player, fixtureInput, role.minutes, rates.shipped, strengths, BASELINE).total,
        equalRatesOnly: expectedPoints(player, fixtureInput, baseMinutes, rates.equal, strengths, BASELINE).total,
        metricRatesOnly: expectedPoints(player, fixtureInput, baseMinutes, rates.metric, strengths, BASELINE).total,
        equalWinsorRatesOnly: expectedPoints(player, fixtureInput, baseMinutes, rates.equalWinsor, strengths, BASELINE).total,
        metricWinsorRatesOnly: expectedPoints(player, fixtureInput, baseMinutes, rates.metricWinsor, strengths, BASELINE).total,
        combinedEqual: expectedPoints(player, fixtureInput, role.minutes, rates.equal, strengths, BASELINE).total,
        combinedMetric: expectedPoints(player, fixtureInput, role.minutes, rates.metric, strengths, BASELINE).total,
        combinedEqualWinsor: expectedPoints(player, fixtureInput, role.minutes, rates.equalWinsor, strengths, BASELINE).total,
        combinedMetricWinsor: expectedPoints(player, fixtureInput, role.minutes, rates.metricWinsor, strengths, BASELINE).total,
      };
      for (const split of RATE_SPLITS) {
        const name = `split:${split.name}`;
        xp[name] = expectedPoints(player, fixtureInput, baseMinutes, rates[name], strengths, BASELINE).total;
      }
      for (const current of CURRENT_CAP_SWEEP) {
        const name = `sweep:${current}`;
        xp[name] = expectedPoints(player, fixtureInput, baseMinutes, rates[name], strengths, BASELINE).total;
      }
      for (const previous of PREVIOUS_WEIGHT_SWEEP) {
        const name = `previous-sweep:${previous}`;
        xp[name] = expectedPoints(player, fixtureInput, baseMinutes, rates[name], strengths, BASELINE).total;
      }
      for (const decay of DECAY_SWEEP) {
        const name = `decay-sweep:${decay}`;
        xp[name] = expectedPoints(player, fixtureInput, baseMinutes, rates[name], strengths, BASELINE).total;
      }
      cases.push({
        gameweek,
        actualMinutes: row.minutes,
        actualStart: row.minutes >= 60 ? 1 : 0,
        actualPoints: row.totalPoints,
        baselineMinutes: baseMinutes,
        proposedMinutes: role.minutes,
        baselineStartProbability: clamp((baseMinutes - 22) / 60, 0, 1),
        proposedStartProbability: role.startProbability,
        xp,
        rate: row.minutes >= 60 ? Object.fromEntries(Object.entries(rates).map(([name, value]) => [name, {
          xg: value.xg - (row.expectedGoals / row.minutes) * 90,
          xa: value.xa - (row.expectedAssists / row.minutes) * 90,
        }])) : undefined,
      });
    }
  }
  return cases;
}

function interval(cases: readonly Case[], metric: (rows: readonly Case[]) => number) {
  const byGameweek = new Map<number, Case[]>();
  for (const row of cases) (byGameweek.get(row.gameweek) ?? byGameweek.set(row.gameweek, []).get(row.gameweek)!).push(row);
  const gameweeks = [...byGameweek.keys()];
  let seed = 20260831;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const values = Array.from({ length: BOOTSTRAPS }, () => metric(
    Array.from({ length: gameweeks.length }, () => byGameweek.get(gameweeks[Math.floor(random() * gameweeks.length)])!).flat(),
  )).sort((a, b) => a - b);
  return [values[Math.floor(values.length * 0.025)], values[Math.floor(values.length * 0.975)]] as const;
}

function main() {
  const cases = collect();
  const minuteDelta = (rows: readonly Case[]) =>
    rmse(rows.map((row) => row.proposedMinutes - row.actualMinutes))
    - rmse(rows.map((row) => row.baselineMinutes - row.actualMinutes));
  const startDelta = (rows: readonly Case[]) =>
    mean(rows.map((row) => (row.proposedStartProbability - row.actualStart) ** 2))
    - mean(rows.map((row) => (row.baselineStartProbability - row.actualStart) ** 2));
  console.log(`2025/26 walk-forward: ${cases.length.toLocaleString()} player-fixtures; gameweeks 1-${ANCHOR_THROUGH} are the anchor\n`);
  console.log("ROLE MODEL (all rows, including zero-minute non-appearances)");
  console.log(`minutes RMSE   shipped ${rmse(cases.map((row) => row.baselineMinutes - row.actualMinutes)).toFixed(3)}   reliability ${rmse(cases.map((row) => row.proposedMinutes - row.actualMinutes)).toFixed(3)}   delta ${minuteDelta(cases).toFixed(3)}   95% CI [${interval(cases, minuteDelta).map((x) => x.toFixed(3)).join(", ")}]`);
  console.log(`start Brier    shipped ${mean(cases.map((row) => (row.baselineStartProbability - row.actualStart) ** 2)).toFixed(4)}   reliability ${mean(cases.map((row) => (row.proposedStartProbability - row.actualStart) ** 2)).toFixed(4)}   delta ${startDelta(cases).toFixed(4)}   95% CI [${interval(cases, startDelta).map((x) => x.toFixed(4)).join(", ")}]`);

  const played = cases.filter((row) => row.rate);
  const rateNames = ["shipped", "equal", "metric", "equalWinsor", "metricWinsor"];
  console.log(`\nRATE MODEL (${played.length.toLocaleString()} starts; next-match per-90 RMSE)`);
  console.log("arm                         xG RMSE   xA RMSE");
  for (const name of rateNames) {
    console.log(`${name.padEnd(27)} ${rmse(played.map((row) => row.rate![name].xg)).toFixed(4)}    ${rmse(played.map((row) => row.rate![name].xa)).toFixed(4)}`);
  }

  const shippedRateXg = rmse(played.map((row) => row.rate!.shipped.xg));
  const shippedRateXa = rmse(played.map((row) => row.rate!.shipped.xa));
  const shippedXp = rmse(cases.map((row) => row.xp.shipped - row.actualPoints));
  const xpDelta = (name: string, rows: readonly Case[]) =>
    rmse(rows.map((row) => row.xp[name] - row.actualPoints))
    - rmse(rows.map((row) => row.xp.shipped - row.actualPoints));
  console.log("\nCURRENT / PREVIOUS RATE SPLITS");
  console.log("The current number is the asymptotic effective-match ceiling; 20/10 is shipped.");
  console.log("split              current share at 38   xG RMSE   xA RMSE   xP RMSE   xP delta [95% CI]");
  const shippedEffective = (1 - 0.95 ** 38) / (1 - 0.95);
  console.log(`${"20 / 10 shipped".padEnd(19)} ${(shippedEffective / (shippedEffective + 10) * 100).toFixed(1).padStart(6)}%              ${shippedRateXg.toFixed(4)}    ${shippedRateXa.toFixed(4)}    ${shippedXp.toFixed(4)}   baseline`);
  for (const split of RATE_SPLITS) {
    const name = `split:${split.name}`;
    const effective = split.current === 0 ? 0 : split.current * (1 - (1 - 1 / split.current) ** 38);
    const share = split.previous === 0 ? 1 : effective / (effective + split.previous);
    const score = rmse(cases.map((row) => row.xp[name] - row.actualPoints));
    const delta = score - shippedXp;
    const ci = interval(cases, (rows) => xpDelta(name, rows));
    console.log(`${split.name.padEnd(19)} ${(share * 100).toFixed(1).padStart(6)}%              ${rmse(played.map((row) => row.rate![name].xg)).toFixed(4)}    ${rmse(played.map((row) => row.rate![name].xa)).toFixed(4)}    ${score.toFixed(4)}   ${delta >= 0 ? "+" : ""}${delta.toFixed(4)} [${ci.map((x) => x.toFixed(4)).join(", ")}]`);
  }

  console.log("\nCURRENT CEILING SWEEP / PREVIOUS 10 (actual-points RMSE)");
  console.log("current   GW38 share   xP RMSE   delta vs shipped");
  const sweep = CURRENT_CAP_SWEEP.map((current) => {
    const name = `sweep:${current}`;
    const effective = current * (1 - (1 - 1 / current) ** 38);
    const score = rmse(cases.map((row) => row.xp[name] - row.actualPoints));
    return { current, name, share: effective / (effective + 10), score };
  });
  const winner = sweep.reduce((best, row) => row.score < best.score ? row : best);
  for (const row of sweep) {
    const delta = row.score - shippedXp;
    console.log(`${String(row.current).padStart(3)}       ${(row.share * 100).toFixed(1).padStart(5)}%      ${row.score.toFixed(5)}   ${delta >= 0 ? "+" : ""}${delta.toFixed(5)}${row === winner ? "   <- best" : ""}`);
  }
  const winnerCi = interval(cases, (rows) => xpDelta(winner.name, rows));
  console.log(`best ${winner.current}/10 delta 95% CI [${winnerCi.map((x) => x.toFixed(5)).join(", ")}]`);

  console.log("\nCURRENT 20 / PREVIOUS WEIGHT SWEEP (actual-points RMSE)");
  console.log("previous   GW38 current share   xP RMSE   delta vs shipped");
  const currentEffective = 20 * (1 - 0.95 ** 38);
  const previousSweep = PREVIOUS_WEIGHT_SWEEP.map((previous) => {
    const name = `previous-sweep:${previous}`;
    const score = rmse(cases.map((row) => row.xp[name] - row.actualPoints));
    return { previous, name, share: currentEffective / (currentEffective + previous), score };
  });
  const previousWinner = previousSweep.reduce((best, row) => row.score < best.score ? row : best);
  for (const row of previousSweep) {
    const delta = row.score - shippedXp;
    console.log(`${String(row.previous).padStart(3)}              ${(row.share * 100).toFixed(1).padStart(5)}%          ${row.score.toFixed(5)}   ${delta >= 0 ? "+" : ""}${delta.toFixed(5)}${row === previousWinner ? "   <- best" : ""}`);
  }
  const previousWinnerCi = interval(cases, (rows) => xpDelta(previousWinner.name, rows));
  console.log(`best 20/${previousWinner.previous} delta 95% CI [${previousWinnerCi.map((x) => x.toFixed(5)).join(", ")}]`);

  console.log("\nDECAY SWEEP / PREVIOUS 10 (actual-points RMSE)");
  console.log("decay   effective current at GW38   current share   xP RMSE   delta vs shipped");
  const decaySweep = DECAY_SWEEP.map((decay) => {
    const name = `decay-sweep:${decay}`;
    const effective = decay === 1 ? 38 : (1 - decay ** 38) / (1 - decay);
    const score = rmse(cases.map((row) => row.xp[name] - row.actualPoints));
    return { decay, name, effective, score };
  });
  const decayWinner = decaySweep.reduce((best, row) => row.score < best.score ? row : best);
  for (const row of decaySweep) {
    const delta = row.score - shippedXp;
    const share = row.effective / (row.effective + 10);
    console.log(`${row.decay.toFixed(2)}            ${row.effective.toFixed(2).padStart(6)}                ${(share * 100).toFixed(1).padStart(5)}%      ${row.score.toFixed(5)}   ${delta >= 0 ? "+" : ""}${delta.toFixed(5)}${row === decayWinner ? "   <- best" : ""}`);
  }
  const decayWinnerCi = interval(cases, (rows) => xpDelta(decayWinner.name, rows));
  console.log(`best decay ${decayWinner.decay.toFixed(2)} delta 95% CI [${decayWinnerCi.map((x) => x.toFixed(5)).join(", ")}]`);

  const xpNames = [
    "shipped", "minutesOnly",
    "equalRatesOnly", "metricRatesOnly", "equalWinsorRatesOnly", "metricWinsorRatesOnly",
    "combinedEqual", "combinedMetric", "combinedEqualWinsor", "combinedMetricWinsor",
  ];
  console.log("\nFULL xP MODEL (all rows; lower RMSE is better)");
  console.log("arm                         RMSE      delta vs shipped   95% CI");
  for (const name of xpNames) {
    const score = rmse(cases.map((row) => row.xp[name] - row.actualPoints));
    const delta = score - shippedXp;
    const ci = name === "shipped" ? undefined : interval(cases, (rows) => xpDelta(name, rows));
    console.log(`${name.padEnd(27)} ${score.toFixed(4)}   ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`
      + (ci ? `             [${ci.map((x) => x.toFixed(4)).join(", ")}]` : ""));
  }
}

main();
