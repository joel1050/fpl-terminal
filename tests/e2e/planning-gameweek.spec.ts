import { expect, test } from "@playwright/test";
import { bootstrapStaticFixture } from "../fixtures/fpl";
import { interceptFplData } from "../fixtures/network";

const planningBootstrap = {
  ...bootstrapStaticFixture,
  players: bootstrapStaticFixture.players.map((player) => ({
    ...player,
    projection: {
      ...player.projection,
      fixtures: [
        { gameweek: 1, expectedPoints: player.projection.nextGW, expectedMinutes: 80, fixture: { gameweek: 1, opponentTeamId: 2, opponentShortName: "EASY", isHome: true, difficulty: 2 } },
        ...(player.id === 13 ? [] : [{ gameweek: 2, expectedPoints: player.projection.nextGW + 1, expectedMinutes: 80, fixture: { gameweek: 2, opponentTeamId: 3, opponentShortName: "HARD", isHome: false, difficulty: 5 } }]),
      ],
    },
  })),
};

test.describe("persisted planning gameweeks", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("planning-gameweek-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("planning-gameweek-test", "ready");
      }
    });
    await interceptFplData(page);
    await page.route("**/api/fpl/bootstrap*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(planningBootstrap) });
    });
    await page.goto("/");
    await page.getByRole("button", { name: /analyze (?:a )?team/i }).click();
    await page.getByLabel(/enter fpl id/i).fill("4827193");
    await page.getByRole("button", { name: /import team/i }).click();
    await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
  });

  test("switches card projections and badges, then reloads the selected plan without entry fetch", async ({ page }) => {
    const region = page.getByRole("region", { name: /squad builder and analysis/i });
    const selector = region.getByRole("group", { name: /select planning gameweek/i });
    const haaland = region.locator("article.squad-slot", { hasText: "Haaland" }).first();
    await expect(selector).toContainText("GW 1");
    await expect(haaland.locator(".slot-xp")).toHaveText("11.4 xP");
    await expect(haaland.locator(".squad-fixture-badges")).toContainText("EASY(H)");
    await expect(haaland.locator(".squad-fixture-badges .easy")).toBeVisible();
    await haaland.hover();
    await expect(haaland.locator(".squad-fixture-badges")).toHaveCSS("opacity", "0");
    const cardBox = await haaland.boundingBox();
    const lockBox = await haaland.getByRole("button", { name: /lock .*haaland/i }).boundingBox();
    expect(cardBox && lockBox && Math.abs(cardBox.x + cardBox.width - 4 - lockBox.x - lockBox.width)).toBeLessThan(2);
    const gameweekOneXp = await haaland.locator(".slot-xp").innerText();

    await selector.getByRole("button", { name: /next planning gameweek/i }).click();
    await expect(selector).toContainText("GW 2");
    await expect(haaland.locator(".squad-fixture-badges")).toContainText("HARD(A)");
    await expect(haaland.locator(".squad-fixture-badges .hard")).toBeVisible();
    await expect(haaland.locator(".slot-xp")).not.toHaveText(gameweekOneXp);
    await expect(region.locator("article.squad-slot", { hasText: "Rogers" }).first().locator(".squad-fixture-badges .blank")).toHaveText("BLANK");

    const entryRequests: string[] = [];
    const listener = (request: { url: () => string }) => {
      if (new URL(request.url()).pathname.includes("/api/fpl/entry/")) entryRequests.push(request.url());
    };
    page.on("request", listener);
    await page.reload();
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    await expect(page.getByRole("group", { name: /select planning gameweek/i })).toContainText("GW 2");
    expect(entryRequests).toEqual([]);
    page.off("request", listener);
  });

  test("restores the official current-gameweek squad from Settings", async ({ page }) => {
    const region = page.getByRole("region", { name: /squad builder and analysis/i });
    await region.getByRole("group", { name: /select planning gameweek/i }).getByRole("button", { name: /next planning gameweek/i }).click();
    await expect(region.getByRole("group", { name: /select planning gameweek/i })).toContainText("GW 2");

    const entryRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.includes("/api/fpl/entry/")) entryRequests.push(request.url());
    });
    await region.locator("summary.compact-action", { hasText: "SETTINGS" }).click();
    const dialog = page.waitForEvent("dialog").then((event) => event.accept());
    await region.getByRole("button", { name: /reverse all changes/i }).click();
    await dialog;
    await expect(region.getByRole("group", { name: /select planning gameweek/i })).toContainText("GW 1");
    expect(entryRequests.some((url) => url.includes("/api/fpl/entry/4827193?gameweek=1"))).toBe(true);
    await expect.poll(() => page.evaluate(() => {
      const state = JSON.parse(window.localStorage.getItem("fpl-terminal-state") ?? "null");
      return state?.planningGameweek === 1 && Object.keys(state?.gameweekPlans ?? {}).join(",") === "1";
    })).toBe(true);
  });

  test("keeps the metrics compact and Settings on-screen on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const region = page.getByRole("region", { name: /squad builder and analysis/i });
    const metrics = await region.locator(".metric-strip").boundingBox();
    expect(metrics?.height).toBeLessThan(50);

    await region.locator("summary.compact-action", { hasText: "SETTINGS" }).click();
    const settings = await region.locator(".strategy-popover").boundingBox();
    expect(settings).not.toBeNull();
    expect(settings!.x).toBeGreaterThanOrEqual(0);
    expect(settings!.x + settings!.width).toBeLessThanOrEqual(390);

    const riskLabels = await region.locator(".strategy-popover .segmented").nth(1).locator("button").allInnerTexts();
    expect(riskLabels).toEqual(["SAFE", "BALANCED", "AGGRESSIVE"]);
  });

  test("keeps the squad header on two lines and the market table inside its pane", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const region = page.getByRole("region", { name: /squad builder and analysis/i });

    const header = await region.locator(".panel-header").first().boundingBox();
    expect(header?.height).toBeLessThan(52);
    const actionTops = await region.locator(".header-actions > .compact-action, .header-actions > .strategy-settings").evaluateAll(
      (nodes) => nodes.filter((node) => node.getBoundingClientRect().width > 0).map((node) => Math.round(node.getBoundingClientRect().top)),
    );
    expect(new Set(actionTops).size).toBe(1);

    await page.locator(".mobile-tabs button", { hasText: "MARKET" }).click();
    const table = await page.locator(".table-wrap").evaluate((wrap) => ({
      overflow: wrap.scrollWidth - wrap.clientWidth,
      textUnderAdd: Array.from(wrap.querySelectorAll("tbody tr")).slice(0, 10).reduce((total, row) => {
        const add = row.lastElementChild!.getBoundingClientRect();
        return total + Array.from(row.children).filter((cell) => {
          if (cell === row.lastElementChild) return false;
          const range = document.createRange();
          range.selectNodeContents(cell);
          const text = range.getBoundingClientRect();
          return text.width > 0 && text.right > add.left + 0.5;
        }).length;
      }, 0),
    }));
    expect(table.overflow).toBeLessThanOrEqual(2);
    expect(table.textUnderAdd).toBe(0);
  });
});
