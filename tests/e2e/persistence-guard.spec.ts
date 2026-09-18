import { expect, test } from "@playwright/test";
import { interceptFplData, interceptLeaguesData } from "../fixtures/network";

const squad = {
  playerIds: [4, 7, 9, 10, 21, 22, 11, 12, 13, 1, 14, 16, 17, 18, 15],
  byPosition: { GK: [4, 16], DEF: [7, 9, 10, 17, 18], MID: [21, 22, 11, 12, 13], FWD: [1, 14, 15] },
};

function newerSave() {
  return JSON.stringify({ version: 999, squad });
}

test.describe.configure({ mode: "serial" });

test("Planner refuses a newer save, preserves it, and accepts a valid import", async ({ page }) => {
  const original = newerSave();
  await page.addInitScript((raw) => window.localStorage.setItem("fpl-terminal-state", raw), original);
  await interceptFplData(page);
  await page.goto("/");

  await expect(page.getByRole("alert").filter({ hasText: /newer FPL Terminal build.*kept untouched/i })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("fpl-terminal-state"))).toBe(original);

  await page.getByRole("button", { name: /mode a/i }).click();
  await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: "compatible-export.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ version: 1, squad })),
  });

  await expect(page.getByRole("status")).toContainText(/saved terminal state imported/i);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("fpl-terminal-state"))).not.toBe(original);
  await expect.poll(() => page.evaluate(() => JSON.parse(window.localStorage.getItem("fpl-terminal-state") ?? "null").version)).toBe(1);
  await expect(page.getByText(/15\s*\/\s*15 selected/i).first()).toBeVisible();
});

test("Leagues refuses a newer save and preserves it through hydration", async ({ page }) => {
  const original = newerSave();
  await page.addInitScript((raw) => window.localStorage.setItem("fpl-terminal-state", raw), original);
  await interceptLeaguesData(page);
  await page.goto("/leagues");

  await expect(page.getByRole("alert").filter({ hasText: /newer FPL Terminal build.*kept untouched/i })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("fpl-terminal-state"))).toBe(original);
  await expect(page.getByLabel("FPL TEAM ID")).toBeVisible();
});
