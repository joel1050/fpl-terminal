import { expect, type Page, test } from "@playwright/test";
import { interceptFplData } from "../fixtures/network";

const IMPORT_MODE = /mode b/i;

/** Every visible text node whose rendered size is under the floor, as `size "text"`. */
async function textUnderFloor(page: Page, floor: number): Promise<string[]> {
  return page.evaluate((min) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim();
      const el = n.parentElement;
      if (!text || !el || el.closest("[hidden]") || el.offsetParent === null) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < min) out.push(`${size}px "${text.slice(0, 24)}"`);
    }
    return [...new Set(out)];
  }, floor);
}

test.describe("UI foundations", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("fpl-terminal-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("fpl-terminal-test", "ready");
      }
    });
    await interceptFplData(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
  });

  async function importTeam(page: Page) {
    await page.getByRole("button", { name: IMPORT_MODE }).first().click();
    await page.getByLabel(/enter fpl id/i).fill("4827193");
    await page.getByRole("button", { name: /import team/i }).first().click();
    await expect(page.getByTestId("squad-roster")).toContainText(/Haaland/i);
  }

  test("phone text never goes under 12px", async ({ page }) => {
    await importTeam(page);
    expect(await textUnderFloor(page, 12), "squad tab").toEqual([]);

    await page.getByRole("navigation", { name: /terminal panels/i }).getByRole("button", { name: /market/i }).click();
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    expect(await textUnderFloor(page, 12), "players tab").toEqual([]);
  });
});
