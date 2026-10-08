import { expect, type Page, test } from "@playwright/test";
import { interceptFplData, interceptLeaguesData } from "../fixtures/network";

const IMPORT_MODE = /mode b/i;

/**
 * A two-move chain. The shared fixture serves only single moves, so the test
 * serves this one when the banked-transfers select asks for two.
 */
const CHAIN_SUGGESTION = {
  outgoingPlayerId: 21,
  incomingPlayerId: 2,
  horizon: 5,
  beforeXp: 250,
  afterXp: 258,
  projectedDelta: 8,
  projectedDeltaPerGW: 1.6,
  cashReleasedTenths: -90,
  score: 0.4,
  kind: "XP_UPGRADE",
  incomingRisk: 0.05,
  confidence: "HIGH",
  reason: "xP upgrade: +8.0 xP over 5GW, two moves",
  transfersCount: 2,
  moves: [
    { outgoingPlayerId: 21, incomingPlayerId: 2, cashReleasedTenths: -50 },
    { outgoingPlayerId: 22, incomingPlayerId: 3, cashReleasedTenths: -40 },
  ],
};

/**
 * Every rendered text node, plus every rendered form control, whose computed
 * size is under the floor, as `size "text"`. Fixed-position elements count,
 * which offsetParent would skip. Form controls count too, because an input
 * has no text node of its own.
 */
async function textUnderFloor(page: Page, floor: number): Promise<string[]> {
  return page.evaluate((min) => {
    const out: string[] = [];
    const shown = (el: Element) => !el.closest("[hidden]") && el.checkVisibility();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim();
      const el = n.parentElement;
      if (!text || !el || !shown(el)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < min) out.push(`${size}px "${text.slice(0, 24)}"`);
    }
    document.querySelectorAll("input, select, textarea, button").forEach((el) => {
      if (!shown(el)) return;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < min) out.push(`${size}px <${el.tagName.toLowerCase()}> "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 24)}"`);
    });
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
    await expect(page.getByRole("button", { name: /import team/i }).first()).toBeVisible();
    expect(await textUnderFloor(page, 12), "import screen").toEqual([]);
    await page.getByRole("button", { name: /import team/i }).first().click();
    await expect(page.getByTestId("squad-roster")).toContainText(/Haaland/i);
  }

  test("phone text never goes under 12px", async ({ page }) => {
    await page.route("**/api/transfer-suggestions", async (route) => {
      const body = route.request().postDataJSON() as { maxTransfers?: number };
      if (body.maxTransfers !== 2) return route.fallback();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ gameweek: 1, horizon: 5, suggestions: [CHAIN_SUGGESTION] }) });
    });

    await expect(page.getByRole("button", { name: IMPORT_MODE }).first()).toBeVisible();
    expect(await textUnderFloor(page, 12), "mode screen").toEqual([]);

    await importTeam(page);
    const transfers = page.getByRole("region", { name: "Transfer suggestions" });
    await expect(transfers.getByRole("button", { name: /^simulate$/i }).first()).toBeVisible();
    expect(await textUnderFloor(page, 12), "squad tab").toEqual([]);

    await page.getByLabel("Banked transfers").selectOption("2");
    await expect(transfers.locator(".replacement-row").first()).toContainText("2 transfers");
    expect(await textUnderFloor(page, 12), "chain suggestion").toEqual([]);

    await transfers.getByRole("button", { name: /^simulate$/i }).first().click();
    await expect(page.locator(".simulation-move").first()).toBeVisible();
    expect(await textUnderFloor(page, 12), "simulated swap").toEqual([]);

    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Players" }).click();
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    expect(await textUnderFloor(page, 12), "players tab").toEqual([]);

    await page.getByRole("button", { name: /haaland/i }).first().click();
    const detail = page.getByRole("dialog", { name: /haaland/i });
    await expect(detail.getByRole("heading", { name: /recent matches/i })).toBeVisible();
    await detail.locator(".recent-match-row summary").first().click();
    await expect(detail.locator(".recent-match-stats").first()).toBeVisible();
    await detail.locator("details.advanced-stat-disclosure > summary").click();
    await expect(detail.locator("details.advanced-stat-disclosure")).toHaveAttribute("open", "");
    expect(await textUnderFloor(page, 12), "player detail").toEqual([]);
  });

  test("the phone Players list keeps text at 12px and puts its first row above the tab bar", async ({ page }) => {
    await importTeam(page);
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Players" }).click();
    const firstRow = page.getByTestId("player-row").first();
    await expect(firstRow).toBeVisible();
    expect(await textUnderFloor(page, 12), "players list").toEqual([]);
    const box = await firstRow.boundingBox();
    expect(box, "first player row box").not.toBeNull();
    expect(box!.y, "first row top").toBeLessThan(844 - 56);
  });
});

test.describe("UI foundations on Leagues", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("fpl-leagues-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("fpl-leagues-test", "ready");
      }
    });
    await interceptLeaguesData(page);
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test("phone Leagues text never goes under 12px, on every tab and in the league drop-down", async ({ page }) => {
    await page.goto("/leagues");
    await expect(page.getByText("FPL TEAM REQUIRED")).toBeVisible();
    expect(await textUnderFloor(page, 12), "import gate").toEqual([]);

    await page.getByLabel(/fpl team id/i).fill("4827193");
    await page.getByRole("button", { name: /^IMPORT$/i }).click();
    await expect(page.getByTestId("league-standings")).toBeVisible();
    expect(await textUnderFloor(page, 12), "standings").toEqual([]);

    await page.getByRole("button", { name: /choose league/i }).click();
    await expect(page.getByRole("region", { name: "My leagues" })).toBeVisible();
    expect(await textUnderFloor(page, 12), "league drop-down").toEqual([]);
    await page.keyboard.press("Escape");

    for (const tab of ["TEAM", "MATCHES", "FEED"]) {
      await page.locator(".leagues-mobile-tabs").getByRole("button", { name: tab }).click();
      expect(await textUnderFloor(page, 12), `${tab} tab`).toEqual([]);
    }
  });
});
