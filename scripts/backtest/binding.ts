/** How often each clamp actually bites, per arm, on real walk-forward strengths. */
import { loadSeason, strengthsBefore } from "./season";
import { BASELINE, MEASURED_VENUE, type Variant } from "./variants";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const v = (o: Partial<Variant>): Variant => ({ ...BASELINE, ...o });

const ARMS: { name: string; variant: Variant; base: number }[] = [];
for (const [label, base] of [["FDR neutral (backtest)", 1.0], ["FDR 1.07 (best real)", 1.07]] as const) {
  ARMS.push(
    { name: `baseline               [${label}]`, variant: BASELINE, base },
    { name: `R2 venue               [${label}]`, variant: v({ venue: MEASURED_VENUE }), base },
    { name: `R1 unclamped ratio     [${label}]`, variant: v({ attackRatioClamp: [0.01, 100] }), base },
    { name: `R1+R2 unclamped+venue  [${label}]`, variant: v({ attackRatioClamp: [0.01, 100], venue: MEASURED_VENUE }), base },
    { name: `ratio[0.70,1.35]+venue [${label}]`, variant: v({ attackRatioClamp: [0.70, 1.35], venue: MEASURED_VENUE }), base },
  );
}

function main(): void {
  const season = loadSeason();
  const rows: { isHome: boolean; ownAttack: number; oppDefence: number }[] = [];
  for (let gw = 6; gw <= 38; gw += 1) {
    const s = strengthsBefore(season, gw);
    for (const fx of season.fixturesByGameweek.get(gw) ?? []) {
      const h = s[fx.homeTeamId], a = s[fx.awayTeamId];
      if (!h || !a) continue;
      rows.push({ isHome: true, ownAttack: h.attackHome, oppDefence: a.defenceAway });
      rows.push({ isHome: false, ownAttack: a.attackAway, oppDefence: h.defenceHome });
    }
  }
  const raw = rows.map((r) => r.ownAttack / r.oppDefence).sort((x, y) => x - y);
  console.log(`team-fixtures ${rows.length}   raw attack ratio ${raw[0].toFixed(2)} - ${raw[raw.length - 1].toFixed(2)}\n`);
  console.log("arm                                       inner clamp bites   outer [0.7,1.3] bites   max multiplier");
  console.log("-".repeat(104));
  for (const arm of ARMS) {
    let inner = 0, outer = 0, max = 0;
    for (const r of rows) {
      const ratio = r.ownAttack / r.oppDefence;
      const [lo, hi] = arm.variant.attackRatioClamp;
      if (ratio < lo || ratio > hi) inner += 1;
      const venue = r.isHome ? arm.variant.venue[0] : arm.variant.venue[1];
      const pre = arm.base * venue * clamp(ratio, lo, hi);
      if (pre < arm.variant.multiplierClamp[0] || pre > arm.variant.multiplierClamp[1]) outer += 1;
      max = Math.max(max, pre);
    }
    const pct = (n: number) => `${((100 * n) / rows.length).toFixed(1).padStart(5)}%`;
    console.log(`${arm.name.padEnd(41)} ${pct(inner)}              ${pct(outer)}                 ${max.toFixed(3)}`);
  }
}
main();
