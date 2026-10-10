import { expect, type Page, test } from "@playwright/test";
import { bootstrapStaticFixture } from "../fixtures/fpl";
import { interceptFplData } from "../fixtures/network";

/**
 * The import mode card, matched by its index rather than its wording. The
 * wording has changed once already ("ANALYZE A TEAM" -> "IMPORT A TEAM"), and
 * which mode a test picks is not what the test is about.
 */
const IMPORT_MODE = /mode b/i;

/**
 * Weekly-pick acceptance coverage deliberately uses the visible terminal
 * controls. The test fixture is intercepted at the FPL boundary, so these
 * checks never depend on a live deadline or a changing player universe.
 */
test.describe("weekly lineup acceptance", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("weekly-lineup-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("weekly-lineup-test", "ready");
      }
    });
    await interceptFplData(page);
    await page.goto("/");
  });

  async function clickButton(page: Page, name: RegExp) {
    const button = page.getByRole("button", { name }).first();
    await expect(button, `button ${name} should be accessible`).toBeVisible();
    await button.click();
  }

  async function chooseMode(page: Page, mode: RegExp) {
    const button = page.getByRole("button", { name: mode }).first();
    await expect(button).toBeVisible();
    await button.click();
    const market = page.getByPlaceholder(/search player, club/i);
    if (!(await market.isVisible().catch(() => false))) {
      // Hydration can finish immediately after the first click in a fresh
      // browser context; retry only while the chooser is still on screen.
      const chooser = page.getByRole("button", { name: mode }).first();
      if (await chooser.isVisible().catch(() => false)) await chooser.click();
    }
    const entryId = page.getByLabel(/enter fpl id/i);
    if (await entryId.isVisible().catch(() => false)) {
      await entryId.fill("4827193");
      await clickButton(page, /import team/i);
    }
  }

  async function waitForMarket(page: Page) {
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /add haaland/i })).toBeVisible();
  }

  async function importLegalSquad(page: Page) {
    await chooseMode(page, IMPORT_MODE);
    await waitForMarket(page);
    await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
  }

  function weeklyRegion(page: Page) {
    return page.getByRole("region", { name: /squad builder and analysis/i }).first();
  }

  async function openWeeklyTeam(page: Page, generate = true) {
    const region = weeklyRegion(page);
    await expect(region, "the unified squad panel should expose the weekly controls").toBeVisible();
    const pickButton = region.getByRole("button", { name: /^PICK TEAM$/i }).first();
    if (generate && await pickButton.isVisible().catch(() => false)) {
      await pickButton.click();
      await expect(page.getByText(/team picked and saved/i)).toBeVisible();
    }
    return region;
  }

  /** The starting XI and bench regions, as the pitch exposes them. */
  function startingXi(region: ReturnType<typeof weeklyRegion>) {
    return region.getByRole("region", { name: /^starting xi$/i });
  }

  function benchOf(region: ReturnType<typeof weeklyRegion>) {
    return region.getByRole("region", { name: /^bench$/i });
  }

  /** Captaincy and bench order live in each player's sheet, which a tap on the token opens. */
  async function openStarterSheet(page: Page, region: ReturnType<typeof weeklyRegion>) {
    await startingXi(region).getByTestId("squad-token").first().click();
    const sheet = page.getByRole("dialog").first();
    await expect(sheet).toBeVisible();
    return sheet;
  }

  async function chooseCaptainAndVice(page: Page, region: ReturnType<typeof weeklyRegion>) {
    const starters = startingXi(region).getByTestId("squad-token");
    const starterCount = await starters.count();
    let captainIndex = -1;
    for (let index = 0; index < starterCount && captainIndex < 0; index += 1) {
      await starters.nth(index).click();
      const sheet = page.getByRole("dialog").first();
      await expect(sheet).toBeVisible();
      const captain = sheet.getByRole("button", { name: /make .* captain/i });
      if (await captain.getAttribute("aria-pressed") !== "true") {
        await captain.click();
        captainIndex = index;
      }
      await page.keyboard.press("Escape");
    }
    expect(captainIndex, "a starter must expose a captain control").toBeGreaterThanOrEqual(0);

    let viceChosen = false;
    for (let index = 0; index < starterCount && !viceChosen; index += 1) {
      if (index === captainIndex) continue;
      await starters.nth(index).click();
      const sheet = page.getByRole("dialog").first();
      await expect(sheet).toBeVisible();
      const vice = sheet.getByRole("button", { name: /make .* vice-captain/i });
      if (await vice.getAttribute("aria-pressed") !== "true") {
        await vice.click();
        viceChosen = true;
      }
      await page.keyboard.press("Escape");
    }
    expect(viceChosen, "a different starter must expose a vice-captain control").toBe(true);
  }

  async function reorderBench(page: Page, region: ReturnType<typeof weeklyRegion>) {
    const bench = benchOf(region).getByTestId("squad-token");
    const benchCount = await bench.count();
    for (let index = 0; index < benchCount; index += 1) {
      await bench.nth(index).click();
      const sheet = page.getByRole("dialog").first();
      await expect(sheet).toBeVisible();
      const down = sheet.getByRole("button", { name: /move .* down the bench order/i });
      const canMoveDown = (await down.count()) > 0 && (await down.isEnabled());
      if (canMoveDown) {
        await down.click();
        await page.keyboard.press("Escape");
        return;
      }
      await page.keyboard.press("Escape");
    }
    throw new Error("the three-player outfield bench must expose an enabled order control");
  }

  async function editWeeklyTeam(page: Page, region: ReturnType<typeof weeklyRegion>) {
    await chooseCaptainAndVice(page, region);
    await reorderBench(page, region);
  }

  test("builds a legal 15, picks and edits the weekly team, and reloads", async ({ page }) => {
    await importLegalSquad(page);
    const region = await openWeeklyTeam(page);

    await expect(region.getByTestId("squad-token")).toHaveCount(15);
    await expect(region.getByRole("region", { name: /^starting xi$/i })).toBeVisible();
    await expect(region.getByRole("region", { name: /^bench$/i })).toBeVisible();
    await expect(startingXi(region).getByTestId("squad-token")).toHaveCount(11);
    await expect(benchOf(region).getByTestId("squad-token")).toHaveCount(4);
    await editWeeklyTeam(page, region);

    await expect(region.locator(".lineup-status")).toHaveCount(0);
    await expect(region.getByLabel("Squad projection metrics")).toContainText(/Proj\. GW/i);
    const saved = await page.evaluate(() => {
      const state = JSON.parse(window.localStorage.getItem("fpl-terminal-state") ?? "null");
      return state && {
        benchGoalkeeperId: state.benchGoalkeeperId,
        benchOrder: state.benchOrder,
        captainId: state.captainId,
        viceCaptainId: state.viceCaptainId,
        lineupGameweek: state.lineupGameweek,
        lineupProjectionFingerprint: state.lineupProjectionFingerprint,
      };
    });
    expect(saved?.benchOrder).toHaveLength(3);
    expect(saved?.captainId).not.toBe(saved?.viceCaptainId);
    await page.reload();
    await waitForMarket(page);
    const reloadedRegion = await openWeeklyTeam(page, false);
    await expect(startingXi(reloadedRegion).getByTestId("squad-token")).toHaveCount(11);
    await expect(benchOf(reloadedRegion).getByTestId("squad-token")).toHaveCount(4);
    await expect(reloadedRegion.getByTestId("token-role").filter({ hasText: /^C$/ })).toHaveCount(1);
    await expect(reloadedRegion.getByTestId("token-role").filter({ hasText: /^V$/ })).toHaveCount(1);
    const sheet = await openStarterSheet(page, reloadedRegion);
    await expect(sheet.getByRole("button", { name: /make .* captain/i })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /make .* vice-captain/i })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(benchOf(reloadedRegion).getByTestId("token-bench").filter({ hasText: /^B[123]$/ }).first()).toBeVisible();
    const reloaded = await page.evaluate(() => {
      const state = JSON.parse(window.localStorage.getItem("fpl-terminal-state") ?? "null");
      return state && {
        benchGoalkeeperId: state.benchGoalkeeperId,
        benchOrder: state.benchOrder,
        captainId: state.captainId,
        viceCaptainId: state.viceCaptainId,
        lineupGameweek: state.lineupGameweek,
        lineupProjectionFingerprint: state.lineupProjectionFingerprint,
      };
    });
    expect(reloaded).toEqual(saved);
  });

  test("imports a legal 15 and exposes the applied lineup on the roster", async ({ page }) => {
    await importLegalSquad(page);
    const region = await openWeeklyTeam(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(region.getByTestId("squad-token")).toHaveCount(15);
    await expect(startingXi(region).getByTestId("squad-token")).toHaveCount(11);
    await expect(benchOf(region).getByTestId("squad-token")).toHaveCount(4);
    const sheet = await openStarterSheet(page, region);
    await expect(sheet.getByRole("button", { name: /make .* captain/i })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /make .* vice-captain/i })).toBeVisible();
    await page.keyboard.press("Escape");
    const layout = await region.evaluate((panel) => {
      const roster = panel.querySelector<HTMLElement>('[data-testid="squad-roster"]')!;
      const rosterRect = roster.getBoundingClientRect();
      const tokens = [...roster.querySelectorAll<HTMLElement>('[data-testid="squad-token"]')].map((token) => token.getBoundingClientRect());
      const tokenGroup = (element: Element) => {
        const rects = [...element.querySelectorAll<HTMLElement>('[data-testid="squad-token"]')].map((token) => token.getBoundingClientRect());
        return { left: Math.min(...rects.map((rect) => rect.left)), right: Math.max(...rects.map((rect) => rect.right)) };
      };
      const centered = (rect: { left: number; right: number }) => Math.abs((rect.left + rect.right) / 2 - (rosterRect.left + rosterRect.right) / 2) < 1;
      const positionGroups = [...roster.querySelectorAll(".starting-position")].map(tokenGroup);
      // A token is at least 76px wide: its flex basis on the pitch.
      const goalkeeper = roster.querySelector<HTMLElement>('.starting-position [data-testid="squad-token"]')!.getBoundingClientRect();
      return { centeredRows: positionGroups.every(centered), centeredBench: centered(tokenGroup(roster.querySelector(".bench-section")!)), goalkeeperWideEnough: goalkeeper.width >= 76, cardsInsidePanel: tokens.every((token) => token.top >= rosterRect.top && token.bottom <= panel.getBoundingClientRect().bottom) };
    });
    expect(layout).toEqual({ centeredRows: true, centeredBench: true, goalkeeperWideEnough: true, cardsInsidePanel: true });
  });

  test("shows the imported centered XI and bench", async ({ page }) => {
    await importLegalSquad(page);
    const region = weeklyRegion(page);
    await expect(region.getByRole("region", { name: /^starting xi$/i })).toBeVisible();
    await expect(region.getByRole("region", { name: /^bench$/i })).toBeVisible();
    await expect(startingXi(region).getByTestId("squad-token")).toHaveCount(11);
    await expect(benchOf(region).getByTestId("squad-token")).toHaveCount(4);
  });

  test("surfaces stale FPL data after a gameweek refresh", async ({ page }) => {
    await importLegalSquad(page);
    await openWeeklyTeam(page);

    await page.route("**/api/fpl/bootstrap*", async (route) => {
      if (!route.request().url().includes("refresh=1")) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...bootstrapStaticFixture,
          gameweek: 2,
          source: "snapshot",
          freshness: {
            bootstrap: {
              source: "snapshot",
              stale: true,
              fetchedAt: "2025-01-01T00:00:00.000Z",
              ageSeconds: 999999,
            },
          },
          errors: ["stale snapshot after gameweek change"],
        }),
      });
    });

    await clickButton(page, /^REFRESH$/i);
    await expect(page.getByLabel("Terminal status")).toContainText(/STALE|SNAPSHOT/i);
    await expect(weeklyRegion(page).getByRole("button", { name: /pick team · outdated/i })).toBeVisible();
  });

  test("keeps the weekly picker usable on a phone-sized screen", async ({ page }) => {
    await importLegalSquad(page);
    const region = await openWeeklyTeam(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(region).toBeVisible();
    // Narrow viewports open a bottom sheet for each player, with captaincy inside it.
    await startingXi(region).getByTestId("squad-token").first().click();
    const sheet = page.getByRole("dialog").first();
    await expect(sheet).toBeVisible();
    const captain = sheet.getByRole("button", { name: /make .* captain/i });
    await expect(captain).toBeVisible();
    expect((await captain.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    // Captaincy through the sheet applies and marks the pitch token.
    // Keyboard activation: the Next.js dev-tools overlay sits over this
    // bottom-anchored sheet in dev and would swallow a pointer tap.
    await captain.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/captaincy updated/i)).toBeVisible();
  });
});
