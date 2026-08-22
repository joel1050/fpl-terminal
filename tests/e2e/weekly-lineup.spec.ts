import { expect, type Page, test } from "@playwright/test";
import { bootstrapStaticFixture } from "../fixtures/fpl";
import { interceptFplData } from "../fixtures/network";

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
    await chooseMode(page, /analyze (?:a )?team/i);
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

  async function chooseCaptainAndVice(region: ReturnType<typeof weeklyRegion>) {
    const captainButtons = region.getByRole("button", { name: /captain/i });
    const captainCount = await captainButtons.count();
    let captainChosen = false;
    let captainPlayer = "";
    for (let index = 0; index < captainCount; index += 1) {
      const candidate = captainButtons.nth(index);
      const label = `${await candidate.getAttribute("aria-label")} ${await candidate.innerText().catch(() => "")}`;
      if (!/vice/i.test(label) && await candidate.getAttribute("aria-pressed") !== "true" && await candidate.isVisible().catch(() => false)) {
        await candidate.click();
        captainPlayer = label.replace(/^.*?make\s+/i, "").replace(/\s+captain.*$/i, "").trim().toLowerCase();
        captainChosen = true;
        break;
      }
    }
    expect(captainChosen, "a starter must expose a captain control").toBe(true);

    const viceButtons = region.getByRole("button", { name: /vice[- ]?captain/i });
    const viceCount = await viceButtons.count();
    let viceChosen = false;
    for (let index = 0; index < viceCount; index += 1) {
      const candidate = viceButtons.nth(index);
      const label = `${await candidate.getAttribute("aria-label")} ${await candidate.innerText().catch(() => "")}`.toLowerCase();
      if ((!captainPlayer || !label.includes(captainPlayer)) && await candidate.isVisible().catch(() => false)) {
        await candidate.click();
        viceChosen = true;
        break;
      }
    }
    expect(viceChosen, "a different starter must expose a vice-captain control").toBe(true);
  }

  async function reorderBench(region: ReturnType<typeof weeklyRegion>) {
    const controls = region.getByRole("button", { name: /(?:move|reorder).*(?:bench|up|down)|(?:bench|up|down).*(?:move|reorder)/i });
    const count = await controls.count();
    for (let index = 0; index < count; index += 1) {
      const move = controls.nth(index);
      if (await move.isEnabled().catch(() => false) && await move.isVisible().catch(() => false)) {
        await move.click();
        return;
      }
    }
    throw new Error("the three-player outfield bench must expose an enabled order control");
  }

  async function editWeeklyTeam(region: ReturnType<typeof weeklyRegion>) {
    await chooseCaptainAndVice(region);
    await reorderBench(region);
  }

  test("builds a legal 15, picks and edits the weekly team, and reloads", async ({ page }) => {
    await importLegalSquad(page);
    const region = await openWeeklyTeam(page);

    await expect(region.getByRole("article")).toHaveCount(15);
    await expect(region.getByRole("region", { name: /^starting xi$/i })).toBeVisible();
    await expect(region.getByRole("region", { name: /^bench$/i })).toBeVisible();
    await expect(region.getByRole("button", { name: /select .* to move to bench/i })).toHaveCount(11);
    await expect(region.getByRole("button", { name: /select .* to move into the starting xi/i })).toHaveCount(4);
    await editWeeklyTeam(region);

    await expect(region.locator(".lineup-status")).toHaveCount(0);
    await expect(region.getByLabel("Squad projection metrics")).toContainText(/GW xP/i);
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
    await expect(reloadedRegion.getByRole("button", { name: /select .* to move to bench/i })).toHaveCount(11);
    await expect(reloadedRegion.getByRole("button", { name: /select .* to move into the starting xi/i })).toHaveCount(4);
    await expect(reloadedRegion.locator('button[aria-label$=" captain"][aria-pressed="true"]')).toHaveCount(1);
    await expect(reloadedRegion.locator('button[aria-label$=" vice-captain"][aria-pressed="true"]')).toHaveCount(1);
    await expect(reloadedRegion.getByRole("button", { name: /make .* captain/i }).first()).toBeVisible();
    await expect(reloadedRegion.getByRole("button", { name: /make .* vice-captain/i }).first()).toBeVisible();
    await expect(reloadedRegion.getByText(/^B[123]$/).first()).toBeVisible();
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
    await expect(region.getByRole("article")).toHaveCount(15);
    await expect(region.getByRole("button", { name: /select .* to move to bench/i })).toHaveCount(11);
    await expect(region.getByRole("button", { name: /select .* to move into the starting xi/i })).toHaveCount(4);
    await expect(region.getByRole("button", { name: /make .* captain/i }).first()).toBeVisible();
    await expect(region.getByRole("button", { name: /make .* vice-captain/i }).first()).toBeVisible();
    const layout = await region.evaluate((panel) => {
      const roster = panel.querySelector<HTMLElement>('[data-testid="squad-roster"]')!;
      const rosterRect = roster.getBoundingClientRect();
      const cards = [...roster.querySelectorAll<HTMLElement>("article")].map((card) => card.getBoundingClientRect());
      const cardGroup = (element: Element) => {
        const rects = [...element.querySelectorAll<HTMLElement>("article")].map((card) => card.getBoundingClientRect());
        return { left: Math.min(...rects.map((rect) => rect.left)), right: Math.max(...rects.map((rect) => rect.right)) };
      };
      const centered = (rect: { left: number; right: number }) => Math.abs((rect.left + rect.right) / 2 - (rosterRect.left + rosterRect.right) / 2) < 1;
      const positionGroups = [...roster.querySelectorAll(".starting-position")].map(cardGroup);
      const goalkeeper = roster.querySelector<HTMLElement>(".starting-position article")!.getBoundingClientRect();
      return { centeredRows: positionGroups.every(centered), centeredBench: centered(cardGroup(roster.querySelector(".bench-section")!)), goalkeeperWideEnough: goalkeeper.width >= 120, cardsInsidePanel: cards.every((card) => card.top >= rosterRect.top && card.bottom <= panel.getBoundingClientRect().bottom) };
    });
    expect(layout).toEqual({ centeredRows: true, centeredBench: true, goalkeeperWideEnough: true, cardsInsidePanel: true });
  });

  test("shows the imported centered XI and bench", async ({ page }) => {
    await importLegalSquad(page);
    const region = weeklyRegion(page);
    await expect(region.getByRole("region", { name: /^starting xi$/i })).toBeVisible();
    await expect(region.getByRole("region", { name: /^bench$/i })).toBeVisible();
    await expect(region.getByRole("button", { name: /make .* captain/i })).toHaveCount(11);
    await expect(region.getByRole("button", { name: /select .* to move into the starting xi/i })).toHaveCount(4);
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
    const captain = region.getByRole("button", { name: /make .* captain/i }).first();
    await expect(captain).toBeVisible();
    expect((await captain.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  });
});
