import { describe, expect, it } from "vitest";
import type { Player, Position } from "@/types/player";
import { replayTimeline } from "@/lib/chips/timeline";
import { projectTimeline, sumTimelineNet } from "@/lib/chips/timelineProjections";

function player(id: number, position: Position, points: number): Player {
  return {
    id,
    firstName: "P",
    lastName: String(id),
    displayName: `P${id}`,
    teamId: id,
    teamName: `T${id}`,
    teamShortName: `T${id}`,
    position,
    priceTenths: 50,
    ownership: 0,
    status: "a",
    current: { totalPoints: points, pointsPer90: points, goals: 0, assists: 0, cleanSheets: 0, bonus: 0, minutes: 90 },
    fixtures: [],
    projection: {
      playerId: id,
      fixtures: [{ gameweek: 1, expectedPoints: points, expectedMinutes: 90, fixture: { gameweek: 1, opponentTeamId: 99, opponentShortName: "T", isHome: true } }],
      nextGW: points,
      next3: points * 3,
      next5: points * 5,
      next10: points * 10,
      expectedMinutes: 90,
      valueNext5: points,
      riskScore: 5,
      confidence: "HIGH",
      factors: [],
    },
  };
}

const SQUAD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];
const IDS_BY_POSITION: Record<Position, number[]> = { GK: [1, 2], DEF: [3, 4, 5, 6, 7], MID: [8, 9, 10, 11, 12], FWD: [13, 14, 15] };

function players(): Map<number, Player> {
  const ids = [...SQUAD];
  const positions: Position[] = ["GK", "GK", "DEF", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "MID", "FWD", "FWD", "FWD"];
  return new Map(ids.map((id, index) => [id, player(id, positions[index], id === 1 ? 4 : 5)]));
}

const baseline = {
  squadPlayerIds: [...SQUAD],
  byPosition: { GK: [1, 2], DEF: [3, 4, 5, 6, 7], MID: [8, 9, 10, 11, 12], FWD: [13, 14, 15] },
  bankTenths: 0,
  freeTransfers: 1,
  purchasePricesTenths: Object.fromEntries(SQUAD.map((id) => [id, 50])),
  financialConfidence: "EXACT" as const,
  startGameweek: 1,
  warnings: [] as string[],
};

void POSITIONS;
void IDS_BY_POSITION;

describe("timeline projections", () => {
  it("totals lineup, chip effect, and hits per saved gameweek", () => {
    const priceById = new Map(SQUAD.map((id) => [id, 50]));
    const timeline = replayTimeline({
      baseline,
      plans: { 1: { playerIds: [...SQUAD], chip: "bboost" } },
      priceById,
      fromGameweek: 1,
      toGameweek: 1,
    });
    const projections = projectTimeline({ timeline, playersById: players(), riskMode: "BALANCED" });
    // XI 54 (GK 4 + 13 outfield x 5 minus benched... ) plus captain 5 plus bench 19.
    expect(projections[1].chipEffect).toBeGreaterThan(0);
    expect(projections[1].lineupTotal).toBe(projections[1].projectedXI + projections[1].captainBonus + projections[1].autosubValue);
    expect(projections[1].netTotal).toBe(projections[1].lineupTotal - projections[1].hitCost);
  });

  it("ranks triple captain above bench boost when the armband dominates", () => {
    const priceById = new Map(SQUAD.map((id) => [id, 50]));
    const forChip = (chip: "bboost" | "3xc") => {
      const timeline = replayTimeline({ baseline, plans: { 1: { playerIds: [...SQUAD], chip } }, priceById, fromGameweek: 1, toGameweek: 1 });
      return projectTimeline({ timeline, playersById: players(), riskMode: "BALANCED" })[1];
    };
    // Captain 5 xP: TC adds +5 over the normal bonus while BB adds the bench.
    const tc = forChip("3xc");
    const bb = forChip("bboost");
    expect(tc.chipEffect).toBeGreaterThan(0);
    expect(bb.chipEffect).toBeGreaterThan(0);
    expect(sumTimelineNet({ 1: tc }, 1, 1)).toBe(tc.netTotal);
  });

  it("deducts transfer hits from the net total", () => {
    const priceById = new Map([...SQUAD.map((id) => [id, 50] as [number, number]), [16, 50]]);
    const withTransfer = [...SQUAD.slice(0, 14), 16];
    const timeline = replayTimeline({
      baseline: { ...baseline, freeTransfers: 0 },
      plans: { 1: { playerIds: withTransfer, chip: null } },
      priceById,
      fromGameweek: 1,
      toGameweek: 1,
    });
    expect(timeline[1].hitCost).toBe(4);
    const playersById = players();
    playersById.set(16, player(16, "MID", 5));
    const projections = projectTimeline({ timeline, playersById, riskMode: "BALANCED" });
    expect(projections[1].netTotal).toBe(projections[1].lineupTotal - 4);
  });
});
