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

  test("keeps the captain marker clear of the fixture badge on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const markers = await page.evaluate(() => {
      const intersects = (a: DOMRect, b: DOMRect) =>
        Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) && Math.min(a.right, b.right) > Math.max(a.left, b.left);
      return Array.from(document.querySelectorAll(".squad-slot")).flatMap((slot) => {
        const role = slot.querySelector(".slot-role");
        const badge = slot.querySelector(".squad-fixture-badges");
        if (!role || !badge) return [];
        return [{
          role: role.textContent?.trim() ?? "",
          collides: intersects(role.getBoundingClientRect(), badge.getBoundingClientRect()),
        }];
      });
    });

    expect(markers.map((marker) => marker.role).sort()).toEqual(["C", "VC"]);
    expect(markers.filter((marker) => marker.collides)).toEqual([]);
  });

  test("shows the C/VC and bench labels only where the role buttons are hidden", async ({ page }) => {
    const countVisible = () => page.evaluate(() => {
      const visible = (selector: string) =>
        Array.from(document.querySelectorAll(selector)).filter((el) => el.getBoundingClientRect().width > 0).length;
      return { labels: visible(".slot-role") + visible(".slot-bench-tag"), buttons: visible(".role-button") };
    });

    await page.setViewportSize({ width: 390, height: 844 });
    const phone = await countVisible();
    expect(phone.labels).toBeGreaterThan(0);
    expect(phone.buttons).toBe(0);

    await page.setViewportSize({ width: 1280, height: 720 });
    const desktop = await countVisible();
    expect(desktop.labels).toBe(0);
    expect(desktop.buttons).toBeGreaterThan(0);
  });

  test("puts the planner header on one line without the gameweek readout", async ({ page }) => {
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const header = await page.evaluate(() => {
        const topbar = document.querySelector(".terminal-app .topbar")!;
        const stats = document.querySelector(".terminal-app .topbar-stats");
        const bar = topbar.getBoundingClientRect();
        const offCentre = Array.from(topbar.children)
          .filter((child) => child.getBoundingClientRect().width > 0)
          .map((child) => {
            const box = child.getBoundingClientRect();
            return Math.abs((box.top + box.bottom) / 2 - (bar.top + bar.bottom) / 2);
          });
        return {
          statsShown: !!stats && getComputedStyle(stats).display !== "none",
          height: Math.round(bar.height),
          worstOffCentre: Math.round(Math.max(...offCentre)),
          overflow: topbar.scrollWidth - topbar.clientWidth,
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          actions: Array.from(topbar.querySelectorAll(".topbar-actions .text-button")).map((button) => button.textContent?.trim()),
        };
      });

      expect(header.statsShown, `gameweek readout hidden at ${width}`).toBe(false);
      expect(header.height, `one header row at ${width}`).toBeLessThan(60);
      expect(header.worstOffCentre, `every item on that row at ${width}`).toBeLessThan(8);
      expect(header.overflow, `header fits at ${width}`).toBeLessThanOrEqual(0);
      expect(header.documentOverflow, `page fits at ${width}`).toBeLessThanOrEqual(0);
      expect(header.actions).toEqual(["REFRESH", "EXPORT", "IMPORT", "RESET"]);
    }
  });

  test("closes the optimizer settings popover from its own close button", async ({ page }) => {
    for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
      await page.setViewportSize(size);
      if (size.width < 901) await page.getByRole("button", { name: "SQUAD", exact: true }).click().catch(() => {});
      await page.locator(".strategy-settings > summary").click();
      const popover = page.locator(".strategy-popover");
      await expect(popover).toBeVisible();

      const close = page.locator(".strategy-close");
      const box = (await close.boundingBox())!;
      const pop = (await popover.boundingBox())!;
      const title = await popover.locator(".section-kicker").evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rect = range.getBoundingClientRect();
        return { right: rect.right };
      });

      expect(box.x, `close button clears the title at ${size.width}`).toBeGreaterThan(title.right - 2);
      expect(box.x + box.width, `close button inside the popover at ${size.width}`).toBeLessThanOrEqual(pop.x + pop.width + 1);
      if (size.width < 901) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);

      await close.click();
      await expect(popover).toBeHidden();
    }
  });
});
