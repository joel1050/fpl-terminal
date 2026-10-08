import { expect, type Page, test } from "@playwright/test";
import { interceptFplData } from "../fixtures/network";

const IMPORT_MODE = /mode b/i;

async function importTeam(page: Page) {
  await page.getByRole("button", { name: IMPORT_MODE }).click();
  await page.getByLabel(/enter fpl id/i).fill("4827193");
  await page.getByRole("button", { name: /import team/i }).click();
  await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
}

test.describe("players filters", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("players-filters-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("players-filters-test", "ready");
      }
    });
    await interceptFplData(page);
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await importTeam(page);
      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Players" }).click();
    });

    test("the first player row sits above the tab bar", async ({ page }) => {
      const row = page.getByTestId("player-row").first();
      await expect(row).toBeVisible();
      const box = await row.boundingBox();
      expect(box, "first player row box").not.toBeNull();
      expect(box!.y, "first row top").toBeLessThan(844 - 56);
    });

    test("the club and price selects wait in the sheet, not on the first screen", async ({ page }) => {
      await expect(page.getByLabel("Filter by club")).toHaveCount(0);
      await expect(page.getByLabel("Maximum price")).toHaveCount(0);
      await expect(page.getByRole("group", { name: "Filter by position" })).toBeVisible();
    });

    test("Filters opens a dialog, a maximum price narrows the list, and its chip clears it", async ({ page }) => {
      const rows = page.getByTestId("player-row");
      const all = await rows.count();

      await page.getByRole("button", { name: /^Filters · 0$/ }).click();
      const sheet = page.getByRole("dialog", { name: "Filters" });
      await expect(sheet).toBeVisible();
      await sheet.getByLabel("Maximum price").fill("5.0");
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();

      await expect(page.getByRole("button", { name: /^Filters · 1$/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove Max £5.0m" })).toBeVisible();
      await expect.poll(() => rows.count()).toBeLessThan(all);

      await page.getByRole("button", { name: "Remove Max £5.0m" }).click();
      await expect(page.getByRole("button", { name: "Remove Max £5.0m" })).toHaveCount(0);
      await expect.poll(() => rows.count()).toBe(all);
    });

    test("Reset filters in the sheet clears every filter", async ({ page }) => {
      await page.getByRole("button", { name: /^Filters · 0$/ }).click();
      const sheet = page.getByRole("dialog", { name: "Filters" });
      await sheet.getByLabel("Maximum price").fill("5.0");
      await sheet.getByRole("button", { name: "Reset filters" }).click();
      await expect(sheet.getByLabel("Maximum price")).toHaveValue("");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: /^Filters · 0$/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
    });
  });

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await importTeam(page);
    });

    test("the market is still the desktop table, with no phone list", async ({ page }) => {
      await expect(page.getByRole("region", { name: "Player universe" }).getByRole("table", { name: "Players" })).toBeVisible();
      await expect(page.getByTestId("player-row")).toHaveCount(0);
    });

    test("/ focuses the search box", async ({ page }) => {
      await page.keyboard.press("/");
      await expect(page.getByLabel("Search players")).toBeFocused();
    });

    test("club and maximum price sit in the row once, and the sheet leaves them out", async ({ page }) => {
      await expect(page.getByLabel("Filter by club")).toHaveCount(1);
      await expect(page.getByLabel("Maximum price")).toHaveCount(1);

      await page.getByRole("button", { name: /^Filters · 0$/ }).click();
      const sheet = page.getByRole("dialog", { name: "Filters" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByLabel("Minimum price")).toHaveCount(1);
      await expect(page.getByLabel("Filter by club")).toHaveCount(1);
      await expect(page.getByLabel("Maximum price")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    });

    test("the filter count ignores position and search", async ({ page }) => {
      await page.getByRole("group", { name: "Filter by position" }).getByRole("button", { name: "GK", exact: true }).click();
      await page.getByLabel("Search players").fill("a");
      await expect(page.getByRole("button", { name: /^Filters · 0$/ })).toBeVisible();
    });
  });
});
