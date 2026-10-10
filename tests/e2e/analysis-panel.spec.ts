import { expect, type Locator, type Page, test } from "@playwright/test";
import { interceptFplData } from "../fixtures/network";

const SHOTS = ".superpowers/sdd/2026-10-06-pitch-ui-redesign/shots";

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.getByRole("button", { name: /mode b/i }).click();
  await page.getByLabel(/enter fpl id/i).fill("4827193");
  await page.getByRole("button", { name: /import team/i }).click();
  await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
}

const rail = (page: Page) => page.getByRole("complementary", { name: "Analysis" });
const widthOf = async (locator: Locator) => (await locator.boundingBox())?.width ?? 0;

test.describe("Analysis panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("analysis-panel-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("analysis-panel-test", "ready");
      }
    });
    await interceptFplData(page);
  });

  test("at 1440 the rail has an Analysis header", async ({ page }) => {
    await open(page, 1440, 900);
    await expect(rail(page).locator(".panel-title")).toHaveText("Analysis");
    await page.screenshot({ path: `${SHOTS}/7c-1440-normal.png` });
  });

  test("dragging the squad edge trades width between squad and rail, not the players panel", async ({ page }) => {
    await open(page, 1440, 900);
    const market = page.locator('section[data-panel="market"]');
    const squad = page.locator('section[data-panel="squad"]');
    const before = { market: await widthOf(market), squad: await widthOf(squad), rail: await widthOf(rail(page)) };
    const handle = await squad.getByRole("separator", { name: /resize/i }).boundingBox();
    expect(handle).not.toBeNull();
    const x = handle!.x + handle!.width / 2;
    const y = handle!.y + handle!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 80, y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => widthOf(rail(page))).toBeGreaterThan(before.rail + 50);
    expect(await widthOf(squad)).toBeLessThan(before.squad - 50);
    expect(Math.abs((await widthOf(market)) - before.market)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: `${SHOTS}/7c-1440-rail-wider.png` });
  });

  test("the Analysis minimize button collapses the rail and the squad takes the room", async ({ page }) => {
    await open(page, 1440, 900);
    const squad = page.locator('section[data-panel="squad"]');
    const railWidth = await widthOf(rail(page));
    const squadWidth = await widthOf(squad);
    await rail(page).getByRole("button", { name: /minimize analysis/i }).click();
    await expect.poll(async () => widthOf(rail(page))).toBeLessThan(80);
    expect(await widthOf(squad)).toBeGreaterThan(squadWidth + 100);
    await page.screenshot({ path: `${SHOTS}/7c-1440-rail-minimized.png` });
    await rail(page).getByRole("button", { name: /expand analysis/i }).click();
    await expect.poll(async () => Math.abs((await widthOf(rail(page))) - railWidth)).toBeLessThanOrEqual(2);
    expect(Math.abs((await widthOf(squad)) - squadWidth)).toBeLessThanOrEqual(2);
  });

  test("at 1280 there is no minimize button and the header sits above the captain section", async ({ page }) => {
    await open(page, 1280, 720);
    await expect(rail(page).getByRole("button", { name: /analysis/i })).toBeHidden();
    await expect(rail(page).locator(".panel-title")).toHaveText("Analysis");
    const header = await rail(page).locator(".panel-title").boundingBox();
    const captain = await rail(page).getByRole("heading", { name: /captain/i }).first().boundingBox();
    expect(header!.y).toBeLessThan(captain!.y);
    await rail(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/7c-1280.png` });
  });
});
