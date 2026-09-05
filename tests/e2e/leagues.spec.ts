import { expect, test, type Page } from "@playwright/test";
import { interceptLeaguesData } from "../fixtures/network";

/**
 * The import mode card, matched by its index rather than its wording. The
 * wording has changed once already ("ANALYZE A TEAM" -> "IMPORT A TEAM"), and
 * which mode a test picks is not what the test is about.
 */
const IMPORT_MODE = /mode b/i;

test.describe("FPL Terminal Leagues workspace", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem("fpl-leagues-test")) {
        window.localStorage.clear();
        window.sessionStorage.setItem("fpl-leagues-test", "ready");
      }
    });
    await interceptLeaguesData(page);
  });

  async function importTeam(page: Page) {
    await page.goto("/leagues");
    await expect(page.getByText("FPL TEAM REQUIRED")).toBeVisible();
    await page.getByLabel(/fpl team id/i).fill("4827193");
    await page.getByRole("button", { name: /^IMPORT$/i }).click();
    await expect(page.getByText("MY LEAGUES").first()).toBeVisible();
    await expect(page.getByTestId("live-roster")).toBeVisible();
  }

  test("imports an FPL team ID through the gate and unlocks the workspace", async ({ page }) => {
    await page.goto("/leagues");
    await expect(page.getByText("FPL TEAM REQUIRED")).toBeVisible();

    await page.getByLabel(/fpl team id/i).fill("4827193");
    await page.getByRole("button", { name: /^IMPORT$/i }).click();

    // Standings appear with the user's row highlighted amber.
    const standings = page.getByTestId("league-standings");
    await expect(standings.getByRole("row")).toHaveCount(5);
    const youRow = page.getByTestId("standings-you-row");
    await expect(youRow).toBeVisible();
    await expect(youRow).toContainText("Expected Toulouse");
    await expect(youRow).toContainText("▲ 1");

    // The league list is text only: no Premier League crests or icons.
    const leaguesPanel = page.getByRole("region", { name: "My leagues" });
    await expect(leaguesPanel.getByText("UBC FPL")).toBeVisible();
    await expect(leaguesPanel.locator("img")).toHaveCount(0);

    // Selecting another mini-league swaps the standings source.
    await leaguesPanel.getByRole("button", { name: "Office League" }).click();
    await expect(page.getByRole("region", { name: "League standings" })).toContainText("Office League");
    await expect(page.getByTestId("league-standings").getByRole("row")).toHaveCount(5);
  });

  test("opens the league you last looked at, not the first one", async ({ page }) => {
    await importTeam(page);
    const leaguesPanel = page.getByRole("region", { name: "My leagues" });
    const standings = page.getByRole("region", { name: "League standings" });
    // The first classic league opens by default.
    await expect(standings).toContainText("UBC FPL");

    await leaguesPanel.getByRole("button", { name: "Office League" }).click();
    await expect(standings).toContainText("Office League");

    await page.reload();
    await expect(page.getByRole("region", { name: "League standings" })).toContainText("Office League");
    await expect(page.locator('[data-league-key="classic-9003"]')).toHaveClass(/selected/);
  });

  test("opens a rival's live squad from standings and restores my squad", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await importTeam(page);

    const standings = page.getByRole("region", { name: "League standings" });
    const rivalTeam = standings.getByRole("button", { name: /Green Azure FC/i });
    const rivalRow = rivalTeam.locator("xpath=ancestor::tr");
    await expect(rivalTeam).toBeVisible();
    await expect(rivalTeam).toHaveAttribute("aria-pressed", "false");

    await rivalTeam.click();

    await expect(rivalTeam).toHaveAttribute("aria-pressed", "true");
    await expect(rivalRow).toHaveClass(/selected/);

    const summary = page.getByRole("region", { name: "Live Gameweek summary" });
    await expect(summary).toContainText("Green Azure FC");
    await expect(summary).toContainText("Mike Li");
    const livePoints = summary.locator(".live-metrics > div").filter({ hasText: "LIVE POINTS" });
    await expect(livePoints.locator("strong")).toHaveText("4");
    await expect(summary.locator(".live-metrics > div").filter({ hasText: "DONE" }).locator("strong")).toHaveText("1");
    await expect(summary.locator(".live-metrics > div").nth(4).locator("strong")).toHaveText("1");

    const roster = page.getByTestId("live-roster");
    await expect(roster.locator('[data-player="Andersen"]')).toHaveCount(1);
    await expect(roster.locator('[data-player="Watkins"]')).toHaveCount(1);
    await expect(roster.locator('[data-player="Saka"]')).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Live squad" })).toContainText("2/15");

    const myTeam = standings.getByRole("button", { name: /Expected Toulouse/i });
    await myTeam.click();
    await expect(myTeam).toHaveAttribute("aria-pressed", "true");
    await expect(rivalTeam).toHaveAttribute("aria-pressed", "false");
    await expect(summary).toContainText("Expected Toulouse");
    await expect(summary).toContainText("Joel Tester");
    await expect(roster.locator('[data-player="Saka"]')).toHaveCount(1);
    await expect(roster.locator('[data-player="Andersen"]')).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Live squad" })).toContainText("15/15");
  });

  test("keeps a rival identity visible when that manager's picks are unavailable", async ({ page }) => {
    await interceptLeaguesData(page, { missingMemberPicksEntryId: 333 });
    await importTeam(page);

    const standings = page.getByRole("region", { name: "League standings" });
    const unavailableTeam = standings.getByRole("button", { name: /Ctrl Alt De Laet/i });
    await expect(unavailableTeam).toBeVisible();
    await unavailableTeam.click();

    await expect(unavailableTeam).toHaveAttribute("aria-pressed", "true");
    const summary = page.getByRole("region", { name: "Live Gameweek summary" });
    await expect(summary).toContainText("Ctrl Alt De Laet");
    await expect(summary).toContainText("Sarah Kim");
    await expect(summary.locator(".live-metrics strong")).toHaveText(["—", "—", "—", "—", "—", "—", "—"]);

    const squadPanel = page.getByRole("region", { name: "Live squad" });
    await expect(squadPanel).toContainText("LIVE SQUAD UNAVAILABLE");
    await expect(squadPanel.getByTestId("live-roster")).toHaveCount(0);
    await expect(squadPanel).not.toContainText("Saka");
    await expect(squadPanel).not.toContainText("Andersen");
  });

  test("shows ten league rows and starts standings straight after them", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await importTeam(page);

    const leagues = page.getByRole("region", { name: "My leagues" });
    const standings = page.getByRole("region", { name: "League standings" });
    const list = leagues.locator(".league-list-wrap");

    // The list holds more leagues than it shows, and scrolls for the rest.
    expect(await list.locator("tbody tr").count()).toBeGreaterThan(10);
    const [listBox, rowCount] = await Promise.all([
      list.boundingBox(),
      list.evaluate((wrap) => {
        const bounds = wrap.getBoundingClientRect();
        return [...wrap.querySelectorAll("tbody tr")]
          .filter((row) => {
            const box = row.getBoundingClientRect();
            return box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
          }).length;
      }),
    ]);
    expect(rowCount).toBe(10);
    expect(await list.evaluate((wrap) => wrap.scrollHeight > wrap.clientHeight + 1)).toBe(true);

    // No leftover column space between the two panels.
    const leaguesBox = await leagues.boundingBox();
    const standingsBox = await standings.boundingBox();
    expect(listBox).not.toBeNull();
    expect(standingsBox!.y - (leaguesBox!.y + leaguesBox!.height)).toBeLessThanOrEqual(16);
  });

  test("says so when a live poll fails instead of showing old numbers as current", async ({ page }) => {
    await interceptLeaguesData(page, { failLiveAfterFirstPoll: true });
    await importTeam(page);

    // The first poll succeeded, so the page starts clean.
    await expect(page.locator(".live-notice")).toHaveCount(0);

    await page.getByTestId("live-refresh").click();

    const notice = page.locator(".live-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("LAST GOOD SNAPSHOT");
    await expect(page.locator(".topbar-stats")).toContainText("STALE");
    // The squad it already loaded stays on screen rather than blanking to zero.
    await expect(page.getByTestId("live-roster")).toBeVisible();
  });

  test("shows the latest available gameweek while the new live endpoint is empty", async ({ page }) => {
    await interceptLeaguesData(page, { emptyCurrentGameweek: true });
    await importTeam(page);

    await expect(page.locator(".topbar-stats")).toContainText("GW1");
    await expect(page.locator(".live-notice")).toHaveCount(0);
    await expect(page.getByTestId("live-roster")).toBeVisible();
  });

  test("renders a centered roster with opponent tags, xP versus P, and real captaincy markers only", async ({ page }) => {
    await importTeam(page);

    // Position groups stay centred like the Planner Starting XI (GK 1, DEF 4, MID 4, FWD 2).
    const centering = await page.getByTestId("live-roster").evaluate((roster) => {
      const rosterRect = roster.getBoundingClientRect();
      return [...roster.querySelectorAll<HTMLElement>(".starting-slot-grid")].map((grid) => {
        const rect = grid.getBoundingClientRect();
        return {
          columns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
          leftGap: Math.round(rect.left - rosterRect.left),
          rightGap: Math.round(rosterRect.right - rect.right),
        };
      });
    });
    expect(centering.map((group) => group.columns)).toEqual([1, 4, 4, 2]);
    for (const group of centering) {
      expect(Math.abs(group.leftGap - group.rightGap), "position groups must be horizontally centred").toBeLessThan(24);
    }

    // Every card carries an opponent tag; live and double-header states are labelled.
    const sakaCard = page.locator('[data-player="Saka"]');
    await expect(sakaCard.locator('[data-testid="live-opponent-tag"]').filter({ hasText: "TUN(H) · 74'" })).toHaveCount(1);
    await expect(sakaCard.locator('[data-testid="live-opponent-tag"]').filter({ hasText: /^TWA\(A\)/ })).toHaveCount(1);
    await expect(page.locator('[data-player="Mbeumo"]').locator('[data-testid="live-opponent-tag"]').filter({ hasText: "FT" })).toHaveCount(1);

    // Unplayed players show model xP; started or finished players show actual points.
    await expect(page.locator('[data-player="Rogers"] [data-testid="live-player-value"] small')).toHaveText("xP");
    await expect(page.locator('[data-player="Saka"] [data-testid="live-player-value"] small')).toHaveText("P");
    await expect(page.locator('[data-player="Mbeumo"] [data-testid="live-player-value"] small')).toHaveText("P");

    // Only the two real captaincy holders carry markers; there are no role buttons.
    await expect(page.getByTestId("live-roster").locator(".live-role.captain")).toHaveCount(1);
    await expect(page.locator('[data-player="Saka"] .live-role.captain')).toHaveText("C");
    await expect(page.getByTestId("live-roster").locator(".live-role.vice")).toHaveCount(1);
    await expect(page.locator('[data-player="Watkins"] .live-role.vice')).toHaveText("VC");
    await expect(page.getByTestId("live-roster").getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("live-roster").locator("table")).toHaveCount(0);
    await expect(page.getByTestId("live-roster")).not.toContainText("BGK");
  });

  test("keeps the Live Feed as the whole right rail without a status footer", async ({ page }) => {
    await importTeam(page);

    await expect(page.getByText(/DEADLINE PASSED|AUTO-SUBS ON/i)).toHaveCount(0);

    const feed = page.getByRole("complementary", { name: "Live feed" });
    const feedBox = await page.locator("aside.leagues-right").boundingBox();
    const centreBox = await page.locator("section.leagues-center-bottom").boundingBox();
    expect(feedBox).not.toBeNull();
    expect(centreBox).not.toBeNull();
    expect(feedBox!.x).toBeGreaterThan(centreBox!.x);
    expect(feedBox!.height).toBeGreaterThan(320);
    await expect(feed).toBeVisible();

    // A polling-style update turns into exactly one personalised feed event.
    await page.getByTestId("live-refresh").click();
    const goalEvent = page.locator('[data-testid="feed-event"]').filter({ hasText: "SAKA GOAL" });
    await expect(goalEvent.first()).toBeVisible();
    // The goal is worth five; the armband is what makes it ten to this manager.
    await expect(goalEvent.first().locator(".feed-delta")).toHaveText("+5");
    await expect(goalEvent.first()).toContainText("YOU +10 · CAPTAIN");
    await expect(goalEvent.first()).toContainText("LEAGUE IMPACT +6.3");
  });

  test("shows the Gameweek so far the moment the page opens", async ({ page }) => {
    await importTeam(page);
    const feed = page.getByRole("complementary", { name: "Live feed" });

    // No refresh: the opening snapshot is read back into events, so a goal
    // scored before anyone opened the page is still on the feed.
    const goal = feed.locator('[data-testid="feed-event"]').filter({ hasText: "Mbeumo GOAL" });
    await expect(goal.first()).toBeVisible();
    await expect(goal.first()).toContainText("YOU +5");
    // The row reports what the goal was worth, not everything the player has scored.
    await expect(goal.first().locator(".feed-delta")).toHaveText("+5");
    // FPL says a goal happened, never when, so a reconstructed row is marked as
    // belonging to the Gameweek rather than given a minute it cannot support.
    await expect(goal.first().locator(".feed-minute")).toHaveText("GW");
  });

  test("keeps appearance points out of the default view but not out of the feed", async ({ page }) => {
    await importTeam(page);
    const feed = page.getByRole("complementary", { name: "Live feed" });
    const appearances = feed.locator('[data-testid="feed-event"]').filter({ hasText: "APPEARANCE" });

    await expect(feed.getByRole("button", { name: "FOCUS", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(appearances).toHaveCount(0);

    await feed.getByRole("button", { name: "ALL", exact: true }).click();
    await expect(appearances.first()).toBeVisible();
  });

  test("colours a row by what it did to your own score, and nothing else", async ({ page }) => {
    await importTeam(page);
    const feed = page.getByRole("complementary", { name: "Live feed" });
    await page.getByTestId("live-refresh").click();
    await feed.getByRole("button", { name: "ALL", exact: true }).click();

    const rows = feed.locator('[data-testid="feed-event"]');
    // The captain's goal is worth double to this manager, so it reads as a gain.
    await expect(rows.filter({ hasText: "Saka GOAL" }).first()).toHaveClass(/gain/);
    // Haaland is in nobody's squad here: his points are real but not theirs.
    await expect(rows.filter({ hasText: "Haaland" }).first()).toHaveClass(/flat/);
    // Areola is owned but benched, so what he scores is worth nothing either.
    await expect(rows.filter({ hasText: "Areola" }).first()).toHaveClass(/flat/);
  });

  test("offers a way back to the top when events land out of sight", async ({ page }) => {
    await importTeam(page);
    const feed = page.getByRole("complementary", { name: "Live feed" });
    await feed.getByRole("button", { name: "ALL", exact: true }).click();
    await expect(feed.locator('[data-testid="feed-event"]').first()).toBeVisible();

    // Nothing is unread while the newest row is already on screen.
    await expect(page.getByTestId("feed-new-pill")).toHaveCount(0);

    await page.getByTestId("live-feed-scroll").evaluate((node) => { node.scrollTop = 400; });
    await page.getByTestId("live-refresh").click();

    const pill = page.getByTestId("feed-new-pill");
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(pill).toHaveCount(0);
    await expect(page.getByTestId("live-feed-scroll")).toHaveJSProperty("scrollTop", 0);
  });

  test("groups fixtures and opens a match for its scorers and BPS", async ({ page }) => {
    await importTeam(page);
    const matchCentre = page.getByRole("region", { name: "Match centre" });

    await matchCentre.getByRole("button", { name: "LIVE", exact: true }).click();
    const liveRow = matchCentre.getByTestId("match-row");
    await expect(liveRow).toHaveCount(1);
    await expect(liveRow).toContainText("TST");
    await expect(liveRow).toContainText("74'");

    // Every match starts collapsed, so the detail sections are out of the way
    // until the row is opened.
    await expect(liveRow.getByText("GOALS", { exact: true })).toHaveCount(0);
    await expect(liveRow).toContainText("YOU");

    await liveRow.locator("summary").click();
    await expect(liveRow.getByText("GOALS", { exact: true })).toBeVisible();
    await expect(liveRow.getByText("ASSISTS", { exact: true })).toBeVisible();
    await expect(liveRow.getByText("BONUS POINTS · PROVISIONAL")).toBeVisible();
    await expect(liveRow).toContainText("Haaland");

    await liveRow.locator("summary").click();
    await expect(liveRow.getByText("GOALS", { exact: true })).toHaveCount(0);

    await matchCentre.getByRole("button", { name: "FINISHED", exact: true }).click();
    const finishedRow = matchCentre.getByTestId("match-row");
    await expect(finishedRow).toHaveCount(1);
    await expect(finishedRow).toContainText("TRV");

    // A match FPL has settled shows its confirmed bonus, not a provisional read.
    await finishedRow.locator("summary").click();
    await expect(finishedRow.getByText("BONUS POINTS", { exact: true })).toBeVisible();
    await expect(finishedRow).toContainText("Mbeumo");
    await expect(finishedRow.locator(".match-bps li").first()).toContainText("+3");

    await matchCentre.getByRole("button", { name: "UPCOMING", exact: true }).click();
    await expect(matchCentre.getByTestId("match-row")).toHaveCount(1);
    await expect(matchCentre.getByTestId("match-row")).toContainText("TWA");

    await matchCentre.getByRole("button", { name: "ALL", exact: true }).click();
    await expect(matchCentre.getByTestId("match-row")).toHaveCount(3);
  });

  test("switches to a tabbed workspace at mobile widths", async ({ page }) => {
    await importTeam(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const tabs = page.locator(".leagues-mobile-tabs");
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole("button", { name: "FEED" })).toBeVisible();

    await tabs.getByRole("button", { name: "TEAM" }).click();
    await expect(page.getByTestId("live-roster")).toBeVisible();
    await expect(page.locator("aside.leagues-right")).not.toBeVisible();

    await tabs.getByRole("button", { name: "MATCHES" }).click();
    await expect(page.getByRole("region", { name: "Match centre" })).toBeVisible();

    await tabs.getByRole("button", { name: "FEED" }).click();
    await expect(page.getByRole("complementary", { name: "Live feed" })).toBeVisible();

    await tabs.getByRole("button", { name: "LEAGUE" }).click();
    await expect(page.getByText("MY LEAGUES").first()).toBeVisible();
  });

  test("opens a selected rival squad in the TEAM tab on mobile", async ({ page }) => {
    await importTeam(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const tabs = page.locator(".leagues-mobile-tabs");
    await expect(tabs.getByRole("button", { name: "LEAGUE" })).toHaveClass(/active/);
    const standings = page.getByRole("region", { name: "League standings" });
    const rivalTeam = standings.getByRole("button", { name: /Green Azure FC/i });
    await rivalTeam.click();

    await expect(tabs.getByRole("button", { name: "TEAM" })).toHaveClass(/active/);
    await expect(page.getByRole("region", { name: "Live Gameweek summary" })).toContainText("Green Azure FC");
    await expect(page.getByRole("region", { name: "Live Gameweek summary" })).toContainText("Mike Li");
    const roster = page.getByTestId("live-roster");
    await expect(roster).toBeVisible();
    await expect(roster.locator('[data-player="Andersen"]')).toHaveCount(1);
    await expect(roster.locator('[data-player="Watkins"]')).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Leagues and standings" })).not.toBeVisible();
  });

  test("navigates between Planner and Leagues workspaces", async ({ page }) => {
    await importTeam(page);

    await page.goto("/");
    await page.getByRole("button", { name: IMPORT_MODE }).click();

    const switcher = page.locator(".workspace-switcher");
    await expect(switcher).toBeVisible();
    await expect(switcher.getByRole("link", { name: "LEAGUES" })).toHaveAttribute("href", "/leagues");

    await switcher.getByRole("link", { name: "LEAGUES" }).click();
    await expect(page).toHaveURL(/\/leagues$/);
    await expect(page.getByText("MY LEAGUES").first()).toBeVisible();
    await expect(page.getByTestId("live-roster")).toBeVisible();

    await switcher.getByRole("link", { name: "PLANNER" }).click();
    await expect(page.getByPlaceholder(/search player, club/i)).toBeVisible();
  });
});
