import { expect, test } from "@playwright/test";
import { bootstrapStaticFixture } from "../fixtures/fpl";
import { interceptFplData } from "../fixtures/network";

/**
 * The import mode card, matched by its index rather than its wording. The
 * wording has changed once already ("ANALYZE A TEAM" -> "IMPORT A TEAM"), and
 * which mode a test picks is not what the test is about.
 */
const IMPORT_MODE = /mode b/i;

const chipSuggestions = {
  gameweek: 1,
  horizon: 5,
  suggestions: [
    {
      chip: "bboost",
      gameweek: 1,
      baselineXp: 60,
      chipPlanXp: 63.5,
      incrementalXp: 3.5,
      lineup: { starterIds: [4, 7, 9, 10, 21, 22, 11, 12, 13, 1, 14], benchGoalkeeperId: 16, benchOrder: [17, 18, 15], captainId: 1, viceCaptainId: 14, projectedTotal: 63.5 },
      financialConfidence: "ESTIMATED",
      reasons: ["Bench Boost scores all 15 (+3.5 xP vs the saved XI)."],
    },
    {
      chip: "3xc",
      gameweek: 1,
      baselineXp: 60,
      chipPlanXp: 59,
      incrementalXp: -1,
      lineup: { starterIds: [4, 7, 9, 10, 21, 22, 11, 12, 13, 1, 14], benchGoalkeeperId: 16, benchOrder: [17, 18, 15], captainId: 1, viceCaptainId: 14, projectedTotal: 59 },
      financialConfidence: "ESTIMATED",
      reasons: ["Triple Captain doubles the armband (-1.0 xP vs the saved XI)."],
    },
  ],
};

test.describe("chip planning", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("chips-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("chips-test", "ready");
      }
    });
    await interceptFplData(page);
    await page.route("**/api/fpl/bootstrap*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bootstrapStaticFixture) });
    });
    await page.route("**/api/chip-suggestions", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(chipSuggestions) });
    });
    await page.goto("/");
    await page.getByRole("button", { name: IMPORT_MODE }).click();
    await page.getByLabel(/enter fpl id/i).fill("4827193");
    await page.getByRole("button", { name: /import team/i }).click();
    await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
  });

  test("plans chips to the end of the current chip window", async ({ page }) => {
    let requestBody: { gameweek?: number; horizon?: number } | null = null;
    await page.route("**/api/chip-suggestions", async (route) => {
      requestBody = route.request().postDataJSON() as { gameweek?: number; horizon?: number };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(chipSuggestions) });
    });
    const region = page.getByRole("region", { name: /squad builder and analysis/i });
    await expect(region.getByText("GW1–19", { exact: false }).first()).toBeVisible();
    await region.getByRole("button", { name: /analyze chips/i }).click();
    await expect(region.getByText("BB · GW1")).toBeVisible();
    // First-window chips expire at GW19, so GW1 plans a 19-gameweek horizon.
    await expect.poll(() => requestBody).toMatchObject({ gameweek: 1, horizon: 19 });
  });

  test("selects each chip beside the gameweek switcher", async ({ page }) => {
    const region = page.getByRole("region", { name: /squad builder and analysis/i });
    const chips = region.getByRole("group", { name: /select chip/i });
    await expect(chips.getByRole("button", { name: "NONE" })).toHaveAttribute("aria-pressed", "true");

    await chips.getByRole("button", { name: "WC" }).click();
    await expect(chips.getByRole("button", { name: "WC" })).toHaveAttribute("aria-pressed", "true");

    await chips.getByRole("button", { name: "FH" }).click();
    await expect(chips.getByRole("button", { name: "FH" })).toHaveAttribute("aria-pressed", "true");

    await chips.getByRole("button", { name: "BB" }).click();
    const benchTags = await region.evaluate(() =>
      Array.from(document.querySelectorAll(".slot-bench-tag")).map((el) => el.textContent?.trim()),
    );
    expect(benchTags.filter((tag) => tag?.includes("COUNTS"))).toHaveLength(4);

    await chips.getByRole("button", { name: "TC" }).click();
    const captainMarker = await region.evaluate(() =>
      Array.from(document.querySelectorAll(".slot-role")).map((el) => el.textContent?.trim()),
    );
    expect(captainMarker).toContain("3×");

    await chips.getByRole("button", { name: "NONE" }).click();
    await expect(chips.getByRole("button", { name: "NONE" })).toHaveAttribute("aria-pressed", "true");
  });

  test("applies chip advice and undoes it in one click", async ({ page }) => {
    const region = page.getByRole("region", { name: /squad builder and analysis/i });
    await region.getByRole("button", { name: /analyze chips/i }).click();
    const panel = region.getByRole("region", { name: /chip strategy/i }).or(region.locator(".chip-strategy"));
    await expect(panel.getByText("BB · GW1")).toBeVisible();
    await expect(panel.getByText("no projected edge")).toBeVisible();

    await panel.getByRole("button", { name: "APPLY" }).first().click();
    const chips = region.getByRole("group", { name: /select chip/i });
    await expect(chips.getByRole("button", { name: "BB" })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByRole("button", { name: "UNDO" })).toBeVisible();

    await panel.getByRole("button", { name: "UNDO" }).click();
    await expect(chips.getByRole("button", { name: "NONE" })).toHaveAttribute("aria-pressed", "true");
  });

  test("restores the permanent squad beyond a free hit and reloads persisted plans", async ({ page }) => {
    const region = page.getByRole("region", { name: /squad builder and analysis/i });
    await region.getByRole("group", { name: /select chip/i }).getByRole("button", { name: "FH" }).click();
    await expect(region.getByRole("group", { name: /select chip/i }).getByRole("button", { name: "FH" })).toHaveAttribute("aria-pressed", "true");
    // Wait for the chip choice to reach persisted storage before seeding.
    await expect.poll(() => page.evaluate(() => {
      const state = JSON.parse(window.localStorage.getItem("fpl-terminal-state") ?? "null");
      return state?.gameweekPlans?.["1"]?.chip;
    })).toBe("freehit");

    // Seed a temporary Free Hit squad for GW1, then switch beyond it.
    await page.evaluate(() => {
      const raw = window.localStorage.getItem("fpl-terminal-state");
      if (!raw) throw new Error("missing persisted state");
      const state = JSON.parse(raw);
      const plan = state.gameweekPlans["1"];
      const remap = (id: number) => (id === 21 ? 2 : id);
      plan.chip = "freehit";
      plan.permanentSquad = { playerIds: [...plan.playerIds], byPosition: JSON.parse(JSON.stringify(plan.byPosition)) };
      plan.playerIds = plan.playerIds.map(remap);
      plan.byPosition.MID = plan.byPosition.MID.map(remap);
      plan.lockedPlayerIds = (plan.lockedPlayerIds ?? []).map(remap);
      plan.benchOrder = (plan.benchOrder ?? []).map(remap);
      if (plan.benchGoalkeeperId !== undefined) plan.benchGoalkeeperId = remap(plan.benchGoalkeeperId);
      if (plan.captainId !== undefined) plan.captainId = remap(plan.captainId);
      if (plan.viceCaptainId !== undefined) plan.viceCaptainId = remap(plan.viceCaptainId);
      window.localStorage.setItem("fpl-terminal-state", JSON.stringify(state));
    });
    await page.reload();
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    const reloaded = page.getByRole("region", { name: /squad builder and analysis/i });
    await expect(reloaded.getByRole("group", { name: /select chip/i }).getByRole("button", { name: "FH" })).toHaveAttribute("aria-pressed", "true");

    await reloaded.getByRole("group", { name: /select planning gameweek/i }).getByRole("button", { name: /next planning gameweek/i }).click();
    await expect(reloaded.getByRole("group", { name: /select planning gameweek/i })).toContainText("GW 2");
    await expect(reloaded.getByRole("group", { name: /select chip/i }).getByRole("button", { name: "NONE" })).toHaveAttribute("aria-pressed", "true");
    // GW2 holds the permanent squad: player 21 is back, temp pick 2 is gone.
    await expect.poll(() => page.evaluate(() => {
      const state = JSON.parse(window.localStorage.getItem("fpl-terminal-state") ?? "null");
      const gw2 = state?.gameweekPlans?.["2"];
      return gw2 && gw2.playerIds.includes(21) && !gw2.playerIds.includes(2) ? "ok" : null;
    })).toBe("ok");
    // The GW1 chip choice survives the reload.
    await expect.poll(() => page.evaluate(() => {
      const state = JSON.parse(window.localStorage.getItem("fpl-terminal-state") ?? "null");
      return state?.gameweekPlans?.["1"]?.chip;
    })).toBe("freehit");
  });

  test("lets imported squads replace players freely with the remove button", async ({ page }) => {
    // Give the imported team a financial baseline; standalone edits still
    // work because the timeline derives transfers from the squad diffs.
    await page.evaluate(() => {
      const raw = window.localStorage.getItem("fpl-terminal-state");
      if (!raw) throw new Error("missing persisted state");
      const state = JSON.parse(raw);
      const plan = state.gameweekPlans["1"];
      state.transferBaseline = {
        squadPlayerIds: [...plan.playerIds],
        byPosition: JSON.parse(JSON.stringify(plan.byPosition)),
        bankTenths: 10,
        freeTransfers: 1,
        purchasePricesTenths: {},
        financialConfidence: "ESTIMATED",
        startGameweek: 1,
        warnings: [],
      };
      window.localStorage.setItem("fpl-terminal-state", JSON.stringify(state));
    });
    await page.reload();
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    const reloaded = page.getByRole("region", { name: /squad builder and analysis/i });
    const slot = reloaded.locator("article.squad-slot", { hasText: "Rogers" }).first();
    await slot.hover();
    await slot.getByRole("button", { name: /unlock rogers/i }).click();
    await slot.hover();
    await slot.getByRole("button", { name: /remove rogers/i }).click();
    await expect(reloaded.getByText(/14\s*\/\s*15 selected/i).first()).toBeVisible();
  });

  test("renders chip controls on desktop and mobile viewports", async ({ page }) => {
    const region = page.getByRole("region", { name: /squad builder and analysis/i });
    for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      if (size.width < 901) await page.getByRole("button", { name: "SQUAD", exact: true }).click().catch(() => {});
      await expect(region.getByRole("group", { name: /select chip/i })).toBeVisible();
      await expect(region.locator(".chip-strategy")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });
});
