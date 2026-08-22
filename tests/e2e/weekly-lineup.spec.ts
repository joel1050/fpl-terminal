import { expect, type Page, test } from "@playwright/test";
import { bootstrapStaticFixture, fixtureSquadNames } from "../fixtures/fpl";
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
  }

  async function waitForMarket(page: Page) {
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /add haaland/i })).toBeVisible();
  }

  async function pasteLegalSquad(page: Page) {
    await chooseMode(page, /analyze (?:a )?team/i);
    await waitForMarket(page);
    const paste = page.getByRole("textbox", { name: /paste squad player names/i });
    await expect(paste).toBeVisible();
    await paste.fill(fixtureSquadNames.join("\n"));
    await clickButton(page, /resolve names/i);
    await expect(page.getByText(/15 added|squad analysis|ready/i).first()).toBeVisible();
    await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
  }

  function weeklyRegion(page: Page) {
    return page.getByRole("region", { name: /gw team picker|weekly lineup|gw team/i }).first();
  }

  async function openWeeklyTeam(page: Page, generate = true) {
    await clickButton(page, /^GW TEAM$/i);
    const region = weeklyRegion(page);
    await expect(region, "GW TEAM should expose an accessible picker region").toBeVisible();
    const pickButton = region.getByRole("button", { name: /^PICK GW TEAM$/i }).first();
    if (generate && await pickButton.isVisible().catch(() => false)) {
      await pickButton.click();
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

  async function applyWeeklyTeam(page: Page, region: ReturnType<typeof weeklyRegion>) {
    await chooseCaptainAndVice(region);
    await reorderBench(region);
    await expect(region.getByText(/apply|save|draft|proposed|changes/i).first()).toBeVisible();
    await clickButton(page, /^APPLY LINEUP$/i);
    await expect(page.getByText(/GW TEAM pick applied|lineup.*(?:applied|saved|updated)/i).first()).toBeVisible();
  }

  test("builds a legal 15, previews GW TEAM, edits captaincy and bench order, applies, and reloads", async ({ page }) => {
    await pasteLegalSquad(page);
    const region = await openWeeklyTeam(page);

    await expect(region).toContainText(/starters/i);
    await expect(region).toContainText(/11\s*\/\s*11/i);
    await expect(region.getByRole("article")).toHaveCount(15);
    await expect(region).toContainText(/ordered bench/i);
    await expect(region).toContainText(/GK\s*·\s*1\s*·\s*2\s*·\s*3/i);
    await applyWeeklyTeam(page, region);

    await expect(region).toContainText(/applied|saved|current|captain|vice/i);
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
    await chooseMode(page, /analyze (?:a )?team/i);
    await waitForMarket(page);
    const reloadedRegion = await openWeeklyTeam(page, false);
    await expect(reloadedRegion).toContainText(/11\s*\/\s*11|starters/i);
    await expect(reloadedRegion.locator('button[aria-label$=" captain"][aria-pressed="true"]')).toHaveCount(1);
    await expect(reloadedRegion.locator('button[aria-label$=" vice-captain"][aria-pressed="true"]')).toHaveCount(1);
    await expect(reloadedRegion.getByRole("button", { name: /make .* captain/i }).first()).toBeVisible();
    await expect(reloadedRegion.getByRole("button", { name: /make .* vice-captain/i }).first()).toBeVisible();
    await expect(reloadedRegion).toContainText(/bench|substitutes/i);
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

  test("pastes a legal 15 and makes the weekly lineup preview available", async ({ page }) => {
    await pasteLegalSquad(page);
    const region = await openWeeklyTeam(page);
    await expect(region).toContainText(/starters/i);
    await expect(region).toContainText(/11\s*\/\s*11/i);
    await expect(region.getByRole("article")).toHaveCount(15);
    await expect(region).toContainText(/ordered bench/i);
    await expect(region).toContainText(/GK\s*·\s*1\s*·\s*2\s*·\s*3/i);
    await expect(region.getByRole("button", { name: /make .* captain/i }).first()).toBeVisible();
    await expect(region.getByRole("button", { name: /make .* vice-captain/i }).first()).toBeVisible();
  });

  test("surfaces stale FPL data after a gameweek refresh", async ({ page }) => {
    await pasteLegalSquad(page);
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
    await expect(page.getByText(/stale|out of date|refresh.*lineup|reselect/i).first()).toBeVisible();
  });

  test("keeps the weekly picker usable on a phone-sized screen", async ({ page }) => {
    await pasteLegalSquad(page);
    const region = await openWeeklyTeam(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(region).toBeVisible();
    const captain = region.getByRole("button", { name: /make .* captain/i }).first();
    await expect(captain).toBeVisible();
    expect((await captain.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  });
});
