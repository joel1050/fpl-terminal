import { expect, test, type Page } from "@playwright/test";
import { interceptFplData, interceptLeaguesData } from "../fixtures/network";

/**
 * The import mode card, matched by its index rather than its wording. The
 * wording has changed once already ("ANALYZE A TEAM" -> "IMPORT A TEAM"), and
 * which mode a test picks is not what the test is about.
 */
const IMPORT_MODE = /mode b/i;

async function importTeam(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: IMPORT_MODE }).click();
  await page.getByLabel(/enter fpl id/i).fill("4827193");
  await page.getByRole("button", { name: /import team/i }).click();
  await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
}

test.describe("app shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("shell-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("shell-test", "ready");
      }
    });
    await interceptFplData(page);
    await interceptLeaguesData(page);
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("bottom tab bar offers Squad, Players, Leagues and More", async ({ page }) => {
      await importTeam(page);
      const tabs = page.getByRole("navigation", { name: "Main" });
      await expect(tabs).toBeVisible();
      expect(await tabs.locator("a, button").allInnerTexts()).toEqual(["Squad", "Players", "Leagues", "More"]);
      await expect(tabs.getByRole("button", { name: "Squad" })).toHaveAttribute("aria-current", "page");
    });

    test("Players tab shows the player market", async ({ page }) => {
      await importTeam(page);
      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Players" }).click();
      await expect(page.getByRole("region", { name: "Player universe" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Squad builder and analysis" })).toBeHidden();
    });

    test("More opens a sheet with the actions and Reset last", async ({ page }) => {
      await importTeam(page);
      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "More" }).click();
      const sheet = page.getByRole("dialog", { name: "More" });
      await expect(sheet).toBeVisible();
      const names = await sheet.getByRole("button").allInnerTexts();
      for (const name of ["Refresh", "Export", "Import", "Reverse all changes", "Choose mode", "Reset"]) {
        expect(names).toContain(name);
      }
      expect(names.at(-1)).toBe("Reset");
    });

    test("Reset asks for confirmation and clears the squad", async ({ page }) => {
      await importTeam(page);
      const confirmType = new Promise<string>((resolve) => {
        page.once("dialog", async (dialog) => {
          resolve(dialog.type());
          await dialog.accept();
        });
      });
      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "More" }).click();
      await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Reset", exact: true }).click();
      expect(await confirmType).toBe("confirm");
      await page.getByRole("button", { name: /build from scratch/i }).click();
      await expect(page.getByText(/0\s*\/\s*15 selected/i).first()).toBeVisible();
    });

    test("Escape closes the sheet and returns focus to More", async ({ page }) => {
      await importTeam(page);
      const more = page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "More" });
      await more.click();
      await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "More" })).toBeHidden();
      await expect(more).toBeFocused();
    });

    test("Leagues tab is current on /leagues, and Players returns to the market", async ({ page }) => {
      await importTeam(page);
      await page.goto("/leagues");
      const tabs = page.getByRole("navigation", { name: "Main" });
      await expect(tabs.getByRole("link", { name: "Leagues" })).toHaveAttribute("aria-current", "page");
      await tabs.getByRole("link", { name: "Players" }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("region", { name: "Player universe" })).toBeVisible();
    });
  });

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("tab bar is hidden and the top bar holds the planning stepper", async ({ page }) => {
      await importTeam(page);
      await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
      await expect(page.getByRole("group", { name: "Select planning Gameweek" })).toBeVisible();
      await expect(page.getByRole("button", { name: "More", exact: true })).toBeVisible();
    });

    test("More opens the same sheet as a popover and closes on an outside click", async ({ page }) => {
      await importTeam(page);
      await page.getByRole("button", { name: "More", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "More" });
      await expect(sheet).toBeVisible();
      const box = await sheet.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeGreaterThan(1400);
      expect(box!.width).toBeLessThan(400);
      await page.mouse.click(200, 500);
      await expect(sheet).toBeHidden();
    });
  });
});
