import { expect, type Locator, type Page, test } from "@playwright/test";
import { bootstrapStaticFixture } from "../fixtures/fpl";
import { interceptFplData } from "../fixtures/network";

const SHOTS = ".superpowers/sdd/2026-10-06-pitch-ui-redesign/shots";
const FAES = 17; // Imported bench player.

function squadPanel(page: Page) {
  return page.getByRole("region", { name: /squad builder and analysis/i });
}

function rail(page: Page) {
  return page.getByRole("complementary", { name: "Analysis" });
}

function token(page: Page, name: string) {
  return squadPanel(page).locator(`[data-testid="squad-token"][data-player="${name}"]`);
}

/** The player detail panel, which shares its name with the action sheet's dialog. */
function detail(page: Page, name: string) {
  return page.locator("dialog.detail-panel").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

function actionSheet(page: Page, name: string) {
  return page.getByRole("dialog", { name, exact: true }).and(page.locator(":not(.detail-panel)"));
}

async function open(page: Page, width: number, height: number, faesDoubtful = false) {
  if (faesDoubtful) {
    const body = structuredClone(bootstrapStaticFixture) as unknown as { players: Array<Record<string, unknown>> };
    body.players = body.players.map((player) => (player.id === FAES ? { ...player, status: "d", chance_of_playing_next_round: 50 } : player));
    await page.route("**/api/fpl/bootstrap*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
  }
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.getByRole("button", { name: /mode b/i }).click();
  await page.getByLabel(/enter fpl id/i).fill("4827193");
  await page.getByRole("button", { name: /import team/i }).click();
  await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
}

/** True when the element at the centre of `row` is the name link or inside it. */
async function centreHitsName(row: Locator) {
  return row.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return Boolean(hit?.closest(".player-name-link"));
  });
}

test.describe("player name links", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("name-links-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("name-links-test", "ready");
      }
    });
    await interceptFplData(page);
  });

  test("hovering a token name underlines it and a click opens the details, not the action sheet", async ({ page }) => {
    await open(page, 1440, 900);
    const name = token(page, "Haaland").getByTestId("player-name-link");
    await name.hover();
    await expect.poll(() => name.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain("underline");
    await page.screenshot({ path: `${SHOTS}/7d-pitch-name-hover.png` });
    await name.click();
    await expect(detail(page, "Haaland")).toBeVisible();
    await expect(actionSheet(page, "Haaland")).toHaveCount(0);
  });

  test("a click on the shirt still opens the action sheet", async ({ page }) => {
    await open(page, 1440, 900);
    await token(page, "Haaland").locator(".token-shirt").click();
    await expect(actionSheet(page, "Haaland")).toBeVisible();
    await expect(detail(page, "Haaland")).toHaveCount(0);
  });

  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    test(`the centre of a token, a captain row and a table row is off the name at ${width}`, async ({ page }) => {
      await open(page, width, height);
      for (const player of ["Haaland", "Rice", "Faes", "Pau", "Areola"]) {
        const t = token(page, player);
        await expect(t, `${player} at ${width}`).toBeVisible();
        expect(await centreHitsName(t), `${player} token centre at ${width}`).toBe(false);
      }
      const row = rail(page).locator(".captain-row").first();
      expect(await centreHitsName(row), `captain row at ${width}`).toBe(false);
      await squadPanel(page).getByRole("group", { name: "Squad view" }).getByRole("button", { name: "Table", exact: true }).click();
      const tableRow = squadPanel(page).locator("tr[data-player='Haaland'] .sq-row-button");
      expect(await centreHitsName(tableRow), `table row at ${width}`).toBe(false);
    });
  }

  test("a captain name and an alert name open that player's details", async ({ page }) => {
    await open(page, 1440, 900, true);
    const captainName = rail(page).locator(".captain-row").first().getByTestId("player-name-link");
    const captain = (await captainName.textContent())!;
    await captainName.hover();
    await page.screenshot({ path: `${SHOTS}/7d-rail-name-hover.png` });
    await captainName.click();
    await expect(detail(page, captain)).toBeVisible();
    await expect(actionSheet(page, captain)).toHaveCount(0);

    await rail(page).locator(".alert-row").filter({ hasText: /Faes doubtful/ }).getByTestId("player-name-link").click();
    await expect(detail(page, "Faes")).toBeVisible();
    await expect(actionSheet(page, "Faes")).toHaveCount(0);
  });

  test("a table name opens the details", async ({ page }) => {
    await open(page, 1440, 900);
    await squadPanel(page).getByRole("group", { name: "Squad view" }).getByRole("button", { name: "Table", exact: true }).click();
    await squadPanel(page).locator("tr[data-player='Rice']").getByTestId("player-name-link").click();
    await expect(detail(page, "Rice")).toBeVisible();
  });

  test("a click on a squad name expands a minimized players panel", async ({ page }) => {
    await open(page, 1440, 900);
    await page.getByRole("button", { name: "Minimize Player universe" }).click();
    await expect(page.getByRole("button", { name: "Expand Player universe" })).toBeVisible();
    await token(page, "Haaland").getByTestId("player-name-link").click();
    await expect(page.getByRole("button", { name: "Minimize Player universe" })).toBeVisible();
    await expect(detail(page, "Haaland")).toBeVisible();
  });

  test("with a swap pending, a click on a bench name does what the token does and opens no details", async ({ page }) => {
    await open(page, 1440, 900);
    await token(page, "Pau").locator(".token-shirt").click();
    await actionSheet(page, "Pau").getByRole("button", { name: "Select Pau to move to bench" }).click();
    await expect(page.getByText(/tap a bench player to swap with pau/i)).toBeVisible();
    await token(page, "Faes").getByText("Faes", { exact: true }).click();
    await expect(actionSheet(page, "Faes")).toBeVisible();
    await expect(page.locator("dialog.detail-panel")).toHaveCount(0);
  });

  test("on a phone the name is plain text and a tap opens the action sheet", async ({ page }) => {
    await open(page, 390, 844);
    await expect(squadPanel(page).getByTestId("player-name-link")).toHaveCount(0);
    await token(page, "Haaland").locator(".token-name").click();
    await expect(actionSheet(page, "Haaland")).toBeVisible();
    await expect(page.locator("dialog.detail-panel")).toHaveCount(0);
  });
});
