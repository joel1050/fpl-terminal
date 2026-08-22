import type { Page, Route } from "@playwright/test";
import { bootstrapStaticFixture, fixturesFixture } from "./fpl";

/**
 * Keep browser tests deterministic at the same boundary production uses.
 * This is intentionally a test-only interceptor; no fixture is imported by app code.
 */
export async function interceptFplData(page: Page) {
  await page.route("**/*", async (route: Route) => {
    const url = route.request().url();
    const pathname = new URL(url).pathname.toLowerCase();

    if (pathname.includes("bootstrap-static") || pathname.includes("/api/fpl/bootstrap")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bootstrapStaticFixture) });
      return;
    }

    if (pathname.includes("fixtures")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixturesFixture) });
      return;
    }

    if (pathname.includes("/api/optimizer") && route.request().method() === "POST") {
      const squad = {
        playerIds: [5, 16, 6, 9, 10, 17, 18, 2, 3, 12, 13, 22, 1, 14, 15],
        byPosition: { GK: [5, 16], DEF: [6, 9, 10, 17, 18], MID: [2, 3, 12, 13, 22], FWD: [1, 14, 15] },
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ legal: true, squad, playerIds: squad.playerIds, errors: [], warnings: [] }) });
      return;
    }

    if (pathname.includes("/api/transfer-suggestions") && route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          gameweek: 1,
          horizon: 5,
          suggestions: [{
            outgoingPlayerId: 17,
            incomingPlayerId: 20,
            horizon: 5,
            beforeXp: 250,
            afterXp: 248,
            projectedDelta: -2,
            projectedDeltaPerGW: -0.4,
            cashReleasedTenths: 6,
            score: -0.25,
            kind: "CASH_RELEASE",
            incomingRisk: 0.05,
            confidence: "HIGH",
            reason: "cash release: -2.0 xP over 5GW, releases £0.6m",
          }],
        }),
      });
      return;
    }

    if (/(?:ai|analyst|chat)/.test(pathname) && route.request().method() !== "GET") {
      // The acceptance test models a missing key without making a production API call.
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "DEEPSEEK_API_KEY is not configured" }) });
      return;
    }

    await route.continue();
  });
}
