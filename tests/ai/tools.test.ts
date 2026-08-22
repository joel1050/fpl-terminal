import { describe, expect, it } from "vitest";

import { createToolRegistry, executeTool } from "@/lib/ai/tools";
import { AnalystActionSchema } from "@/lib/ai/schemas";

const context = {
  gameweek: 1,
  squad: { playerIds: [1], lockedPlayerIds: [1] },
  finances: { costTenths: 100, bankTenths: 900 },
  strategy: { horizon: 5 as const, risk: "BALANCED" as const, bench: "BALANCED" as const },
  players: [
    {
      id: 1,
      displayName: "Test Player",
      position: "MID" as const,
      priceTenths: 100,
      teamId: 1,
      teamShortName: "TST",
    },
  ],
};

describe("AI tools", () => {
  it("rejects unknown and malformed tool arguments before execution", async () => {
    const registry = createToolRegistry();

    await expect(executeTool(registry, "does_not_exist", "{}", context)).resolves.toMatchObject({ ok: false });
    await expect(executeTool(registry, "get_player", JSON.stringify({ playerId: "1" }), context)).resolves.toMatchObject({ ok: false });
    await expect(executeTool(registry, "search_players", JSON.stringify({ query: "test", extra: true }), context)).resolves.toMatchObject({ ok: false });
  });

  it("returns compact deterministic data for valid calls", async () => {
    const result = await executeTool(createToolRegistry(), "get_player", JSON.stringify({ playerId: 1 }), context);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ player: { id: 1, displayName: "Test Player" } });
  });

  it("validates a weekly lineup proposal without applying it", async () => {
    const plan = {
      gameweek: 1,
      starterIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      benchGoalkeeperId: 12,
      benchOrder: [13, 14, 15] as [number, number, number],
      captainId: 1,
      viceCaptainId: 2,
      projectionFingerprint: "gw1-test",
    };
    const tool = await executeTool(
      createToolRegistry({ pickWeeklyTeam: () => plan }),
      "pick_weekly_team",
      "{}",
      context,
    );
    const action = AnalystActionSchema.safeParse({ type: "APPLY_WEEKLY_LINEUP", ...plan });

    expect(tool).toMatchObject({ ok: true, data: plan });
    expect(action.success).toBe(true);

    const captain = await executeTool(
      createToolRegistry({ pickWeeklyTeam: () => plan }),
      "choose_captain",
      "{}",
      context,
    );
    expect(captain).toMatchObject({ ok: true, data: { captainId: 1, viceCaptainId: 2 } });
  });
});
