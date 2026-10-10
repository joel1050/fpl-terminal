import { expect, type Page, test } from "@playwright/test";
import { bootstrapStaticFixture } from "../fixtures/fpl";
import { interceptFplData } from "../fixtures/network";

const IMPORT_MODE = /mode b/i;
const FAES = 17; // In the imported squad, so the table shows him too.

function market(page: Page) {
  return page.getByRole("region", { name: "Player universe" });
}

function columnHeader(page: Page, name: string) {
  return market(page).getByRole("columnheader", { name, exact: true });
}

/** A cell's number, or 0 for the dash that a zero or missing value shows. */
function numberOf(text: string): number {
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

/** Serves the shared bootstrap with one edited player. The copy keeps the imported fixture unchanged. */
async function serveBootstrap(page: Page, edit: (players: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) {
  const body = structuredClone(bootstrapStaticFixture) as unknown as { players: Array<Record<string, unknown>> };
  body.players = edit(body.players);
  await page.route("**/api/fpl/bootstrap*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

async function importTeam(page: Page) {
  await page.getByRole("button", { name: IMPORT_MODE }).click();
  await page.getByLabel(/enter fpl id/i).fill("4827193");
  await page.getByRole("button", { name: /import team/i }).click();
  await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
}

test.describe("players table", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("players-table-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("players-table-test", "ready");
      }
    });
    await interceptFplData(page);
  });

  test("at 1440 the default columns are Own, Form, GW xP, 3GW, 5GW, Start and Next 5, and xGI/90 is off", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await importTeam(page);

    for (const name of ["Own", "Form", "GW xP", "3GW", "5GW", "Start", "Next 5"]) {
      await expect(columnHeader(page, name), `${name} column`).toBeVisible();
    }
    await expect(columnHeader(page, "xGI/90")).toHaveCount(0);
  });

  test("ticking xGI/90 in Columns shows the column, and the choice survives a reload", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await importTeam(page);

    await market(page).getByRole("button", { name: "Columns" }).click();
    const menu = page.getByRole("dialog", { name: "Columns" });
    await menu.getByRole("checkbox", { name: "xGI/90" }).check();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(columnHeader(page, "xGI/90")).toBeVisible();

    await page.reload();
    await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
    await expect(columnHeader(page, "xGI/90")).toBeVisible();
  });

  test("clicking the 3GW header sorts that column descending", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await importTeam(page);

    await columnHeader(page, "3GW").getByRole("button").click();
    await expect(columnHeader(page, "3GW")).toHaveAttribute("aria-sort", "descending");
    const values = (await market(page).locator("tbody td[data-col='next3']").allTextContents()).map(numberOf);
    expect(values.length).toBeGreaterThan(2);
    const outOfOrder = values.flatMap((value, index) => (index > 0 && values[index - 1] < value ? [[index, values[index - 1], value]] : []));
    expect(outOfOrder, "each 3GW value is at most the one above it").toEqual([]);
  });

  test("squad members show In in place of Add, and their Add button stays disabled and named", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await importTeam(page);

    const squadRows = market(page).locator("tbody tr.in");
    expect(await squadRows.count(), "squad members are in the table").toBeGreaterThan(0);
    for (const row of await squadRows.all()) {
      const add = row.getByRole("button", { name: /^Add / });
      await expect(add).toHaveText("In");
      await expect(add).toBeDisabled();
    }

    const other = market(page).locator("tbody tr:not(.in)").first().getByRole("button", { name: /^Add / });
    await expect(other).toHaveText("+");
    await expect(other).toBeEnabled();
  });

  test("a start chance under 80% is marked warn, and one at 80% or more is not", async ({ page }) => {
    // Every fixture player starts 88% of the time, so one unavailable player (0%, AGENTS.md invariant 6) provides the value under 80%.
    await serveBootstrap(page, (players) => players.map((player) => (player.id === FAES ? { ...player, status: "i", chance_of_playing_next_round: 0 } : player)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await importTeam(page);

    // Ascending puts the lowest start chances first, so the rows under 80% are in view.
    await columnHeader(page, "Start").getByRole("button").click();
    await columnHeader(page, "Start").getByRole("button").click();
    const cells = await market(page).locator("tbody td[data-col='start']").evaluateAll((tds) =>
      tds.map((td) => ({ text: td.textContent ?? "", warn: td.classList.contains("warn") })),
    );
    const numeric = cells.flatMap((cell) => {
      const percent = Number.parseInt(cell.text, 10);
      return Number.isFinite(percent) ? [{ percent, warn: cell.warn }] : [];
    });
    expect(numeric.some((cell) => cell.percent < 80), "the table has a start chance under 80%").toBe(true);
    const mismatched = numeric.filter((cell) => cell.warn !== (cell.percent < 80));
    expect(mismatched, "warn marks exactly the start chances under 80%").toEqual([]);
  });

  test("at 1280x720 Own and Form show and the page does not scroll; below 1180px they hide", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await importTeam(page);

    await expect(columnHeader(page, "Own")).toBeVisible();
    await expect(columnHeader(page, "Form")).toBeVisible();
    const pageHeight = () => page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight }));
    const wide = await pageHeight();
    expect(wide.scrollHeight, "document height fits 1280x720").toBeLessThanOrEqual(wide.innerHeight + 1);

    await page.setViewportSize({ width: 1150, height: 720 });
    await expect(columnHeader(page, "Own")).toBeHidden();
    await expect(columnHeader(page, "Form")).toBeHidden();
    const narrow = await pageHeight();
    expect(narrow.scrollHeight, "document height fits 1150x720").toBeLessThanOrEqual(narrow.innerHeight + 1);
  });
});
