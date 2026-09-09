import type { TeamStrength } from "@/types/projection";
import { clubEloForFplShortName, type ClubEloSnapshot, CLUB_ELO_SNAPSHOT } from "@/lib/clubElo";

/**
 * A team's attacking and defensive rates as the clean-sheet model reads them.
 *
 * Deliberately not a `TeamStrength`: these are re-levelled against Elo and are
 * only ever correct for goals conceded. The attack multiplier still reads the
 * unmodified `TeamStrength`, because the ClubElo work in the backtest README
 * found FPL's own rating better than Elo for team xG.
 */
export interface CleanSheetStrength {
  attack: number;
  defence: number;
}

/**
 * Share of a team's attack-minus-defence lean that is kept.
 *
 * The lean is measured from a season and a bit of xG, so it carries real noise;
 * regressing it toward neutral costs little when it is right and saves a lot
 * when it is not. Against the gameweek-4 market the fit is flat from 0.3 to
 * 0.85 (MAE 2.76 to 2.85, best 2.54 at 0.5) and clearly worse at both ends
 * (3.13 at 0, 3.16 at 1). 0.6 is the middle of the flat range.
 */
export const CLEAN_SHEET_SKEW_WEIGHT = 0.6;

/**
 * How much of a team's goal-scale level one Elo point buys, in log units.
 *
 * Measured, not assumed: an independent Poisson fitted to all 380 fixtures of
 * 2025/26 xG gives each team a level of `log(attack) + log(defence)`, and
 * regressing that on ClubElo returns 0.00340 per point with r = 0.949. So a
 * 200-point Elo gap is a factor of exp(0.68) in a fixture's goal expectation.
 *
 * It has to be a measured constant rather than a line refitted per call. The
 * strengths this module reads are normalized ratios whose level spread is 1.69x
 * narrower than a direct Poisson fit on the same season's xG (sd 0.189 against
 * 0.319). Refitting against them reproduces that narrowness and leaves Elo doing
 * nothing but re-ordering teams it should also be spreading apart - the first
 * cut of this module did exactly that and gave back most of the gain.
 */
export const ELO_LEVEL_SLOPE = 0.0034;

const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** Venue-agnostic, matching `applyInSeasonForm`, which fits one rate per team. */
const attackOf = (strength: TeamStrength) => (strength.attackHome + strength.attackAway) / 2;
const defenceOf = (strength: TeamStrength) => (strength.defenceHome + strength.defenceAway) / 2;

/**
 * Re-levels every team's attack and defence against its ClubElo rating.
 *
 * A team's strengths carry two separable things: a *level*, the product of
 * attack and defence, and a *lean*, their ratio. Elo measures the level with a
 * far longer memory than a few gameweeks of xG, and rates promoted clubs on the
 * same scale as everyone else - Coventry, Hull and Ipswich have no top-flight
 * goal history at all. It cannot see the lean, which is exactly what the xG fit
 * is good at. So the level is taken from Elo and the lean is kept.
 *
 * The level is centred on the rated teams' own mean Elo, so it is a deviation
 * and the returned rates sit around 1. Both inputs describe the past, so nothing
 * here reads a fixture it will later be scored against.
 *
 * Returns an empty record when no team resolves to a rating, and callers then
 * fall back to the 5x5 table.
 */
export function deriveCleanSheetStrengths(
  strengths: Record<number, TeamStrength>,
  shortNameByTeamId: ReadonlyMap<number, string>,
  snapshot: ClubEloSnapshot = CLUB_ELO_SNAPSHOT,
): Record<number, CleanSheetStrength> {
  const rated: { teamId: number; elo: number; skew: number }[] = [];
  for (const [key, strength] of Object.entries(strengths)) {
    const teamId = Number(key);
    const attack = attackOf(strength);
    const defence = defenceOf(strength);
    if (!(attack > 0) || !(defence > 0)) continue;
    const elo = clubEloForFplShortName(shortNameByTeamId.get(teamId), snapshot)?.elo;
    if (elo === undefined) continue;
    rated.push({ teamId, elo, skew: Math.log(attack) - Math.log(defence) });
  }
  if (rated.length === 0) return {};

  const meanElo = mean(rated.map((r) => r.elo));
  const result: Record<number, CleanSheetStrength> = {};
  for (const team of rated) {
    const level = ELO_LEVEL_SLOPE * (team.elo - meanElo);
    const skew = CLEAN_SHEET_SKEW_WEIGHT * team.skew;
    result[team.teamId] = {
      attack: Math.exp((level + skew) / 2),
      defence: Math.exp((level - skew) / 2),
    };
  }
  return result;
}
