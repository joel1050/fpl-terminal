import { describe, expect, it } from "vitest";
import { squadAlerts } from "@/lib/analysis/squadAlerts";
import type { Player } from "@/types";

type Row = { gameweek: number; difficulty?: number; opponentShortName?: string; isHome?: boolean };
function p(id: number, over: Partial<Player> & { rows?: Row[] } = {}): Player {
  const rows = over.rows ?? [1, 2, 3, 4, 5].map((gameweek) => ({ gameweek, difficulty: 2 }));
  return {
    id, displayName: `P${id}`, status: "a", position: "MID", priceTenths: 50, teamShortName: "ABC",
    fixtures: rows.map((r) => ({ opponentTeamId: 9, opponentShortName: "XYZ", isHome: true, ...r })),
    projection: { fixtures: [], nextGW: 3, next3: 9, next5: 15, next10: 30, expectedMinutes: 80 },
    current: { minutes: 900 },
    ...over,
  } as unknown as Player;
}
const base = (squad: Player[]) => ({ squad, starterIds: squad.slice(0, 11).map((x) => x.id), benchOrder: squad.slice(12).map((x) => x.id), benchGoalkeeperId: squad[11]?.id ?? 0, gameweek: 1 });

describe("squadAlerts", () => {
  const squad = Array.from({ length: 15 }, (_, i) => p(i + 1));

  it("returns nothing for a healthy squad", () => {
    expect(squadAlerts(base(squad))).toEqual([]);
  });

  it("flags a doubtful starter with status and chance", () => {
    const s = squad.map((x) => (x.id === 3 ? p(3, { status: "d", chanceOfPlaying: 50 }) : x));
    const out = squadAlerts(base(s));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "AVAILABILITY", playerId: 3 });
    expect(out[0].title).toContain("doubtful, 50%");
  });

  it("keeps the player name apart from the message, and the title joins them", () => {
    const s = squad.map((x) => (x.id === 3 ? p(3, { status: "d", chanceOfPlaying: 50 }) : x));
    const [alert] = squadAlerts(base(s));
    expect(alert).toMatchObject({ name: "P3", message: "doubtful, 50%", title: "P3 doubtful, 50%" });
  });

  it("flags a starter with a 0% chance as unavailable", () => {
    const s = squad.map((x) => (x.id === 3 ? p(3, { status: "a", chanceOfPlaying: 0 }) : x));
    const out = squadAlerts(base(s));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "AVAILABILITY", playerId: 3 });
    expect(out[0].title).toContain("unavailable, 0%");
  });

  it.each([["i", "unavailable"], ["d", "doubtful"]])("omits the chance when status %s has a null chance", (status, word) => {
    const s = squad.map((x) => (x.id === 5 ? p(5, { status, chanceOfPlaying: null }) : x));
    const out = squadAlerts(base(s));
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe(`P5 ${word}`);
    expect(out[0].title).not.toContain("null");
    expect(out[0].title).not.toContain("%");
  });

  it("says where a doubtful bench player sits", () => {
    const s = squad.map((x) => (x.id === 13 ? p(13, { status: "d", chanceOfPlaying: 75 }) : x));
    expect(squadAlerts(base(s))[0].detail).toContain("1st on bench");
  });

  it("puts unavailable before doubtful", () => {
    const s = squad.map((x) => (x.id === 2 ? p(2, { status: "d", chanceOfPlaying: 50 }) : x.id === 5 ? p(5, { status: "i" }) : x));
    expect(squadAlerts(base(s)).map((a) => a.playerId)).toEqual([5, 2]);
  });

  it("flags a starter whose next five average difficulty is 3.6 or worse", () => {
    const hard = (d: number[]) => d.map((difficulty, i) => ({ gameweek: i + 1, difficulty }));
    const at36 = squad.map((x) => (x.id === 4 ? p(4, { rows: hard([4, 4, 4, 3, 3]) }) : x)); // 3.6
    const at35 = squad.map((x) => (x.id === 4 ? p(4, { rows: hard([4, 4, 3, 3, 3]) }) : x)); // 3.4
    expect(squadAlerts(base(at36)).map((a) => a.kind)).toEqual(["HARD_RUN"]);
    expect(squadAlerts(base(at35))).toEqual([]);
  });

  it("measures the run over five Gameweeks, not five fixture rows", () => {
    // Old rule took rows 1, 2, 2, 3, 4 (average 3.8). Over Gameweeks 1-5 the six games average 3.5.
    const withDouble = [5, 5, 5, 2, 2, 2].map((difficulty, i) => ({ gameweek: [1, 2, 2, 3, 4, 5][i], difficulty }));
    const s = squad.map((x) => (x.id === 4 ? p(4, { rows: withDouble }) : x));
    expect(squadAlerts(base(s)).filter((a) => a.kind === "HARD_RUN")).toEqual([]);
  });

  it("does not judge a run whose fixtures stop before the fifth Gameweek", () => {
    const short = [1, 1, 2, 2, 3].map((gameweek) => ({ gameweek, difficulty: 5 }));
    const s = squad.map((x) => (x.id === 4 ? p(4, { rows: short }) : x));
    expect(squadAlerts(base(s)).filter((a) => a.kind === "HARD_RUN")).toEqual([]);
  });

  it("names a squad player outside the lineup as in squad", () => {
    const s = squad.map((x) => (x.id === 3 ? p(3, { status: "d", chanceOfPlaying: 50 }) : x));
    const out = squadAlerts({ squad: s, starterIds: [], benchOrder: [], benchGoalkeeperId: 0, gameweek: 1 });
    expect(out[0].detail.startsWith("in squad ·")).toBe(true);
  });

  it("flags a blank and a double gameweek", () => {
    const s = squad.map((x) =>
      x.id === 6 ? p(6, { rows: [{ gameweek: 2 }] }) :
      x.id === 7 ? p(7, { rows: [{ gameweek: 1 }, { gameweek: 1 }] }) : x);
    const kinds = squadAlerts(base(s)).map((a) => a.kind).sort();
    expect(kinds).toEqual(["BLANK", "DOUBLE"]);
  });

  it("grades each alert: unavailable BAD, doubtful WARN, schedule and form INFO", () => {
    const s = squad.map((x) =>
      x.id === 2 ? p(2, { status: "d", chanceOfPlaying: 50 }) :
      x.id === 5 ? p(5, { status: "i" }) :
      x.id === 6 ? p(6, { rows: [{ gameweek: 2 }] }) : x);
    const severity = Object.fromEntries(squadAlerts(base(s)).map((a) => [a.playerId, a.severity]));
    expect(severity).toEqual({ 5: "BAD", 2: "WARN", 6: "INFO" });
  });

  it("caps the list at five", () => {
    const s = squad.map((x) => p(x.id, { status: "i" }));
    expect(squadAlerts(base(s))).toHaveLength(5);
  });

  it("copes with a draft squad of fewer than 15", () => {
    const draft = squad.slice(0, 6);
    expect(() => squadAlerts({ squad: draft, starterIds: [], benchOrder: [], benchGoalkeeperId: 0, gameweek: 1 })).not.toThrow();
  });
});
