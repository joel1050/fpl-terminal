import { expect, type Page, test } from "@playwright/test";
import { fixtureSquadNames } from "../fixtures/fpl";
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
  }

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

  test("pastes an existing squad, inspects replacements, simulates, and applies a move", async ({ page }) => {
    await chooseMode(page, /analyze (?:a )?team/i);
    await waitForMarket(page);

    const paste = page.locator("textarea").first();
    await expect(paste, "existing-team paste control should be a textarea").toBeVisible();
    await paste.fill(fixtureSquadNames.join("\n"));
    await clickButton(page, /(?:analyze|import|run).*squad|analyze team|resolve names/i);

    await expect(page.getByRole("region", { name: /weakest links/i })).toHaveCount(0);
    const replacements = page.getByRole("region", { name: /^transfer suggestions$/i });
    await expect(replacements).toBeVisible();
    await expect(replacements).toContainText(/EXACT/i);
    await expect(replacements).toContainText(/Faes\s*→\s*Smith/i);

    await clickButton(page, /^PICK TEAM$/i);
    await expect(page.getByText(/team picked and saved/i)).toBeVisible();

    await replacements.getByRole("button", { name: /simulate/i }).first().click();
    await expect(page.getByText(/simulation|before|after|price effect|gw effect/i).first()).toBeVisible();
    await clickButton(page, /apply/i);
    await expect(page.getByText(/applied|updated|total cost|projected/i).first()).toBeVisible();
    const squadPanel = page.getByRole("region", { name: /squad builder and analysis/i });
    await expect(squadPanel.getByRole("button", { name: /pick team · outdated/i })).toBeVisible();
    await expect(squadPanel.getByTestId("squad-roster")).toContainText(/Smith/i);
    await expect(squadPanel.getByTestId("squad-roster")).not.toContainText(/Faes/i);

    await page.reload();
    await chooseMode(page, /analyze (?:a )?team/i);
    await waitForMarket(page);
    await expect(page.getByRole("region", { name: /squad builder and analysis/i }).getByTestId("squad-roster")).toContainText(/Smith/i);
  });

  test("keeps the quantitative workspace usable and explains AI offline mode", async ({ page }) => {
    await chooseMode(page, /build from scratch/i);
    await waitForMarket(page);

    await expect(page.getByText(/projection|xpts|expected points|data/i).first()).toBeVisible();
    const aiInput = page.getByPlaceholder(/ask about this squad/i);
    await expect(aiInput).toBeVisible();
    await aiInput.fill("What should I change first?");
    await clickButton(page, /send analyst query/i);
    await expect(page.getByText(/ai analyst is offline|deepseek_api_key|configuration.*missing|analyst.*offline/i).last()).toBeVisible();
  });

  test("shows selection rating, probabilities, evidence, and update time in player details", async ({ page }) => {
    await chooseMode(page, /build from scratch/i);
    await waitForMarket(page);
    await page.getByRole("button", { name: /haaland/i }).first().click();

    const detail = page.getByRole("complementary", { name: /haaland detail/i });
    await expect(detail.getByText("STARTING STATUS")).toBeVisible();
    await expect(detail.getByText("NAILED 1–5")).toBeVisible();
    await expect(detail.getByText("88%")).toBeVisible();
    await expect(detail.getByText("RotoWire predicted starter")).toBeVisible();
    await expect(detail.getByText(/Aug 20/i)).toBeVisible();
  });

  test("keeps the player universe dense and gives each desktop panel an accessible minimize control", async ({ page }) => {
    await chooseMode(page, /build from scratch/i);
    await waitForMarket(page);

    const universe = page.getByRole("region", { name: /player universe/i }).first();
    await expect(universe).toBeVisible();
    const headers = () => universe.getByRole("columnheader").allTextContents().then((texts) => texts.join(" ").replace(/\s+/g, " "));
    for (const label of [/own(?:ership)?%?/i, /(?:gw\s*xp|xp\s*gw)/i, /(?:3gw|3\s*gw|xp\s*3)/i, /(?:5gw|5\s*gw|xp\s*5)/i, /xp\s*\/\s*£/i, /fixtures/i]) {
      expect(await headers(), `player universe should expose ${label}`).toMatch(label);
    }

    // Secondary metric columns yield to panel width and return on wide screens.
    await page.setViewportSize({ width: 1728, height: 1000 });
    await expect(universe).toBeVisible();
    for (const label of [/(?:exp|expected)\s*min/i, /xgi\s*\/?\s*90/i, /risk/i]) {
      expect(await headers(), `player universe should expose ${label} on wide panels`).toMatch(label);
    }

    for (const name of [/player universe/i, /squad builder and analysis/i, /ai analyst/i]) {
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
    const paste = page.getByRole("textbox", { name: /paste squad player names/i });
    await paste.fill(fixtureSquadNames.join("\n"));
    await clickButton(page, /resolve names/i);
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
