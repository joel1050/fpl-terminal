/**
 * How many matches before this season's numbers actually tell you anything?
 *
 * Three quantities per metric, as a function of appearances played:
 *
 *   RELIABILITY  odd-numbered appearances against even-numbered ones inside the
 *                same window, lifted to full-window length by Spearman-Brown.
 *                Randomising the halves holds the player's true level roughly
 *                fixed, so what is left is measurement noise alone. This is the
 *                share of the window's variance that is real.
 *   FORWARD      the first n appearances against every appearance after them -
 *                the quantity a projection actually needs. Both sides are noisy,
 *                so this is not comparable to reliability as it stands: with no
 *                drift at all it would equal sqrt(rel_past * rel_future).
 *   STABILITY    forward divided by that sqrt - the correction for attenuation.
 *                1.0 means players kept their level exactly; below 1.0 is drift.
 *
 * Comparing forward against reliability directly would read the future window's
 * own noise as if it were drift, and at small n the long future window is the
 * cleaner of the two, which inverts the sign.
 *
 * n on the x-axis is appearances played, never gameweeks elapsed - bucketing by
 * window length instead is the bug that invalidated an earlier finding here.
 *
 *   npx tsx scripts/backtest/reliability.ts
 */
import { loadSeason, type MatchRow } from "./season";

const MIN_FUTURE_MATCHES = 6;
const SPLITS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25] as const;
/** Per-90 rates need a minutes floor or a 12-minute cameo becomes a data point. */
const MIN_MINUTES_PER_MATCH = 45;

interface Metric {
  name: string;
  /** Numerator contributed by one appearance. */
  value: (r: MatchRow) => number;
  /** Denominator: 90s played for a per-90 rate, 1 for a per-match average. */
  weight: (r: MatchRow) => number;
  /** Per-90 metrics are only meaningful on real playing time. */
  needsMinutes: boolean;
}

const METRICS: Metric[] = [
  { name: "minutes per gameweek", value: (r) => r.minutes, weight: () => 1, needsMinutes: false },
  { name: "start rate (>=60 min)", value: (r) => (r.minutes >= 60 ? 1 : 0), weight: () => 1, needsMinutes: false },
  { name: "xGI per 90", value: (r) => (r.expectedGoals ?? 0) + (r.expectedAssists ?? 0), weight: (r) => r.minutes / 90, needsMinutes: true },
  { name: "xG per 90", value: (r) => r.expectedGoals ?? 0, weight: (r) => r.minutes / 90, needsMinutes: true },
  { name: "xA per 90", value: (r) => r.expectedAssists ?? 0, weight: (r) => r.minutes / 90, needsMinutes: true },
  { name: "goals+assists per 90", value: (r) => (r.goals ?? 0) + (r.assists ?? 0), weight: (r) => r.minutes / 90, needsMinutes: true },
  { name: "FPL points per 90", value: (r) => r.totalPoints, weight: (r) => r.minutes / 90, needsMinutes: true },
  { name: "FPL points per match", value: (r) => r.totalPoints, weight: () => 1, needsMinutes: false },
];

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

function pearson(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length < 3) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? NaN : num / Math.sqrt(dx * dy);
}

/** Fisher z 95% interval, so the thin high-n points cannot be over-read. */
function ci(r: number, n: number): [number, number] {
  if (!Number.isFinite(r) || n < 5) return [NaN, NaN];
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1.96 / Math.sqrt(n - 3);
  const lo = Math.tanh(z - se);
  const hi = Math.tanh(z + se);
  return [lo, hi];
}

const rate = (rows: readonly MatchRow[], m: Metric): number => {
  const w = rows.reduce((s, r) => s + m.weight(r), 0);
  return w <= 0 ? NaN : rows.reduce((s, r) => s + m.value(r), 0) / w;
};

/** Spearman-Brown: lifts a half-length correlation to the full window's. */
const spearmanBrown = (r: number) => (2 * r) / (1 + r);

/** r = n / (n + k)  =>  k = n(1-r)/r. The matches of noise in one observation. */
const kFrom = (r: number, n: number) => (r > 0 ? (n * (1 - r)) / r : NaN);

const fmt = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "  -  ");

function main() {
  const season = loadSeason();

  // One appearance list per player, in gameweek order, filtered per metric later.
  const careers: MatchRow[][] = [];
  for (const rows of season.rowsByPlayer.values()) {
    const played = rows.filter((r) => r.minutes > 0).sort((a, b) => a.gameweek - b.gameweek);
    if (played.length >= 2) careers.push(played);
  }
  console.log(`2025/26: ${careers.length} players with at least two appearances\n`);

  for (const metric of METRICS) {
    const pool = careers
      .map((c) => (metric.needsMinutes ? c.filter((r) => r.minutes >= MIN_MINUTES_PER_MATCH) : c))
      .filter((c) => c.length >= 4);

    console.log(`=== ${metric.name} ===`);
    console.log("   n   players   reliab   95% CI         k   relFut   forward   95% CI       stability");
    for (const n of SPLITS) {
      // The same player set feeds all three numbers, so nothing is a sample shift.
      const eligible = pool.filter((c) => c.length >= n + MIN_FUTURE_MATCHES);

      // FORWARD: first n appearances against everything after them.
      const fx: number[] = [];
      const fy: number[] = [];
      // Split-half of each window, so both sides can be disattenuated.
      const px: number[] = [];
      const py: number[] = [];
      const qx: number[] = [];
      const qy: number[] = [];
      for (const c of eligible) {
        const past = c.slice(0, n);
        const future = c.slice(n);
        const a = rate(past, metric);
        const b = rate(future, metric);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        fx.push(a); fy.push(b);
        px.push(rate(past.filter((_, i) => i % 2 === 0), metric));
        py.push(rate(past.filter((_, i) => i % 2 === 1), metric));
        qx.push(rate(future.filter((_, i) => i % 2 === 0), metric));
        qy.push(rate(future.filter((_, i) => i % 2 === 1), metric));
      }
      if (fx.length < 20) continue;

      const rf = pearson(fx, fy);
      const [flo, fhi] = ci(rf, fx.length);
      const rhPast = pearson(px, py);
      const relPast = spearmanBrown(rhPast);
      const relFuture = spearmanBrown(pearson(qx, qy));
      const [hlo, hhi] = ci(rhPast, px.length);
      const ceiling = Math.sqrt(Math.max(relPast, 0) * Math.max(relFuture, 0));
      const stability = ceiling > 0 ? rf / ceiling : NaN;

      console.log(
        `  ${String(n).padStart(2)}   ${String(fx.length).padStart(4)}    ` +
        `${fmt(relPast)}  [${fmt(spearmanBrown(hlo), 2)},${fmt(spearmanBrown(hhi), 2)}] ${fmt(kFrom(relPast, n), 1).padStart(5)}   ` +
        `${fmt(relFuture, 2)}     ${fmt(rf)}   [${fmt(flo, 2)},${fmt(fhi, 2)}]   ${fmt(stability)}`,
      );
    }
    console.log("");
  }
}

main();
