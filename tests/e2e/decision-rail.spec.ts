import { expect, type Locator, type Page, test } from "@playwright/test";
import { bootstrapStaticFixture } from "../fixtures/fpl";
import { interceptFplData } from "../fixtures/network";

const IMPORT_MODE = /mode b/i;
const FAES = 17; // Imported bench: BGK Areola, then Faes, Konsa and Solanke.

type Box = { x: number; y: number; width: number; height: number };

function squadPanel(page: Page) {
  return page.getByRole("region", { name: /squad builder and analysis/i });
}

function rail(page: Page) {
  return page.getByRole("complementary", { name: "Decision rail" });
}

/** The squad column's scroll container: the nearest ancestor of the squad region that scrolls on Y. It is the root when none does. */
async function squadColumn(page: Page) {
  return squadPanel(page).evaluateHandle((panel) => {
    let el: Element = panel;
    while (el.parentElement && !["auto", "scroll"].includes(getComputedStyle(el).overflowY)) el = el.parentElement;
    return el as HTMLElement;
  });
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("expected a rendered box");
  return box;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function importTeam(page: Page) {
  await page.getByRole("button", { name: IMPORT_MODE }).click();
  await page.getByLabel(/enter fpl id/i).fill("4827193");
  await page.getByRole("button", { name: /import team/i }).click();
  // The squad count shows on both layouts; a phone opens on the Squad tab, so the Players search is hidden there.
  await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
}

/** Serves the shared bootstrap with one edited player. The copy keeps the imported fixture unchanged. */
async function serveBootstrap(page: Page, edit: (players: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) {
  const body = structuredClone(bootstrapStaticFixture) as unknown as { players: Array<Record<string, unknown>> };
  body.players = edit(body.players);
  await page.route("**/api/fpl/bootstrap*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

test.describe("decision rail", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("decision-rail-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("decision-rail-test", "ready");
      }
    });
    await interceptFplData(page);
  });

  test("at 1440 the rail stands beside the squad with its four sections", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await importTeam(page);

    const railBox = await boxOf(rail(page));
    const squadBox = await boxOf(squadPanel(page));
    expect(railBox.x, "rail starts right of the squad").toBeGreaterThanOrEqual(squadBox.x + squadBox.width - 1);
    expect(overlaps(railBox, squadBox), "rail and squad do not overlap").toBe(false);

    await expect(rail(page).getByRole("heading", { name: "Captain" })).toBeVisible();
    await expect(rail(page).getByRole("heading", { name: "Needs a look" })).toBeVisible();
    await expect(rail(page).getByRole("region", { name: /^transfer suggestions$/i })).toBeVisible();
    await expect(rail(page).getByRole("group", { name: /select chip for this gameweek/i })).toBeVisible();
    await expect(rail(page).getByRole("heading", { name: "Chips" })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no sideways scroll at 1440").toBeLessThanOrEqual(1);
  });

  test("at 1280x720 the rail sits under the bench and no two panels overlap", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await importTeam(page);

    const bench = await boxOf(squadPanel(page).getByRole("region", { name: /^bench$/i }));
    const railBox = await boxOf(rail(page));
    const marketBox = await boxOf(page.getByRole("region", { name: /player universe/i }));
    const squadBox = await boxOf(squadPanel(page));
    expect(railBox.y, "rail starts below the bench").toBeGreaterThanOrEqual(bench.y + bench.height - 1);
    expect(overlaps(marketBox, squadBox), "players and squad").toBe(false);
    expect(overlaps(marketBox, railBox), "players and rail").toBe(false);
    expect(overlaps(squadBox, railBox), "squad and rail").toBe(false);

    // Nothing inside the rail gets its own scroll area.
    const nested = await rail(page).evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>("*")).filter((el) => {
      const overflow = getComputedStyle(el).overflowY;
      return (overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight + 1;
    }).map((el) => el.className));
    expect(nested).toEqual([]);
  });

  test("at 1280x720 the rail can be scrolled into view", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await importTeam(page);

    const chips = rail(page).getByRole("heading", { name: "Chips" });
    await chips.scrollIntoViewIfNeeded();
    const box = await boxOf(chips);
    expect(box.y, "Chips heading starts inside the viewport").toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, "Chips heading ends inside the viewport").toBeLessThanOrEqual(720);
  });

  for (const size of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
    test(`at ${size.width}x${size.height} the page itself does not scroll`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto("/");
      await importTeam(page);

      const { scrollHeight, innerHeight } = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight }));
      expect(scrollHeight, "document height fits the viewport").toBeLessThanOrEqual(innerHeight + 1);
    });
  }

  test("at 1280x720 the squad column is one scroll container that holds the rail", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await importTeam(page);

    const column = await squadColumn(page);
    expect(await column.evaluate((el) => getComputedStyle(el).overflowY), "the squad column scrolls on its own").toMatch(/^(auto|scroll)$/);
    expect(await column.evaluate((el) => el.querySelector('aside[aria-label="Decision rail"]') !== null), "the rail is inside the squad column").toBe(true);

    await column.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(rail(page).getByRole("heading", { name: "Chips" }), "Chips heading scrolls into view").toBeInViewport();
    expect(await page.evaluate(() => window.scrollY), "the page itself stays at the top").toBe(0);
  });

  test("at 1280x720 nothing else in the squad column scrolls on its own", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await importTeam(page);

    const column = await squadColumn(page);
    expect(await column.evaluate((el) => getComputedStyle(el).overflowY), "the squad column scrolls on its own").toMatch(/^(auto|scroll)$/);
    const nested = await column.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>("*")).filter((node) => {
      const overflow = getComputedStyle(node).overflowY;
      return (overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 1;
    }).map((node) => node.className));
    expect(nested).toEqual([]);
  });

  test("at 1280x720 the players table body scrolls under its sticky header", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await importTeam(page);

    const market = page.getByRole("region", { name: /player universe/i });
    const wrap = market.locator(".table-wrap");
    const head = wrap.locator("thead th").first();
    expect(await wrap.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
    expect(await wrap.evaluate((el) => el.scrollHeight > el.clientHeight + 1), "the table has rows beyond its height").toBe(true);

    await wrap.evaluate((el) => { el.scrollTop = 200; });
    expect(await wrap.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const wrapBox = await boxOf(wrap);
    const headBox = await boxOf(head);
    expect(Math.abs(headBox.y - wrapBox.y), "the header stays at the top of the body").toBeLessThanOrEqual(1);

    const marketBox = await boxOf(market);
    expect(wrapBox.y + wrapBox.height, "the table ends inside the players column").toBeLessThanOrEqual(marketBox.y + marketBox.height + 1);
    expect(wrapBox.y + wrapBox.height, "the table ends inside the viewport").toBeLessThanOrEqual(720 + 1);
  });

  test("at 1440 with saved panel ratios the rail stays inside the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await importTeam(page);
    await page.evaluate(() => {
      const raw = window.localStorage.getItem("fpl-terminal-state");
      if (!raw) throw new Error("missing persisted state");
      const state = JSON.parse(raw);
      state.panelRatios = { market: 30, squad: 70 };
      window.localStorage.setItem("fpl-terminal-state", JSON.stringify(state));
    });
    await page.reload();
    await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();

    const railBox = await boxOf(rail(page));
    expect(railBox.x + railBox.width, "rail right edge").toBeLessThanOrEqual(1440 + 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("a doubtful bench player is flagged under Needs a look and opens the player's action sheet", async ({ page }) => {
    await serveBootstrap(page, (players) => players.map((player) => (player.id === FAES
      ? { ...player, status: "d", chance_of_playing_next_round: 50 }
      : player)));
    await page.goto("/");
    await importTeam(page);

    // Precondition: the fixture edit reached the squad, so a failure below is about the rail.
    const token = squadPanel(page).locator('[data-testid="squad-token"][data-player="Faes"]');
    await expect(token.locator('[data-testid="token-flag"]')).toHaveAttribute("data-availability", "DOUBTFUL");

    const alert = rail(page).getByRole("button", { name: /^Faes doubtful/ });
    await expect(alert).toBeVisible();
    await alert.click();
    await expect(page.getByRole("dialog", { name: "Faes", exact: true })).toBeVisible();
  });

  test("a captain row opens that player's sheet, where the armband moves", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await importTeam(page);

    const row = rail(page).locator(".captain-row:not(.is-captain)").first();
    const name = await row.locator(".captain-name").evaluate((el) => el.firstChild?.textContent?.trim() ?? "");
    expect(name).not.toBe("");
    await row.click();

    const sheet = page.getByRole("dialog", { name, exact: true });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: `Make ${name} captain` }).click();
    await expect(rail(page).locator(".captain-row.is-captain")).toContainText(name);
  });

  test("Change opens the sheet of the current captain", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await importTeam(page);

    const captain = await rail(page).locator(".captain-row.is-captain .captain-name").evaluate((el) => el.firstChild?.textContent?.trim() ?? "");
    expect(captain).not.toBe("");
    await rail(page).getByRole("button", { name: "Change captain" }).click();
    await expect(page.getByRole("dialog", { name: captain, exact: true })).toBeVisible();
  });

  test("a used chip shows Used GW n as visible text and stays disabled", async ({ page }) => {
    await page.goto("/");
    await importTeam(page);
    await expect.poll(() => page.evaluate(() => {
      const state = JSON.parse(window.localStorage.getItem("fpl-terminal-state") ?? "null");
      return state?.gameweekPlans?.["1"]?.playerIds?.length;
    })).toBe(15);
    await page.evaluate(() => {
      const raw = window.localStorage.getItem("fpl-terminal-state");
      if (!raw) throw new Error("missing persisted state");
      const state = JSON.parse(raw);
      state.usedChips = [{ kind: "bboost", gameweek: 1 }];
      window.localStorage.setItem("fpl-terminal-state", JSON.stringify(state));
    });
    await page.reload();
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
    const planner = page.getByRole("group", { name: "Select planning Gameweek" });
    await planner.getByRole("button", { name: /next planning gameweek/i }).click();
    await expect(planner).toContainText("GW 2");

    const bb = rail(page).getByRole("group", { name: /select chip for this gameweek/i }).getByRole("button", { name: /^BB/ });
    await expect(bb).toBeDisabled();
    await expect(bb).toHaveAttribute("aria-pressed", "false");
    await expect(bb.getByText("Used GW 1", { exact: true })).toBeVisible();
  });

  test("the KPI strip sits above the Starting XI on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await importTeam(page);

    const kpis = await boxOf(squadPanel(page).getByRole("group", { name: "Squad projection metrics" }));
    const xi = await boxOf(squadPanel(page).getByRole("region", { name: "Starting XI" }));
    expect(kpis.y + kpis.height).toBeLessThanOrEqual(xi.y + 1);
  });

  test("on a phone the rail follows the squad on the Squad tab, in order, with no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await importTeam(page);

    const railBox = await boxOf(rail(page));
    const squadBox = await boxOf(squadPanel(page));
    expect(railBox.y, "rail sits below the squad").toBeGreaterThanOrEqual(squadBox.y + squadBox.height - 1);

    const tops = [
      await boxOf(rail(page).getByRole("heading", { name: "Captain" })),
      await boxOf(rail(page).getByRole("heading", { name: "Needs a look" })),
      await boxOf(rail(page).getByRole("region", { name: /^transfer suggestions$/i })),
      await boxOf(rail(page).getByRole("group", { name: /select chip for this gameweek/i })),
    ].map((box) => box.y);
    expect(tops, "Captain, Needs a look, Transfers, Chips").toEqual([...tops].sort((a, b) => a - b));

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    const small = await rail(page).locator("button").evaluateAll((buttons) => buttons
      .filter((button) => button.checkVisibility())
      .map((button) => ({ label: button.textContent?.trim().slice(0, 24) ?? "", height: button.getBoundingClientRect().height }))
      .filter((button) => button.height < 40));
    expect(small, "tap targets under 40px").toEqual([]);

    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Players" }).click();
    await expect(rail(page)).toBeHidden();
  });

  test("the table view fits the squad column beside the rail at 1440", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await importTeam(page);
    await squadPanel(page).getByRole("group", { name: "Squad view" }).getByRole("button", { name: "Table" }).click();

    const squad = await boxOf(squadPanel(page));
    const table = await boxOf(squadPanel(page).locator(".squad-table"));
    expect(table.x + table.width, "table fits the squad column").toBeLessThanOrEqual(squad.x + squad.width + 1);

    // Beside the rail the squad is too narrow for Form and Run. The eight core columns still show.
    const headers = squadPanel(page).getByRole("table", { name: "Squad table" });
    for (const name of ["Pos", "Player", "£m", "Next", "GW", "3GW", "5GW", "Start"]) {
      await expect(headers.getByRole("columnheader", { name, exact: true })).toBeVisible();
    }
    await expect(headers.getByRole("columnheader", { name: "Form", exact: true })).toBeHidden();
    await expect(headers.getByRole("columnheader", { name: "Run", exact: true })).toBeHidden();
  });
});
