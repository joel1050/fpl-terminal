import { expect, type Locator, type Page, test } from "@playwright/test";
import { bootstrapStaticFixture } from "../fixtures/fpl";
import { interceptFplData } from "../fixtures/network";

/**
 * The import mode card, matched by its index rather than its wording, as in
 * the other acceptance specs.
 */
const IMPORT_MODE = /mode b/i;

/**
 * Import-a-team squad: Haaland captain, Watkins vice-captain, Faes and Konsa
 * on the bench. Pau (DEF) can swap with Faes (DEF) and keep the formation legal.
 */
test.describe("squad pitch", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("squad-pitch-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("squad-pitch-test", "ready");
      }
    });
    await interceptFplData(page);
    await page.goto("/");
  });

  async function importTeam(page: Page) {
    await page.getByRole("button", { name: IMPORT_MODE }).click();
    await page.getByLabel(/enter fpl id/i).fill("4827193");
    await page.getByRole("button", { name: /import team/i }).click();
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
  }

  function squadPanel(page: Page) {
    return page.getByRole("region", { name: /squad builder and analysis/i });
  }

  function token(page: Page, name: string) {
    return squadPanel(page).locator(`[data-testid="squad-token"][data-player="${name}"]`);
  }

  function viewSwitch(page: Page) {
    return squadPanel(page).getByRole("group", { name: "Squad view" });
  }

  function squadTable(page: Page) {
    return squadPanel(page).getByRole("table", { name: "Squad table" });
  }

  async function showTable(page: Page) {
    await viewSwitch(page).getByRole("button", { name: "Table", exact: true }).click();
    await expect(squadTable(page)).toBeVisible();
  }

  /** Escape first: an open sheet's backdrop would otherwise take the tap. */
  async function openActions(page: Page, name: string): Promise<Locator> {
    await page.keyboard.press("Escape");
    await token(page, name).click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  async function boxesOf(locator: Locator) {
    return Promise.all((await locator.all()).map((item) => item.boundingBox()));
  }

  test("keeps all 15 tokens inside a phone viewport above the tab bar, with no nested scroll", async ({ page }) => {
    await importTeam(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const tokens = squadPanel(page).getByTestId("squad-token");
    await expect(tokens).toHaveCount(15);
    for (const box of await boxesOf(tokens)) {
      expect(box, "every token has a box").not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(844 - 56);
    }
    await expect(token(page, "Haaland").getByTestId("token-role")).toHaveText("C");

    const nested = await squadPanel(page).evaluate((panel) => [...panel.querySelectorAll<HTMLElement>("*")]
      .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
      .map((el) => el.className));
    expect(nested).toEqual([]);
  });

  test("keeps the squad as one panel at 1280x720 with no overlapping tokens and no nested scroll", async ({ page }) => {
    await importTeam(page);
    await page.setViewportSize({ width: 1280, height: 720 });

    const tokens = squadPanel(page).getByTestId("squad-token");
    await expect(tokens).toHaveCount(15);
    const boxes = (await boxesOf(tokens)).map((box) => box!);
    for (let index = 0; index < boxes.length; index += 1) {
      for (let other = index + 1; other < boxes.length; other += 1) {
        const a = boxes[index];
        const b = boxes[other];
        const overlaps = Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
        expect(overlaps, `tokens ${index} and ${other} overlap`).toBe(false);
      }
    }

    const nested = await squadPanel(page).evaluate((panel) => [...panel.querySelectorAll<HTMLElement>("*")]
      .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
      .map((el) => el.className));
    expect(nested).toEqual([]);
  });

  test("shows a fixture run strip on every token on desktop", async ({ page }) => {
    await importTeam(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    const tokens = squadPanel(page).getByTestId("squad-token");
    await expect(tokens).toHaveCount(15);
    await expect(squadPanel(page).getByTestId("squad-token").locator(".run")).toHaveCount(15);
  });

  test("opens an action sheet from a token, sets the captain, and keeps it after a reload", async ({ page }) => {
    await importTeam(page);

    const dialog = await openActions(page, "Mbeumo");
    await dialog.getByRole("button", { name: "Make Mbeumo captain" }).click();
    await expect(dialog.getByRole("button", { name: "Make Mbeumo captain" })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(token(page, "Mbeumo").getByTestId("token-role")).toHaveText("C");
    await expect(token(page, "Haaland").getByTestId("token-role")).toHaveCount(0);

    await page.reload();
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    await expect(token(page, "Mbeumo").getByTestId("token-role")).toHaveText("C");
  });

  test("swaps a starter with a bench player through two action sheets", async ({ page }) => {
    await importTeam(page);

    const starter = await openActions(page, "Pau");
    await starter.getByRole("button", { name: "Select Pau to move to bench" }).click();
    await expect(starter).toBeHidden();
    await expect(page.getByText(/tap a bench player to swap with pau/i)).toBeVisible();

    const bench = await openActions(page, "Faes");
    await bench.getByRole("button", { name: "Select Faes to move into the starting XI" }).click();
    await expect(bench).toBeHidden();
    await expect(page.getByRole("region", { name: /^starting xi$/i }).locator('[data-testid="squad-token"][data-player="Faes"]')).toHaveCount(1);
    await expect(page.getByRole("region", { name: /^starting xi$/i }).locator('[data-testid="squad-token"][data-player="Pau"]')).toHaveCount(0);
    await expect(page.getByText(/tap a bench player to swap with pau/i)).toHaveCount(0);
  });

  test("Escape closes the sheet and returns focus to its token", async ({ page }) => {
    await importTeam(page);

    const dialog = await openActions(page, "Gordon");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(token(page, "Gordon")).toBeFocused();
  });

  test("an outside tap closes the sheet", async ({ page }) => {
    await importTeam(page);

    const dialog = await openActions(page, "Gordon");
    await page.mouse.click(4, 4);
    await expect(dialog).toBeHidden();
  });

  test("a locked player's Remove is disabled until the lock is released", async ({ page }) => {
    await importTeam(page);

    // An imported squad is locked by the store (replaceSquad), so Remove starts disabled.
    const dialog = await openActions(page, "Gordon");
    await expect(dialog.getByRole("button", { name: "Unlock Gordon" })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: "Remove Gordon" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Unlock Gordon" }).click();
    await expect(dialog.getByRole("button", { name: "Lock Gordon" })).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.getByRole("button", { name: "Remove Gordon" })).toBeEnabled();
  });

  test("a draft squad shows an empty slot after a removal and does not crash", async ({ page }) => {
    await importTeam(page);

    const dialog = await openActions(page, "Rogers");
    await dialog.getByRole("button", { name: "Unlock Rogers" }).click();
    await dialog.getByRole("button", { name: "Remove Rogers" }).click();
    await expect(squadPanel(page).getByText(/14\s*\/\s*15 selected/i).first()).toBeVisible();
    await expect(squadPanel(page).getByTestId("squad-token")).toHaveCount(14);
    await expect(squadPanel(page).getByRole("button", { name: /^open /i }).first()).toBeVisible();
  });

  test("flags an unavailable player with a red mark and a doubtful one with an orange mark", async ({ page }) => {
    await page.route("**/api/fpl/bootstrap*", async (route) => {
      const players = bootstrapStaticFixture.players.map((player) => {
        if (player.displayName === "Gordon") return { ...player, status: "i" };
        if (player.displayName === "Rogers") return { ...player, chance_of_playing_next_round: 50 };
        return player;
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...bootstrapStaticFixture, players }) });
    });
    await page.reload();
    await importTeam(page);

    await expect(token(page, "Gordon").getByTestId("token-flag")).toHaveAttribute("data-availability", "UNAVAILABLE");
    await expect(token(page, "Rogers").getByTestId("token-flag")).toHaveAttribute("data-availability", "DOUBTFUL");
    await expect(token(page, "Pau").getByTestId("token-flag")).toHaveCount(0);
  });

  test("the Pitch/Table switch flips views, and the table has 15 player rows under a Bench divider", async ({ page }) => {
    await importTeam(page);
    const pitchButton = viewSwitch(page).getByRole("button", { name: "Pitch", exact: true });
    await expect(pitchButton).toHaveAttribute("aria-pressed", "true");
    await expect(squadPanel(page).getByTestId("squad-token")).toHaveCount(15);

    await showTable(page);
    await expect(viewSwitch(page).getByRole("button", { name: "Table", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(pitchButton).toHaveAttribute("aria-pressed", "false");
    await expect(squadPanel(page).getByTestId("squad-token")).toHaveCount(0);
    await expect(squadTable(page).locator("tbody tr[data-player]")).toHaveCount(15);
    await expect(squadTable(page).locator("tbody tr")).toHaveCount(16);
    await expect(squadTable(page).getByText("Bench", { exact: true })).toHaveCount(1);

    await pitchButton.click();
    await expect(pitchButton).toHaveAttribute("aria-pressed", "true");
    await expect(squadPanel(page).getByTestId("squad-token")).toHaveCount(15);
    await expect(squadTable(page)).toHaveCount(0);
  });

  test("the table choice survives a reload", async ({ page }) => {
    await importTeam(page);
    await showTable(page);

    await page.reload();
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    await expect(viewSwitch(page).getByRole("button", { name: "Table", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(squadTable(page)).toBeVisible();
  });

  test("a table row opens the same action sheet as a token, and a captain set there shows in the table", async ({ page }) => {
    await importTeam(page);
    await showTable(page);

    await squadTable(page).getByRole("button", { name: /^Mbeumo,/ }).click();
    const dialog = page.getByRole("dialog", { name: "Mbeumo", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Make Mbeumo captain" }).click();
    await page.keyboard.press("Escape");
    await expect(squadTable(page).locator('tr[data-player="Mbeumo"]').getByTestId("table-role")).toHaveText("C");
    await expect(squadTable(page).locator('tr[data-player="Haaland"]').getByTestId("table-role")).toHaveCount(0);
  });

  test("the swap hint shows above the table in Table view", async ({ page }) => {
    await importTeam(page);
    await showTable(page);

    const starter = page.getByRole("dialog", { name: "Pau", exact: true });
    await squadTable(page).getByRole("button", { name: /^Pau,/ }).click();
    await expect(starter).toBeVisible();
    await starter.getByRole("button", { name: "Select Pau to move to bench" }).click();
    await expect(page.getByText(/tap a bench player to swap with pau/i)).toBeVisible();

    const bench = page.getByRole("dialog", { name: "Faes", exact: true });
    await squadTable(page).getByRole("button", { name: /^Faes,/ }).click();
    await bench.getByRole("button", { name: "Select Faes to move into the starting XI" }).click();
    await expect(bench).toBeHidden();
    await expect(page.getByText(/tap a bench player to swap with pau/i)).toHaveCount(0);
  });

  test("on a phone the table fits the panel with no horizontal overflow, and keeps Pos, Player, Next, GW and Start", async ({ page }) => {
    await importTeam(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await showTable(page);

    const table = squadTable(page);
    for (const name of ["Pos", "Player", "Next", "GW", "Start"]) {
      await expect(table.getByRole("columnheader", { name, exact: true })).toBeVisible();
    }
    for (const name of ["£m", "3GW", "5GW", "Form", "Run"]) {
      await expect(table.getByRole("columnheader", { name, exact: true })).toBeHidden();
    }
    const overflow = await squadPanel(page).evaluate((panel) => ({ panel: panel.scrollWidth - panel.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    expect(overflow).toEqual({ panel: 0, page: 0 });

    for (const box of await boxesOf(table.locator("tbody tr[data-player] button"))) {
      expect(box, "every table row has a box").not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(40);
    }
  });

  test("on desktop the table shows all ten columns, with headers at least 11.5px", async ({ page }) => {
    await importTeam(page);
    // 1920 wide: at 1440 the decision rail sits beside the squad, which leaves too little width for Form and Run (see decision-rail.spec.ts).
    await page.setViewportSize({ width: 1920, height: 1080 });
    await showTable(page);

    const table = squadTable(page);
    for (const name of ["Pos", "Player", "£m", "Next", "GW", "3GW", "5GW", "Start", "Form", "Run"]) {
      await expect(table.getByRole("columnheader", { name, exact: true })).toBeVisible();
    }
    const sizes = await table.locator("thead th").evaluateAll((cells) => cells.map((cell) => parseFloat(getComputedStyle(cell).fontSize)));
    expect(sizes.length).toBe(10);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(11.5);
  });

  test("a draft squad renders the table without the removed player and without crashing", async ({ page }) => {
    await importTeam(page);

    const dialog = await openActions(page, "Rogers");
    await dialog.getByRole("button", { name: "Unlock Rogers" }).click();
    await dialog.getByRole("button", { name: "Remove Rogers" }).click();
    await showTable(page);

    await expect(squadTable(page).locator("tbody tr[data-player]")).toHaveCount(14);
    await expect(squadTable(page).locator('tr[data-player="Rogers"]')).toHaveCount(0);
  });
});
