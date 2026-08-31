import { expect, type Page, test } from "@playwright/test";
import { interceptFplData } from "../fixtures/network";

test.describe("FPL Terminal acceptance", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("fpl-terminal-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("fpl-terminal-test", "ready");
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

  async function addPlayer(page: Page, name: string) {
    const search = page.getByPlaceholder(/search|filter/i).first();
    if (await search.count()) {
      await search.fill(name);
      await page.waitForTimeout(50);
    }

    const row = page.getByRole("row", { name: new RegExp(`\\b${name}\\b`, "i") }).first();
    if (await row.count()) {
      const rowAction = row.getByRole("button", { name: /add|select|pick|\+/i }).first();
      if (await rowAction.count()) {
        await rowAction.click();
        await closePlayerDetail(page);
        return;
      }
    }

    await clickButton(page, new RegExp(`(?:add|select|pick).*${name}|${name}.*(?:add|select|pick)`, "i"));
    await closePlayerDetail(page);
  }

  async function closePlayerDetail(page: Page) {
    const close = page.getByRole("button", { name: /close player detail/i }).first();
    if (await close.isVisible().catch(() => false)) await close.click();
  }

  async function lockPlayer(page: Page, name: string) {
    const row = page.getByRole("row", { name: new RegExp(`\\b${name}\\b`, "i") }).first();
    const rowLock = row.getByRole("button", { name: /lock/i }).first();
    if (await rowLock.count()) {
      await rowLock.click();
      return;
    }

    const card = page.getByRole("article").filter({ hasText: name }).first();
    await card.hover();
    await card.getByRole("button", { name: new RegExp(`lock.*${name}|${name}.*lock`, "i") }).click();
  }

  async function waitForMarket(page: Page) {
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /add haaland/i })).toBeVisible();
  }

  async function chooseMode(page: Page, mode: RegExp) {
    await clickButton(page, mode);
    const market = page.getByPlaceholder(/search player, club/i);
    if (!(await market.isVisible().catch(() => false))) {
      // The persisted-store hydration effect can finish just after the first
      // click; retry only while the chooser is still present.
      const chooser = page.getByRole("button", { name: mode }).first();
      if (await chooser.isVisible().catch(() => false)) await chooser.click();
    }
    const entryId = page.getByLabel(/enter fpl id/i);
    if (await entryId.isVisible().catch(() => false)) {
      await entryId.fill("4827193");
      await clickButton(page, /import team/i);
    }
  }

  test("imports an official FPL team by ID", async ({ page }) => {
    let importRequests = 0;
    page.on("request", (request) => { if (request.url().includes("/api/fpl/entry/")) importRequests += 1; });
    await clickButton(page, /analyze (?:a )?team/i);
    const input = page.getByLabel(/enter fpl id/i);
    await expect(input).toBeVisible();
    await input.fill("4827193");
    await clickButton(page, /import team/i);
    await waitForMarket(page);
    const squad = page.getByRole("region", { name: /squad builder and analysis/i });
    await expect(squad).toContainText(/15\/15 selected/i);
    await expect(squad.getByTestId("squad-roster")).toContainText(/Haaland/i);
    await expect(squad.getByRole("article").filter({ hasText: "Haaland" }).getByRole("button", { name: /make haaland captain/i })).toHaveAttribute("aria-pressed", "true");
    await expect(squad.getByRole("article").filter({ hasText: "Watkins" }).getByRole("button", { name: /make watkins vice-captain/i })).toHaveAttribute("aria-pressed", "true");
    const bench = squad.getByRole("region", { name: /^bench$/i });
    const metrics = squad.getByLabel("Squad projection metrics");
    await expect(metrics).toContainText(/TEAM RATING/i);
    await expect(metrics).not.toContainText(/5GW/i);
    await expect(metrics.getByText(/^\d+%$/)).toBeVisible();
    await expect(bench.getByRole("article").nth(0)).toContainText(/Areola/i);
    await expect(bench.getByRole("article").nth(1)).toContainText(/Faes/i);
    await expect(bench.getByRole("article").nth(2)).toContainText(/Konsa/i);
    await expect(bench.getByRole("article").nth(3)).toContainText(/Solanke/i);
    await expect(page.getByText(/imported test xi/i)).toBeVisible();
    await expect.poll(() => importRequests).toBe(1);
    await page.reload();
    await waitForMarket(page);
    expect(importRequests).toBe(1);
    await expect(page.getByLabel(/enter fpl id/i)).toHaveCount(0);
  });

  test("builds and completes a legal squad while preserving locked premiums", async ({ page }) => {
    await chooseMode(page, /build from scratch/i);
    await waitForMarket(page);

    for (const name of ["Haaland", "Saka", "Palmer"]) {
      await addPlayer(page, name);
      await lockPlayer(page, name);
    }

    await clickButton(page, /complete squad/i);

    await expect(page.getByText(/15\s*(?:players|\/\s*15)|squad complete|legal/i).first()).toBeVisible();
    for (const name of ["Haaland", "Saka", "Palmer"]) {
      await expect(page.getByText(new RegExp(`\\b${name}\\b`, "i")).first()).toBeVisible();
      const card = page.getByRole("article").filter({ hasText: name }).first();
      await card.hover();
      await expect(card.getByRole("button", { name: new RegExp(`Unlock ${name}`, "i") })).toBeVisible();
      await expect(card.getByRole("button", { name: new RegExp(`Remove ${name}`, "i") })).toHaveCount(0);
    }
    await expect(page.getByText(/£?100(?:\.0)?m|budget|bank|remaining/i).first()).toBeVisible();
  });

  test("imports an existing squad, inspects replacements, simulates, and applies a move", async ({ page }) => {
    await chooseMode(page, /analyze (?:a )?team/i);
    await waitForMarket(page);

    await expect(page.getByRole("region", { name: /weakest links/i })).toHaveCount(0);
    const replacements = page.getByRole("region", { name: /^transfer suggestions$/i });
    await expect(replacements).toBeVisible();
    await expect(replacements).toContainText(/EXACT/i);
    await expect(replacements).toContainText(/Rice\s*→\s*Saka/i);

    await clickButton(page, /^PICK TEAM$/i);
    await expect(page.getByText(/team picked and saved/i)).toBeVisible();

    await replacements.getByRole("button", { name: /simulate/i }).first().click();
    await expect(page.getByText(/simulation|before|after|price effect|gw effect/i).first()).toBeVisible();
    await clickButton(page, /apply/i);
    await expect(page.getByText(/applied|updated|total cost|projected/i).first()).toBeVisible();
    const squadPanel = page.getByRole("region", { name: /squad builder and analysis/i });
    await expect(squadPanel.getByRole("button", { name: /pick team · outdated/i })).toBeVisible();
    await expect(squadPanel.getByTestId("squad-roster")).toContainText(/Saka/i);
    await expect(squadPanel.getByTestId("squad-roster")).not.toContainText(/Rice/i);

    await page.reload();
    await waitForMarket(page);
    await expect(page.getByRole("region", { name: /squad builder and analysis/i }).getByTestId("squad-roster")).toContainText(/Saka/i);
  });

  test("searches the chosen transfer horizon and remembers it", async ({ page }) => {
    const horizons: number[] = [];
    page.on("request", (request) => {
      if (!request.url().includes("/api/transfer-suggestions") || request.method() !== "POST") return;
      horizons.push(JSON.parse(request.postData() ?? "{}").horizon);
    });
    await chooseMode(page, /analyze (?:a )?team/i);
    await waitForMarket(page);

    const replacements = page.getByRole("region", { name: /^transfer suggestions$/i });
    const toggles = replacements.getByRole("group", { name: /transfer suggestion horizon/i });
    await expect(toggles).toBeVisible();
    for (const label of ["GW", "3GW", "5GW", "10GW"]) {
      await expect(toggles.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await expect(toggles.getByRole("button", { name: "5GW", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => horizons).toEqual([5]);

    await toggles.getByRole("button", { name: "10GW", exact: true }).click();
    await expect(toggles.getByRole("button", { name: "10GW", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => horizons).toEqual([5, 10]);

    await toggles.getByRole("button", { name: "GW", exact: true }).click();
    await expect.poll(() => horizons).toEqual([5, 10, 1]);

    await page.reload();
    await waitForMarket(page);
    const reloaded = page.getByRole("region", { name: /^transfer suggestions$/i }).getByRole("group", { name: /transfer suggestion horizon/i });
    await expect(reloaded.getByRole("button", { name: "GW", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => horizons.at(-1)).toBe(1);
  });

  test("keeps the transfer horizon toggles on-screen on a phone", async ({ page }) => {
    await chooseMode(page, /analyze (?:a )?team/i);
    await waitForMarket(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const toggles = page.getByRole("region", { name: /^transfer suggestions$/i }).getByRole("group", { name: /transfer suggestion horizon/i });
    await expect(toggles).toBeVisible();
    const box = await toggles.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await expect(toggles.getByRole("button", { name: "10GW", exact: true })).toBeVisible();
  });

  test("dismisses a transfer suggestion across reloads", async ({ page }) => {
    let suggestionRequests = 0;
    page.on("request", (request) => { if (request.url().includes("/api/transfer-suggestions")) suggestionRequests += 1; });
    await chooseMode(page, /analyze (?:a )?team/i);
    await waitForMarket(page);
    const replacements = page.getByRole("region", { name: /^transfer suggestions$/i });
    const dismiss = replacements.getByRole("button", { name: /dismiss rice to saka suggestion/i });
    await expect(dismiss).toBeVisible();
    await expect.poll(() => suggestionRequests).toBe(1);
    await dismiss.click();
    await expect(replacements).not.toContainText(/Rice\s*→\s*Saka/i);
    await page.waitForTimeout(250);
    expect(suggestionRequests).toBe(1);

    await page.reload();
    await waitForMarket(page);
    await expect(page.getByRole("region", { name: /^transfer suggestions$/i })).not.toContainText(/Rice\s*→\s*Saka/i);
  });

  test("keeps the quantitative workspace usable without the AI analyst", async ({ page }) => {
    await chooseMode(page, /build from scratch/i);
    await waitForMarket(page);

    await expect(page.getByText(/projection|xpts|expected points|data/i).first()).toBeVisible();
    await expect(page.getByRole("region", { name: /ai analyst/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^ai$/i })).toHaveCount(0);
  });

  test("shows recent matches, dense season stats, previous years, and compact projections in player details", async ({ page }) => {
    await chooseMode(page, /build from scratch/i);
    await waitForMarket(page);
    await page.getByRole("button", { name: /haaland/i }).first().click();

    const detail = page.getByRole("dialog", { name: /haaland/i });
    const universe = page.getByRole("region", { name: /player universe/i });
    await expect(detail.getByRole("heading", { name: /recent matches/i })).toBeVisible();
    const recentMatch = detail.getByLabel(/gameweek 6.*17 points/i);
    await expect(recentMatch).toBeVisible();
    await recentMatch.click();
    await expect(recentMatch.locator("..").getByText("58", { exact: true })).toBeVisible();
    await expect(detail.getByRole("heading", { name: /current season output/i })).toBeVisible();
    await expect(detail.getByText("Starts", { exact: true }).first()).toBeInViewport();
    const advancedStats = detail.locator("details.advanced-stat-disclosure");
    await expect(advancedStats).not.toHaveAttribute("open", "");
    await advancedStats.locator("summary").click();
    await expect(advancedStats).toHaveAttribute("open", "");
    await expect(advancedStats.getByText("Influence", { exact: true })).toBeVisible();
    await expect(detail.getByText("5GW xP", { exact: true })).toBeVisible();
    await expect(detail.getByRole("heading", { name: /previous seasons/i })).toBeVisible();
    await expect(detail.getByRole("row", { name: /2025\/26/i })).toBeVisible();
    await expect(detail).not.toContainText(/evidence|rotowire predicted starter/i);
    await expect(page.getByRole("region", { name: /squad builder and analysis/i })).toBeVisible();
    const [detailBox, universeBox] = await Promise.all([detail.boundingBox(), universe.boundingBox()]);
    expect(detailBox).not.toBeNull();
    expect(universeBox).not.toBeNull();
    expect(detailBox!.width).toBeLessThanOrEqual(universeBox!.width + 1);
    expect(detailBox!.height).toBeLessThanOrEqual(universeBox!.height + 1);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detail).toBeVisible();
  });

  test("keeps the player universe dense and gives each desktop panel an accessible minimize control", async ({ page }) => {
    await chooseMode(page, /build from scratch/i);
    await waitForMarket(page);

    const universe = page.getByRole("region", { name: /player universe/i }).first();
    await expect(universe).toBeVisible();
    const headers = () => universe.getByRole("columnheader").allTextContents().then((texts) => texts.join(" ").replace(/\s+/g, " "));
    for (const label of [/own(?:ership)?%?/i, /form/i, /(?:gw\s*xp|xp\s*gw)/i, /(?:5gw|5\s*gw|xp\s*5)/i, /xp\s*\/\s*£/i, /fixtures/i]) {
      expect(await headers(), `player universe should expose ${label}`).toMatch(label);
    }

    // Secondary metric columns yield to panel width and return on wide screens.
    await page.setViewportSize({ width: 1728, height: 1000 });
    await expect(universe).toBeVisible();
    for (const label of [/(?:exp|expected)\s*min/i, /xgi\s*\/?\s*90/i, /risk/i]) {
      expect(await headers(), `player universe should expose ${label} on wide panels`).toMatch(label);
    }

    for (const name of [/player universe/i, /squad builder and analysis/i]) {
      const panel = page.getByRole("region", { name }).first();
      await expect(panel, `${name} should be a visible desktop panel`).toBeVisible();
      const toggle = panel.getByRole("button", { name: /minimize|collapse/i });
      await expect(toggle, `${name} should expose one accessible minimize toggle`).toHaveCount(1);
      await expect(toggle).toBeVisible();
    }
  });

  test("keeps every roster card visible in the unified desktop panel", async ({ page }) => {
    await chooseMode(page, /analyze (?:a )?team/i);
    await waitForMarket(page);
    await expect(page.getByText(/15\s*\/\s*15 selected/i)).toBeVisible();

    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
      { width: 1728, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      const panel = page.getByRole("region", { name: /squad builder and analysis/i });
      const roster = panel.getByTestId("squad-roster");
      const cards = roster.getByRole("article");
      await expect(cards).toHaveCount(15);
      await expect(cards.last()).toBeVisible();

      const layout = await panel.evaluate((element) => {
        const rosterElement = element.querySelector<HTMLElement>('[data-testid="squad-roster"]')!;
        const panelRect = element.getBoundingClientRect();
        const cardRects = [...rosterElement.querySelectorAll<HTMLElement>('article')].map((card) => card.getBoundingClientRect());
        return {
          panelOverflowY: getComputedStyle(element).overflowY,
          rosterOverflowY: getComputedStyle(rosterElement).overflowY,
          rosterScrolls: rosterElement.scrollHeight > rosterElement.clientHeight + 1,
          cardsInsidePanel: cardRects.every((card) => card.top >= panelRect.top && card.bottom <= panelRect.bottom),
        };
      });
      expect(layout).toEqual({ panelOverflowY: "hidden", rosterOverflowY: "visible", rosterScrolls: false, cardsInsidePanel: true });
    }

    const panel = page.getByRole("region", { name: /squad builder and analysis/i });
    await expect(panel.getByText(/feasibility|minutes security|market opportunities|live universe: 600 players/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^GW TEAM$|^ANALYSIS$/i })).toHaveCount(0);
  });

  test("moves optimizer strategy controls into Settings", async ({ page }) => {
    await chooseMode(page, /build from scratch/i);
    await waitForMarket(page);
    const panel = page.getByRole("region", { name: /squad builder and analysis/i });
    const settings = panel.getByText(/^SETTINGS$/i);
    await settings.focus();
    await settings.press("Enter");
    const popover = panel.locator(".strategy-popover");
    await expect(popover.getByText(/optimizer settings/i)).toBeVisible();
    await expect(popover.getByText(/^HORIZON$/i)).toBeVisible();
    const tenGameweek = popover.getByRole("button", { name: "10GW", exact: true });
    await expect(tenGameweek).toBeVisible();
    await expect(popover.getByText(/^RISK$/i)).toBeVisible();
    await expect(popover.getByText(/^BENCH$/i)).toBeVisible();
  });

  test("minimizes and restores Player Universe, then resizes it by dragging", async ({ page }) => {
    await chooseMode(page, /build from scratch/i);
    await waitForMarket(page);

    const universe = page.getByRole("region", { name: /player universe/i }).first();
    const toggle = universe.getByRole("button", { name: /minimize|collapse/i }).first();
    const expandedBox = await universe.boundingBox();
    expect(expandedBox?.width, "expanded Player Universe should have a rendered width").toBeGreaterThan(100);

    await toggle.click();
    const restore = universe.getByRole("button", { name: /restore|expand|open/i }).first();
    await expect(restore, "minimized Player Universe should expose a restore control").toBeVisible();
    const collapsedBox = await universe.boundingBox();
    expect(collapsedBox?.width).toBeLessThan(expandedBox?.width ?? Number.POSITIVE_INFINITY);

    await restore.click();
    await expect(universe.getByRole("button", { name: /minimize|collapse/i }).first()).toBeVisible();
    const restoredBox = await universe.boundingBox();
    expect(restoredBox?.width).toBeGreaterThan(collapsedBox?.width ?? 0);

    const resizeHandle = universe.getByRole("separator", { name: /resize/i }).first();
    await expect(resizeHandle, "Player Universe should expose a labelled vertical resize handle").toBeVisible();
    const handleBox = await resizeHandle.boundingBox();
    const beforeResize = await universe.boundingBox();
    expect(handleBox).not.toBeNull();
    expect(beforeResize).not.toBeNull();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 72, handleBox!.y + handleBox!.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await universe.boundingBox())?.width ?? 0).toBeGreaterThan((beforeResize?.width ?? 0) + 20);
  });
});
