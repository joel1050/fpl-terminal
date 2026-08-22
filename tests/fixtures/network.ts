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

    if (/(?:ai|analyst|chat)/.test(pathname) && route.request().method() !== "GET") {
      // The acceptance test models a missing key without making a production API call.
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "DEEPSEEK_API_KEY is not configured" }) });
      return;
    }

    await route.continue();
  });
}

